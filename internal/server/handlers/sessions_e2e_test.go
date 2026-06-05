package handlers

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
	"github.com/c3-oss/prosa/internal/server/auth"
	"github.com/c3-oss/prosa/internal/server/storage"
	serverMigrations "github.com/c3-oss/prosa/migrations/server"
	"github.com/c3-oss/prosa/pkg/session"
)

func TestSessionsConnectEndToEnd(t *testing.T) {
	ctx := context.Background()
	pool := newHandlersPostgresPool(t, ctx)
	obj := newTestObjectStore(t)

	const (
		adminToken = "admin-token"
		bearer     = "device-bearer"
		deviceID   = "device-a"
		sessionID  = "session-a"
		rawHash    = "hash-a"
	)
	insertDeviceToken(t, ctx, pool, deviceID, bearer)

	mux := http.NewServeMux()
	authSvc := auth.New(pool, adminToken, "http://panel.test")
	path, handler := prosav1connect.NewSessionsServiceHandler(
		NewSessionsHandler(pool, obj),
		connect.WithInterceptors(auth.Interceptor(authSvc)),
	)
	mux.Handle(path, handler)

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	client := prosav1connect.NewSessionsServiceClient(server.Client(), server.URL)
	_, err := client.Manifest(ctx, connect.NewRequest(&prosav1.ManifestRequest{}))
	require.Error(t, err)
	require.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(err))

	started := time.Date(2026, 5, 30, 12, 0, 0, 0, time.UTC)
	raw := []byte("raw transcript body")
	pushReq := connect.NewRequest(&prosav1.PushRequest{
		Session: &prosav1.Session{
			Id:             sessionID,
			Agent:          "codex",
			DeviceId:       "spoofed-device",
			ProjectPath:    "/work/prosa",
			StartedAt:      timestamppb.New(started),
			LastActivityAt: timestamppb.New(started.Add(5 * time.Minute)),
			FirstPrompt:    "explain quantum entanglement",
			Model:          "gpt-5-codex",
			RawHash:        rawHash,
			RawSize:        int64(len(raw)),
			Usage: &prosav1.TokenUsage{
				TotalTokens:  120,
				InputTokens:  100,
				OutputTokens: 20,
			},
		},
		Turns: []*prosav1.Turn{
			{
				Role:    "user",
				Kind:    session.KindMessage,
				Content: "explain quantum entanglement",
				Ts:      timestamppb.New(started),
			},
			{
				Role:    "assistant",
				Kind:    session.KindMessage,
				Content: "particles share state across distance",
				Ts:      timestamppb.New(started.Add(time.Minute)),
			},
		},
		Tools: []*prosav1.ToolUsage{{Name: "shell", Count: 2}},
		Raw:   raw,
	})
	pushReq.Header().Set("Authorization", "Bearer "+bearer)

	pushResp, err := client.Push(ctx, pushReq)
	require.NoError(t, err)
	require.False(t, pushResp.Msg.Skipped)
	require.True(t, strings.HasPrefix(pushResp.Msg.RawUri, "s3://prosa-test/"), pushResp.Msg.RawUri)

	retryReq := connect.NewRequest(pushReq.Msg)
	retryReq.Header().Set("Authorization", "Bearer "+bearer)
	retryResp, err := client.Push(ctx, retryReq)
	require.NoError(t, err)
	require.True(t, retryResp.Msg.Skipped)

	manifestReq := connect.NewRequest(&prosav1.ManifestRequest{Limit: 1})
	manifestReq.Header().Set("Authorization", "Bearer "+bearer)
	manifestResp, err := client.Manifest(ctx, manifestReq)
	require.NoError(t, err)
	require.Len(t, manifestResp.Msg.Entries, 1)
	require.Equal(t, sessionID, manifestResp.Msg.Entries[0].Id)
	require.Equal(t, rawHash, manifestResp.Msg.Entries[0].RawHash)
	require.Equal(t, int32(session.ProjectionVersion), manifestResp.Msg.Entries[0].ProjectionVersion)

	getReq := connect.NewRequest(&prosav1.GetRequest{Id: sessionID})
	getReq.Header().Set("Authorization", "Bearer "+bearer)
	getResp, err := client.Get(ctx, getReq)
	require.NoError(t, err)
	require.Equal(t, deviceID, getResp.Msg.Session.DeviceId)
	require.Equal(t, "codex", getResp.Msg.Session.Agent)
	require.Equal(t, "explain quantum entanglement", getResp.Msg.Session.FirstPrompt)
	require.Len(t, getResp.Msg.Turns, 2)
	require.Len(t, getResp.Msg.Tools, 1)
	require.Equal(t, "shell", getResp.Msg.Tools[0].Name)

	listReq := connect.NewRequest(&prosav1.ListRequest{
		Since: timestamppb.New(started.Add(-time.Hour)),
		Until: timestamppb.New(started.Add(time.Hour)),
		Limit: 10,
	})
	listReq.Header().Set("Authorization", "Bearer "+bearer)
	listResp, err := client.List(ctx, listReq)
	require.NoError(t, err)
	require.Equal(t, int64(1), listResp.Msg.TotalCount)
	require.Len(t, listResp.Msg.Sessions, 1)
	require.Equal(t, sessionID, listResp.Msg.Sessions[0].Id)

	searchReq := connect.NewRequest(&prosav1.SearchRequest{
		Query: "quantum",
		Since: timestamppb.New(started.Add(-time.Hour)),
		Until: timestamppb.New(started.Add(time.Hour)),
		Limit: 5,
	})
	searchReq.Header().Set("Authorization", "Bearer "+bearer)
	searchResp, err := client.Search(ctx, searchReq)
	require.NoError(t, err)
	require.Len(t, searchResp.Msg.Hits, 1)
	require.Equal(t, sessionID, searchResp.Msg.Hits[0].Session.Id)
	require.Contains(t, searchResp.Msg.Hits[0].Snippet, "quantum")

	rawReq := connect.NewRequest(&prosav1.GetRawRequest{Id: sessionID, Offset: 4, Limit: 10})
	rawReq.Header().Set("Authorization", "Bearer "+bearer)
	rawResp, err := client.GetRaw(ctx, rawReq)
	require.NoError(t, err)
	require.Equal(t, int64(len(raw)), rawResp.Msg.TotalSize)
	require.Equal(t, []byte("transcript"), rawResp.Msg.Chunk)
	require.False(t, rawResp.Msg.Eof)
}

func newHandlersPostgresPool(t *testing.T, ctx context.Context) *pgxpool.Pool {
	t.Helper()
	dbURL := os.Getenv("PROSA_TEST_PG_URL")
	if dbURL == "" {
		t.Skip("set PROSA_TEST_PG_URL to run server handler integration tests")
	}

	adminPool, err := pgxpool.New(ctx, dbURL)
	require.NoError(t, err)
	t.Cleanup(adminPool.Close)

	schema := "handlers_test_" + randomHandlersHex(t, 8)
	_, err = adminPool.Exec(ctx, `CREATE SCHEMA `+pgx.Identifier{schema}.Sanitize())
	require.NoError(t, err)
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), `DROP SCHEMA IF EXISTS `+pgx.Identifier{schema}.Sanitize()+` CASCADE`)
	})

	cfg, err := pgxpool.ParseConfig(dbURL)
	require.NoError(t, err)
	if cfg.ConnConfig.RuntimeParams == nil {
		cfg.ConnConfig.RuntimeParams = map[string]string{}
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)
	t.Cleanup(pool.Close)

	applyHandlersServerMigrations(t, ctx, pool)
	return pool
}

func applyHandlersServerMigrations(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	entries, err := fs.ReadDir(serverMigrations.FS, ".")
	require.NoError(t, err)

	var ups []string
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasSuffix(name, ".up.sql") {
			ups = append(ups, name)
		}
	}
	sort.Strings(ups)

	for _, name := range ups {
		body, err := fs.ReadFile(serverMigrations.FS, name)
		require.NoError(t, err)
		_, err = pool.Exec(ctx, string(body))
		require.NoErrorf(t, err, "apply %s", name)

		version, err := handlersMigrationVersion(name)
		require.NoError(t, err)
		_, err = pool.Exec(
			ctx,
			`INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING`,
			version,
		)
		require.NoErrorf(t, err, "record %s", name)
	}
}

func handlersMigrationVersion(name string) (int, error) {
	underscore := strings.Index(name, "_")
	if underscore <= 0 {
		return 0, strconv.ErrSyntax
	}
	return strconv.Atoi(name[:underscore])
}

func insertDeviceToken(t *testing.T, ctx context.Context, pool *pgxpool.Pool, deviceID, bearer string) {
	t.Helper()
	_, err := pool.Exec(ctx, `
		INSERT INTO devices(id, hostname, machine_id, friendly_name, fingerprinted_at)
		VALUES ($1, $2, $3, $4, $5)
	`, deviceID, "test-host", "test-machine", "Test Device", time.Now().UTC())
	require.NoError(t, err)

	_, err = pool.Exec(ctx, `
		INSERT INTO device_tokens(token_hash, device_id)
		VALUES ($1, $2)
	`, auth.HashBearer(bearer), deviceID)
	require.NoError(t, err)
}

func newTestObjectStore(t *testing.T) *storage.ObjectStore {
	t.Helper()
	fake := newFakeS3()
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)

	u, err := url.Parse(server.URL)
	require.NoError(t, err)
	client, err := minio.New(u.Host, &minio.Options{
		Creds:  credentials.NewStaticV4("access-key", "secret-key", ""),
		Secure: false,
		Region: "us-east-1",
	})
	require.NoError(t, err)

	return &storage.ObjectStore{
		Client: client,
		Bucket: "prosa-test",
		Region: "us-east-1",
	}
}

type fakeS3 struct {
	mu      sync.Mutex
	objects map[string][]byte
}

func newFakeS3() *fakeS3 {
	return &fakeS3{objects: map[string][]byte{}}
}

func (s *fakeS3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	bucket, key, ok := splitS3Path(r.URL.Path)
	if !ok || bucket != "prosa-test" {
		http.NotFound(w, r)
		return
	}

	switch r.Method {
	case http.MethodPut:
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if r.Header.Get("X-Amz-Decoded-Content-Length") != "" {
			body, err = decodeAWSChunked(body)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
		}
		s.mu.Lock()
		s.objects[key] = body
		s.mu.Unlock()
		w.Header().Set("ETag", `"test-etag"`)
		w.WriteHeader(http.StatusOK)
	case http.MethodHead:
		body, found := s.object(key)
		if !found {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		w.Header().Set("ETag", `"test-etag"`)
		w.Header().Set("Last-Modified", time.Now().UTC().Format(http.TimeFormat))
		w.WriteHeader(http.StatusOK)
	case http.MethodGet:
		body, found := s.object(key)
		if !found {
			http.NotFound(w, r)
			return
		}
		chunk, status, contentRange, err := rangeBody(body, r.Header.Get("Range"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusRequestedRangeNotSatisfiable)
			return
		}
		if contentRange != "" {
			w.Header().Set("Content-Range", contentRange)
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(chunk)))
		w.Header().Set("Last-Modified", time.Now().UTC().Format(http.TimeFormat))
		w.WriteHeader(status)
		_, _ = w.Write(chunk)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *fakeS3) object(key string) ([]byte, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	body, found := s.objects[key]
	return append([]byte(nil), body...), found
}

func splitS3Path(p string) (bucket, key string, ok bool) {
	parts := strings.SplitN(strings.TrimPrefix(p, "/"), "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func rangeBody(body []byte, header string) ([]byte, int, string, error) {
	if header == "" {
		return body, http.StatusOK, "", nil
	}
	if !strings.HasPrefix(header, "bytes=") {
		return nil, 0, "", fmt.Errorf("unsupported range %q", header)
	}
	bounds := strings.SplitN(strings.TrimPrefix(header, "bytes="), "-", 2)
	if len(bounds) != 2 {
		return nil, 0, "", fmt.Errorf("malformed range %q", header)
	}
	start, err := strconv.ParseInt(bounds[0], 10, 64)
	if err != nil {
		return nil, 0, "", err
	}
	end, err := strconv.ParseInt(bounds[1], 10, 64)
	if err != nil {
		return nil, 0, "", err
	}
	if start < 0 || end < start || start >= int64(len(body)) {
		return nil, 0, "", fmt.Errorf("unsatisfiable range %q", header)
	}
	if end >= int64(len(body)) {
		end = int64(len(body)) - 1
	}
	chunk := body[start : end+1]
	return chunk, http.StatusPartialContent,
		fmt.Sprintf("bytes %d-%d/%d", start, end, len(body)), nil
}

func decodeAWSChunked(body []byte) ([]byte, error) {
	reader := bufio.NewReader(bytes.NewReader(body))
	var out bytes.Buffer
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimSpace(line)
		sizeText := strings.SplitN(line, ";", 2)[0]
		size, err := strconv.ParseInt(sizeText, 16, 64)
		if err != nil {
			return nil, err
		}
		if size == 0 {
			return out.Bytes(), nil
		}
		if _, err := io.CopyN(&out, reader, size); err != nil {
			return nil, err
		}
		if _, err := reader.ReadString('\n'); err != nil {
			return nil, err
		}
	}
}

func randomHandlersHex(t *testing.T, n int) string {
	t.Helper()
	b := make([]byte, n)
	_, err := rand.Read(b)
	require.NoError(t, err)
	return hex.EncodeToString(b)
}
