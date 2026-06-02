// Package auth implements PKCE + localhost-callback login for the CLI
// and bearer middleware for all other RPCs.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	defaultExpiresIn = 15 * time.Minute
	challengeMethod  = "S256"
)

// State constants written to auth_codes.state.
const (
	StatePending  = "PENDING"
	StateApproved = "APPROVED"
	StateExpired  = "EXPIRED"
	StateUsed     = "USED"
)

// Service is the login state machine and bearer lookup.
type Service struct {
	Pool         *pgxpool.Pool
	AdminToken   string
	PanelBaseURL string
	ExpiresIn    time.Duration
}

// New wires the service with sensible defaults.
func New(pool *pgxpool.Pool, adminToken, panelBaseURL string) *Service {
	return &Service{
		Pool:         pool,
		AdminToken:   adminToken,
		PanelBaseURL: strings.TrimRight(panelBaseURL, "/"),
		ExpiresIn:    defaultExpiresIn,
	}
}

// BeginResult is the projection of BeginLoginResponse.
type BeginResult struct {
	RequestID    string
	AuthorizeURL string
	ExpiresIn    int32
}

// Begin inserts a fresh PENDING auth_codes row.
func (s *Service) Begin(ctx context.Context, hostname, fingerprint, challenge, redirectURI, clientState string) (BeginResult, error) {
	if err := validateLoopbackRedirect(redirectURI); err != nil {
		return BeginResult{}, err
	}
	if challenge == "" || clientState == "" {
		return BeginResult{}, errors.New("code_challenge and client_state required")
	}
	requestID, err := newRequestID()
	if err != nil {
		return BeginResult{}, err
	}
	expiresAt := time.Now().UTC().Add(s.ExpiresIn)
	if _, err := s.Pool.Exec(ctx, `
		INSERT INTO auth_codes(
			request_id, code_challenge, code_challenge_method,
			redirect_uri, client_state, hostname, fingerprint, state, expires_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
	`, requestID, challenge, challengeMethod, redirectURI, clientState,
		hostname, fingerprint, StatePending, expiresAt); err != nil {
		return BeginResult{}, fmt.Errorf("insert auth_code: %w", err)
	}
	authURL := s.PanelBaseURL + "/cli/authorize?request_id=" + url.QueryEscape(requestID)
	return BeginResult{
		RequestID:    requestID,
		AuthorizeURL: authURL,
		ExpiresIn:    int32(s.ExpiresIn / time.Second),
	}, nil
}

// LoginRequest is the projection of GetLoginRequestResponse.
type LoginRequest struct {
	Hostname    string
	Fingerprint string
	ExpiresAt   time.Time
	State       string
}

// GetRequest returns metadata for the panel confirmation page.
func (s *Service) GetRequest(ctx context.Context, requestID string) (LoginRequest, error) {
	var (
		hostname, fingerprint, state string
		expiresAt                    time.Time
	)
	err := s.Pool.QueryRow(ctx, `
		SELECT hostname, fingerprint, state, expires_at
		FROM auth_codes WHERE request_id = $1
	`, requestID).Scan(&hostname, &fingerprint, &state, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return LoginRequest{}, fmt.Errorf("unknown request_id")
	}
	if err != nil {
		return LoginRequest{}, err
	}
	now := time.Now().UTC()
	if state == StatePending && now.After(expiresAt) {
		_, _ = s.Pool.Exec(ctx,
			`UPDATE auth_codes SET state = $1 WHERE request_id = $2`, StateExpired, requestID)
		state = StateExpired
	}
	return LoginRequest{
		Hostname:    hostname,
		Fingerprint: fingerprint,
		ExpiresAt:   expiresAt,
		State:       state,
	}, nil
}

// ApproveResult is returned after the panel approves a login attempt.
type ApproveResult struct {
	Code        string
	RedirectURI string
	ClientState string
}

// Approve flips PENDING → APPROVED and mints a one-time auth code.
func (s *Service) Approve(ctx context.Context, requestID string) (ApproveResult, error) {
	var (
		state, redirectURI, clientState string
		expiresAt                       time.Time
	)
	err := s.Pool.QueryRow(ctx, `
		SELECT state, redirect_uri, client_state, expires_at
		FROM auth_codes WHERE request_id = $1
	`, requestID).Scan(&state, &redirectURI, &clientState, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ApproveResult{}, fmt.Errorf("unknown request_id")
	}
	if err != nil {
		return ApproveResult{}, err
	}
	now := time.Now().UTC()
	if state != StatePending {
		return ApproveResult{}, fmt.Errorf("cannot approve request in state %s", state)
	}
	if now.After(expiresAt) {
		_, _ = s.Pool.Exec(ctx,
			`UPDATE auth_codes SET state = $1 WHERE request_id = $2`, StateExpired, requestID)
		return ApproveResult{}, errors.New("request already expired")
	}
	code, err := newAuthCode()
	if err != nil {
		return ApproveResult{}, err
	}
	tag, err := s.Pool.Exec(ctx, `
		UPDATE auth_codes
		SET state = $1, code = $2, approved_at = $3
		WHERE request_id = $4 AND state = $5
	`, StateApproved, code, now, requestID, StatePending)
	if err != nil {
		return ApproveResult{}, fmt.Errorf("approve request: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ApproveResult{}, errors.New("request no longer pending")
	}
	return ApproveResult{
		Code:        code,
		RedirectURI: redirectURI,
		ClientState: clientState,
	}, nil
}

// ExchangeResult is the projection of ExchangeCodeResponse.
type ExchangeResult struct {
	Token    string
	DeviceID string
}

// Exchange verifies PKCE and issues the device bearer.
func (s *Service) Exchange(ctx context.Context, code, verifier, redirectURI string) (ExchangeResult, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return ExchangeResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		state, challenge, storedRedirect, hostname, fingerprint string
		expiresAt                                               time.Time
	)
	err = tx.QueryRow(ctx, `
		SELECT state, code_challenge, redirect_uri, hostname, fingerprint, expires_at
		FROM auth_codes WHERE code = $1
		FOR UPDATE
	`, code).Scan(&state, &challenge, &storedRedirect, &hostname, &fingerprint, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ExchangeResult{}, fmt.Errorf("unknown code")
	}
	if err != nil {
		return ExchangeResult{}, err
	}
	now := time.Now().UTC()
	if now.After(expiresAt) {
		if state != StateExpired && state != StateUsed {
			if _, err := tx.Exec(ctx, `UPDATE auth_codes SET state = $1 WHERE code = $2`, StateExpired, code); err != nil {
				return ExchangeResult{}, fmt.Errorf("mark code expired: %w", err)
			}
			if err := tx.Commit(ctx); err != nil {
				return ExchangeResult{}, err
			}
		}
		return ExchangeResult{}, errors.New("code expired")
	}
	if state != StateApproved {
		return ExchangeResult{}, fmt.Errorf("code not approved (state %s)", state)
	}
	if redirectURI != storedRedirect {
		return ExchangeResult{}, errors.New("redirect_uri mismatch")
	}
	if !verifyPKCE(verifier, challenge) {
		return ExchangeResult{}, errors.New("pkce verification failed")
	}

	raw, hash, err := newBearer()
	if err != nil {
		return ExchangeResult{}, err
	}
	deviceID := fingerprint

	if _, err := tx.Exec(ctx, `
		INSERT INTO devices(id, hostname, machine_id, friendly_name, fingerprinted_at)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (id) DO UPDATE SET
			hostname         = EXCLUDED.hostname,
			friendly_name    = CASE WHEN EXCLUDED.friendly_name = ''
			                        THEN devices.friendly_name
			                        ELSE EXCLUDED.friendly_name END,
			fingerprinted_at = EXCLUDED.fingerprinted_at,
			revoked_at       = NULL
	`, deviceID, hostname, fingerprint, hostname, now); err != nil {
		return ExchangeResult{}, fmt.Errorf("upsert device: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO device_tokens(token_hash, device_id) VALUES ($1, $2)
	`, hash, deviceID); err != nil {
		return ExchangeResult{}, fmt.Errorf("insert device_token: %w", err)
	}
	tag, err := tx.Exec(ctx, `
		UPDATE auth_codes SET state = $1, used_at = $2 WHERE code = $3 AND state = $4
	`, StateUsed, now, code, StateApproved)
	if err != nil {
		return ExchangeResult{}, fmt.Errorf("mark code used: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ExchangeResult{}, errors.New("code no longer approved")
	}
	if err := tx.Commit(ctx); err != nil {
		return ExchangeResult{}, err
	}
	return ExchangeResult{Token: raw, DeviceID: deviceID}, nil
}

func validateLoopbackRedirect(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid redirect_uri: %w", err)
	}
	if u.Scheme != "http" {
		return errors.New("redirect_uri must use http")
	}
	host := u.Hostname()
	if host != "127.0.0.1" && host != "localhost" {
		return errors.New("redirect_uri must target loopback")
	}
	if u.Path != "/callback" {
		return errors.New("redirect_uri path must be /callback")
	}
	return nil
}

func verifyPKCE(verifier, challenge string) bool {
	h := sha256.Sum256([]byte(verifier))
	computed := base64.RawURLEncoding.EncodeToString(h[:])
	return subtleConstantTimeEqual(computed, challenge)
}

func subtleConstantTimeEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var v byte
	for i := 0; i < len(a); i++ {
		v |= a[i] ^ b[i]
	}
	return v == 0
}

func newRequestID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func newAuthCode() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func newBearer() (raw, hash string, err error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", "", err
	}
	raw = hex.EncodeToString(b)
	hash = HashBearer(raw)
	return raw, hash, nil
}

// DeviceFromBearer looks up the device_id bound to a bearer presented
// in an Authorization header. Returns ErrUnknownToken when no row
// matches OR when the row was revoked.
func (s *Service) DeviceFromBearer(ctx context.Context, bearer string) (string, error) {
	hash := HashBearer(bearer)
	var (
		deviceID  string
		revokedAt *time.Time
	)
	err := s.Pool.QueryRow(ctx, `
		SELECT device_id, revoked_at FROM device_tokens WHERE token_hash = $1
	`, hash).Scan(&deviceID, &revokedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrUnknownToken
	}
	if err != nil {
		return "", err
	}
	if revokedAt != nil {
		return "", ErrUnknownToken
	}
	return deviceID, nil
}

// HashBearer returns the canonical sha256 hash we store.
func HashBearer(bearer string) string {
	h := sha256.Sum256([]byte(bearer))
	return hex.EncodeToString(h[:])
}

// ErrUnknownToken is returned when a bearer doesn't map to a live row.
var ErrUnknownToken = errors.New("unknown or revoked token")
