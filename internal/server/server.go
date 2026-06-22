package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5/pgxpool"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
	"github.com/c3-oss/prosa/internal/httpserver"
	"github.com/c3-oss/prosa/internal/server/auth"
	"github.com/c3-oss/prosa/internal/server/handlers"
	"github.com/c3-oss/prosa/internal/server/storage"
)

// maxRequestBytes bounds the decoded size of any Connect request. 64 MiB
// is generous for the largest realistic transcript while preventing a
// multi-GB PushRequest from exhausting server memory and S3.
const maxRequestBytes = 64 * 1024 * 1024

// Server bundles Connect handlers with their Postgres and S3 dependencies.
type Server struct {
	cfg  Config
	pool *pgxpool.Pool
	obj  *storage.ObjectStore
	mux  *http.ServeMux
}

// New opens all backing stores and registers every Connect handler.
func New(ctx context.Context, cfg Config) (*Server, error) {
	pool, err := storage.OpenPG(ctx, cfg.DBURL)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}
	obj, err := storage.OpenS3(
		ctx,
		cfg.S3Endpoint, cfg.S3AccessKey, cfg.S3SecretKey,
		cfg.S3Bucket, cfg.S3Region, cfg.S3UseSSL,
	)
	if err != nil {
		pool.Close()
		return nil, fmt.Errorf("open s3: %w", err)
	}

	s := &Server{cfg: cfg, pool: pool, obj: obj, mux: http.NewServeMux()}
	authSvc := auth.New(pool, cfg.AdminToken, cfg.PanelBaseURL)

	// recover converts a panic in any handler into a connect.CodeInternal
	// error logged through slog, instead of letting the default net/http
	// panic handler close the connection and dump to stdout — the caller
	// sees a structured Internal error, not an EOF.
	recover := connect.WithRecover(recoverHandler)
	readMax := connect.WithReadMaxBytes(maxRequestBytes)
	base := []connect.HandlerOption{recover, readMax}
	authed := append(append([]connect.HandlerOption{}, base...), connect.WithInterceptors(auth.Interceptor(authSvc)))

	s.registerHealth(base...)
	s.registerAuth(authSvc, authed...)
	s.registerAppTokens(authSvc, authed...)
	s.registerSessions(authed...)
	s.registerDevices(authed...)
	s.registerAnalytics(authed...)
	s.registerPreferences(authed...)
	s.mux.Handle("/sse/events", handlers.NewSSEHandler(s.pool, cfg.AdminToken))
	return s, nil
}

// Close releases backing resources. Idempotent.
func (s *Server) Close() {
	if s.pool != nil {
		s.pool.Close()
	}
}

// Serve binds the listener and serves Connect over h2c so dev / curl
// clients work without TLS. The painel / production deploy will sit
// behind a TLS-terminating proxy. Blocks until ctx is cancelled.
func (s *Server) Serve(ctx context.Context) error {
	protocols := new(http.Protocols)
	protocols.SetHTTP1(true)
	protocols.SetUnencryptedHTTP2(true)

	srv := &http.Server{
		Addr:      s.cfg.ListenAddr,
		Handler:   s.mux,
		Protocols: protocols,
		// ReadHeaderTimeout blocks slowloris-style slow-header attacks if
		// the h2c port is reachable directly (dev/local). No ReadTimeout or
		// WriteTimeout: Push bodies can be large and /sse/events is a
		// long-lived stream — bounding either would break legitimate use.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
	slog.Info("listening", "addr", s.cfg.ListenAddr)
	return httpserver.Run(ctx, srv, 5*time.Second)
}

func (s *Server) registerHealth(opts ...connect.HandlerOption) {
	path, handler := prosav1connect.NewHealthServiceHandler(healthHandler{}, opts...)
	s.mux.Handle(path, handler)
}

func (s *Server) registerAuth(svc *auth.Service, opts ...connect.HandlerOption) {
	path, handler := prosav1connect.NewAuthServiceHandler(handlers.NewAuthHandler(svc), opts...)
	s.mux.Handle(path, handler)
}

func (s *Server) registerAppTokens(svc *auth.Service, opts ...connect.HandlerOption) {
	path, handler := prosav1connect.NewAppTokensServiceHandler(handlers.NewAppTokensHandler(svc), opts...)
	s.mux.Handle(path, handler)
}

func (s *Server) registerSessions(opts ...connect.HandlerOption) {
	h := handlers.NewSessionsHandler(s.pool, s.obj)
	path, handler := prosav1connect.NewSessionsServiceHandler(h, opts...)
	s.mux.Handle(path, handler)
}

func (s *Server) registerDevices(opts ...connect.HandlerOption) {
	h := handlers.NewDevicesHandler(s.pool)
	path, handler := prosav1connect.NewDevicesServiceHandler(h, opts...)
	s.mux.Handle(path, handler)
}

func (s *Server) registerAnalytics(opts ...connect.HandlerOption) {
	h := handlers.NewAnalyticsHandler(s.pool)
	path, handler := prosav1connect.NewAnalyticsServiceHandler(h, opts...)
	s.mux.Handle(path, handler)
}

func (s *Server) registerPreferences(opts ...connect.HandlerOption) {
	h := handlers.NewPreferencesHandler(s.pool)
	path, handler := prosav1connect.NewPreferencesServiceHandler(h, opts...)
	s.mux.Handle(path, handler)
}

// recoverHandler is the connect.WithRecover callback; panic value never leaks to the caller.
func recoverHandler(ctx context.Context, spec connect.Spec, _ http.Header, r any) error {
	slog.ErrorContext(
		ctx, "connect handler panic recovered",
		"procedure", spec.Procedure,
		"panic", fmt.Sprintf("%v", r),
		"stack", string(debug.Stack()),
	)
	return connect.NewError(connect.CodeInternal, errors.New("internal error"))
}

// healthHandler returns SERVING unconditionally; backing stores are validated
// at boot so a per-call deep-check is intentionally omitted.
type healthHandler struct{}

func (healthHandler) Check(_ context.Context, _ *connect.Request[prosav1.CheckRequest]) (*connect.Response[prosav1.CheckResponse], error) {
	return connect.NewResponse(&prosav1.CheckResponse{
		Status: prosav1.CheckResponse_STATUS_SERVING,
	}), nil
}
