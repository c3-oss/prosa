package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io/fs"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	serverMigrations "github.com/c3-oss/prosa/migrations/server"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
)

func TestValidateLoopbackRedirect(t *testing.T) {
	t.Parallel()
	require.NoError(t, validateLoopbackRedirect("http://127.0.0.1:54321/callback"))
	require.NoError(t, validateLoopbackRedirect("http://localhost:8080/callback"))
	require.Error(t, validateLoopbackRedirect("https://127.0.0.1:1/callback"))
	require.Error(t, validateLoopbackRedirect("http://evil.example/callback"))
	require.Error(t, validateLoopbackRedirect("http://127.0.0.1:1/other"))
}

func TestVerifyPKCE(t *testing.T) {
	t.Parallel()
	verifier := "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	h := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(h[:])
	require.True(t, verifyPKCE(verifier, challenge))
	require.False(t, verifyPKCE(verifier, "wrong"))
}

func TestHashBearerDeterministic(t *testing.T) {
	t.Parallel()
	a := HashBearer("abc")
	b := HashBearer("abc")
	require.Equal(t, a, b)
	require.NotEqual(t, a, HashBearer("def"))
}

func TestBeginRejectsNonLoopback(t *testing.T) {
	t.Parallel()
	svc := &Service{PanelBaseURL: "http://panel.test", ExpiresIn: defaultExpiresIn}
	_, err := svc.Begin(context.Background(), "host", "fp", "ch", "http://example.com/callback", "state")
	require.Error(t, err)
}

func TestLoginLifecycleWithPostgres(t *testing.T) {
	svc, ctx := newPostgresService(t)
	verifier, challenge := testPKCEPair()
	redirect := "http://127.0.0.1:48123/callback"
	clientState := "client-state"
	fingerprint := "fp-" + randomHex(t, 6)

	begin, err := svc.Begin(ctx, "host-a", fingerprint, challenge, redirect, clientState)
	require.NoError(t, err)
	require.Contains(t, begin.AuthorizeURL, "request_id="+begin.RequestID)

	req, err := svc.GetRequest(ctx, begin.RequestID)
	require.NoError(t, err)
	require.Equal(t, "host-a", req.Hostname)
	require.Equal(t, fingerprint, req.Fingerprint)
	require.Equal(t, StatePending, req.State)

	approved, err := svc.Approve(ctx, begin.RequestID)
	require.NoError(t, err)
	require.Equal(t, redirect, approved.RedirectURI)
	require.Equal(t, clientState, approved.ClientState)
	require.NotEmpty(t, approved.Code)

	exchanged, err := svc.Exchange(ctx, approved.Code, verifier, redirect)
	require.NoError(t, err)
	require.NotEmpty(t, exchanged.Token)
	require.Equal(t, fingerprint, exchanged.DeviceID)

	deviceID, err := svc.DeviceFromBearer(ctx, exchanged.Token)
	require.NoError(t, err)
	require.Equal(t, fingerprint, deviceID)

	_, err = svc.Exchange(ctx, approved.Code, verifier, redirect)
	require.Error(t, err)
	require.ErrorContains(t, err, "state USED")
}

func TestExchangeRejectsInvalidInputsWithoutConsumingCode(t *testing.T) {
	svc, ctx := newPostgresService(t)
	verifier, challenge := testPKCEPair()
	redirect := "http://127.0.0.1:48124/callback"
	begin, err := svc.Begin(ctx, "host-b", "fp-"+randomHex(t, 6), challenge, redirect, "state-b")
	require.NoError(t, err)
	approved, err := svc.Approve(ctx, begin.RequestID)
	require.NoError(t, err)

	_, err = svc.Exchange(ctx, approved.Code, "wrong-verifier", redirect)
	require.Error(t, err)
	require.ErrorContains(t, err, "pkce verification failed")

	_, err = svc.Exchange(ctx, approved.Code, verifier, "http://127.0.0.1:48125/callback")
	require.Error(t, err)
	require.ErrorContains(t, err, "redirect_uri mismatch")

	exchanged, err := svc.Exchange(ctx, approved.Code, verifier, redirect)
	require.NoError(t, err)
	require.NotEmpty(t, exchanged.Token)
}

func TestExchangeExpiresApprovedCode(t *testing.T) {
	svc, ctx := newPostgresService(t)
	verifier, challenge := testPKCEPair()
	redirect := "http://127.0.0.1:48126/callback"
	code := "code-" + randomHex(t, 8)
	_, err := svc.Pool.Exec(ctx, `
		INSERT INTO auth_codes(
			request_id, code, code_challenge, code_challenge_method,
			redirect_uri, client_state, hostname, fingerprint, state,
			expires_at, approved_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
	`, "req-"+randomHex(t, 8), code, challenge, challengeMethod,
		redirect, "state-c", "host-c", "fp-"+randomHex(t, 6),
		StateApproved, time.Now().UTC().Add(-time.Minute), time.Now().UTC().Add(-2*time.Minute))
	require.NoError(t, err)

	_, err = svc.Exchange(ctx, code, verifier, redirect)
	require.Error(t, err)
	require.ErrorContains(t, err, "code expired")

	var state string
	err = svc.Pool.QueryRow(ctx, `SELECT state FROM auth_codes WHERE code = $1`, code).Scan(&state)
	require.NoError(t, err)
	require.Equal(t, StateExpired, state)
}

func TestExchangeCodeSingleUseUnderConcurrency(t *testing.T) {
	svc, ctx := newPostgresService(t)
	verifier, challenge := testPKCEPair()
	redirect := "http://127.0.0.1:48127/callback"
	fingerprint := "fp-" + randomHex(t, 6)
	begin, err := svc.Begin(ctx, "host-d", fingerprint, challenge, redirect, "state-d")
	require.NoError(t, err)
	approved, err := svc.Approve(ctx, begin.RequestID)
	require.NoError(t, err)

	const attempts = 8
	start := make(chan struct{})
	results := make(chan ExchangeResult, attempts)
	errs := make(chan error, attempts)
	var wg sync.WaitGroup
	for range attempts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			res, err := svc.Exchange(ctx, approved.Code, verifier, redirect)
			if err != nil {
				errs <- err
				return
			}
			results <- res
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	close(errs)

	require.Len(t, results, 1)
	require.Len(t, errs, attempts-1)
	for err := range errs {
		require.ErrorContains(t, err, "state USED")
	}

	var tokenRows int
	err = svc.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM device_tokens WHERE device_id = $1`, fingerprint).Scan(&tokenRows)
	require.NoError(t, err)
	require.Equal(t, 1, tokenRows)
}

func newPostgresService(t *testing.T) (*Service, context.Context) {
	t.Helper()
	dbURL := os.Getenv("PROSA_TEST_PG_URL")
	if dbURL == "" {
		t.Skip("set PROSA_TEST_PG_URL to run Postgres auth integration tests")
	}
	ctx := context.Background()
	adminPool, err := pgxpool.New(ctx, dbURL)
	require.NoError(t, err)

	schema := "auth_test_" + randomHex(t, 8)
	_, err = adminPool.Exec(ctx, `CREATE SCHEMA `+schema)
	require.NoError(t, err)

	cfg, err := pgxpool.ParseConfig(dbURL)
	require.NoError(t, err)
	if cfg.ConnConfig.RuntimeParams == nil {
		cfg.ConnConfig.RuntimeParams = map[string]string{}
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	require.NoError(t, err)

	t.Cleanup(func() {
		pool.Close()
		_, _ = adminPool.Exec(context.Background(), `DROP SCHEMA IF EXISTS `+schema+` CASCADE`)
		adminPool.Close()
	})

	applyServerMigrations(t, ctx, pool)

	return &Service{
		Pool:         pool,
		PanelBaseURL: "http://panel.test",
		ExpiresIn:    time.Minute,
	}, ctx
}

func applyServerMigrations(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
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

		version, err := serverMigrationVersion(name)
		require.NoError(t, err)
		_, err = pool.Exec(
			ctx,
			`INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING`,
			version,
		)
		require.NoErrorf(t, err, "record %s", name)
	}
}

func serverMigrationVersion(name string) (int, error) {
	underscore := strings.Index(name, "_")
	if underscore <= 0 {
		return 0, strconv.ErrSyntax
	}
	return strconv.Atoi(name[:underscore])
}

func testPKCEPair() (verifier, challenge string) {
	verifier = "test-verifier"
	h := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(h[:])
}

func randomHex(t *testing.T, n int) string {
	t.Helper()
	b := make([]byte, n)
	_, err := rand.Read(b)
	require.NoError(t, err)
	return hex.EncodeToString(b)
}
