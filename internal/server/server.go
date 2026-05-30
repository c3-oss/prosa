package server

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
	"github.com/c3-oss/prosa/internal/server/auth"
	"github.com/c3-oss/prosa/internal/server/handlers"
	"github.com/c3-oss/prosa/internal/server/storage"
)

// Server bundles the wiring between Connect handlers and their
// dependencies (Postgres pool + S3 store). Build via New; serve via
// Serve(ctx).
type Server struct {
	cfg  Config
	pool *pgxpool.Pool
	obj  *storage.ObjectStore
	mux  *http.ServeMux
}

// New opens all backing stores and registers every Connect handler.
// Returns the assembled Server ready to Serve.
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
	authSvc := auth.New(pool, cfg.AdminToken, cfg.VerificationURI)
	interceptors := connect.WithInterceptors(auth.Interceptor(authSvc))

	s.registerHealth()
	s.registerAuth(authSvc, interceptors)
	s.registerSessions(interceptors)
	s.registerDevices(interceptors)
	s.registerAnalytics(interceptors)
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
	srv := &http.Server{
		Addr:    s.cfg.ListenAddr,
		Handler: h2c.NewHandler(s.mux, &http2.Server{}),
	}
	errCh := make(chan error, 1)
	go func() {
		slog.Info("listening", "addr", s.cfg.ListenAddr)
		errCh <- srv.ListenAndServe()
	}()
	select {
	case <-ctx.Done():
		slog.Info("shutdown signal received")
		shutdownCtx, cancel := context.WithCancel(context.Background())
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	case err := <-errCh:
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	}
}

func (s *Server) registerHealth() {
	path, handler := prosav1connect.NewHealthServiceHandler(healthHandler{})
	s.mux.Handle(path, handler)
}

func (s *Server) registerAuth(svc *auth.Service, opts connect.HandlerOption) {
	path, handler := prosav1connect.NewAuthServiceHandler(handlers.NewAuthHandler(svc), opts)
	s.mux.Handle(path, handler)
}

func (s *Server) registerSessions(opts connect.HandlerOption) {
	h := handlers.NewSessionsHandler(s.pool, s.obj)
	path, handler := prosav1connect.NewSessionsServiceHandler(h, opts)
	s.mux.Handle(path, handler)
}

func (s *Server) registerDevices(opts connect.HandlerOption) {
	h := handlers.NewDevicesHandler(s.pool)
	path, handler := prosav1connect.NewDevicesServiceHandler(h, opts)
	s.mux.Handle(path, handler)
}

func (s *Server) registerAnalytics(opts connect.HandlerOption) {
	h := handlers.NewAnalyticsHandler(s.pool)
	path, handler := prosav1connect.NewAnalyticsServiceHandler(h, opts)
	s.mux.Handle(path, handler)
}

// healthHandler is the trivial Health.Check implementation — returns
// SERVING when the process is up. The Postgres / S3 connections are
// validated at boot; a per-call deep-check is overkill for the MVP.
type healthHandler struct{}

func (healthHandler) Check(_ context.Context, _ *connect.Request[prosav1.CheckRequest]) (*connect.Response[prosav1.CheckResponse], error) {
	return connect.NewResponse(&prosav1.CheckResponse{
		Status: prosav1.CheckResponse_STATUS_SERVING,
	}), nil
}
