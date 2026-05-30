// Package auth implements the device-code flow surfaced via AuthService
// + the bearer middleware that gates every other RPC. See INTENT.md §6
// for the conceptual model: client triggers StartLogin → user types the
// code somewhere trusted → Approve flips the row → next Poll returns
// the bearer.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Defaults for the device-code lifecycle. Mirrored from RFC 8628 with
// shorter values appropriate for a self-hosted single-user deployment.
const (
	defaultExpiresIn = 15 * time.Minute
	defaultInterval  = 2 * time.Second
)

// State constants written to device_codes.state. Match the proto enum
// names so the handler can copy them straight across.
const (
	StatePending  = "PENDING"
	StateApproved = "APPROVED"
	StateDenied   = "DENIED"
	StateExpired  = "EXPIRED"
	StateUsed     = "USED" // terminal after PollLogin issued the token
)

// Service is the device-code state machine. All RPCs go through this
// type so the handler layer stays thin.
type Service struct {
	Pool            *pgxpool.Pool
	AdminToken      string
	VerificationURI string
	ExpiresIn       time.Duration
	Interval        time.Duration
}

// New wires the service with sensible defaults.
func New(pool *pgxpool.Pool, adminToken, verificationURI string) *Service {
	return &Service{
		Pool:            pool,
		AdminToken:      adminToken,
		VerificationURI: verificationURI,
		ExpiresIn:       defaultExpiresIn,
		Interval:        defaultInterval,
	}
}

// StartResult is the projection of StartLoginResponse the service
// returns to the handler.
type StartResult struct {
	UserCode        string
	DeviceCode      string
	VerificationURI string
	ExpiresIn       int32
	Interval        int32
}

// Start inserts a fresh PENDING row.
func (s *Service) Start(ctx context.Context, hostname, fingerprint string) (StartResult, error) {
	userCode, err := newUserCode()
	if err != nil {
		return StartResult{}, err
	}
	deviceCode, err := newDeviceCode()
	if err != nil {
		return StartResult{}, err
	}
	expiresAt := time.Now().UTC().Add(s.ExpiresIn)

	if _, err := s.Pool.Exec(ctx, `
		INSERT INTO device_codes(device_code, user_code, state, hostname, fingerprint, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, deviceCode, userCode, StatePending, hostname, fingerprint, expiresAt); err != nil {
		return StartResult{}, fmt.Errorf("insert device_code: %w", err)
	}
	return StartResult{
		UserCode:        userCode,
		DeviceCode:      deviceCode,
		VerificationURI: s.VerificationURI,
		ExpiresIn:       int32(s.ExpiresIn / time.Second),
		Interval:        int32(s.Interval / time.Second),
	}, nil
}

// PollResult is the projection of PollLoginResponse.
type PollResult struct {
	State    string
	Token    string // populated only on APPROVED → USED transition
	DeviceID string
}

// Poll returns the current state. On the APPROVED→USED transition it
// generates the bearer, stores its sha256 in device_tokens, upserts the
// devices row, and returns the raw token (the only time we ever yield
// it).
func (s *Service) Poll(ctx context.Context, deviceCode string) (PollResult, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return PollResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		state, hostname, fingerprint string
		expiresAt                    time.Time
	)
	err = tx.QueryRow(ctx, `
		SELECT state, hostname, fingerprint, expires_at
		FROM device_codes WHERE device_code = $1
	`, deviceCode).Scan(&state, &hostname, &fingerprint, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return PollResult{}, fmt.Errorf("unknown device_code")
	}
	if err != nil {
		return PollResult{}, err
	}

	now := time.Now().UTC()
	if state == StatePending && now.After(expiresAt) {
		state = StateExpired
		_, _ = tx.Exec(ctx, `UPDATE device_codes SET state = $1 WHERE device_code = $2`,
			StateExpired, deviceCode)
		_ = tx.Commit(ctx)
		return PollResult{State: StateExpired}, nil
	}

	switch state {
	case StatePending, StateExpired, StateDenied, StateUsed:
		// Mid-states (or already-consumed) just echo.
		_ = tx.Commit(ctx)
		// USED → echo APPROVED-with-empty-token would mislead; surface
		// USED as "expired" externally so the CLI knows to start over.
		if state == StateUsed {
			return PollResult{State: StateExpired}, nil
		}
		return PollResult{State: state}, nil
	case StateApproved:
		// Issue the token; consume the row.
		raw, hash, err := newBearer()
		if err != nil {
			return PollResult{}, err
		}
		deviceID := fingerprint

		// Upsert devices row (fields land here for the first time when
		// the very first login of a brand-new machine completes).
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
			return PollResult{}, fmt.Errorf("upsert device: %w", err)
		}

		if _, err := tx.Exec(ctx, `
			INSERT INTO device_tokens(token_hash, device_id) VALUES ($1, $2)
		`, hash, deviceID); err != nil {
			return PollResult{}, fmt.Errorf("insert device_token: %w", err)
		}

		if _, err := tx.Exec(ctx, `
			UPDATE device_codes SET state = $1 WHERE device_code = $2
		`, StateUsed, deviceCode); err != nil {
			return PollResult{}, fmt.Errorf("mark device_code used: %w", err)
		}
		if err := tx.Commit(ctx); err != nil {
			return PollResult{}, err
		}
		return PollResult{State: StateApproved, Token: raw, DeviceID: deviceID}, nil
	}
	return PollResult{State: state}, nil
}

// Approve flips a PENDING row to APPROVED. Caller must prove the admin
// token via constant-time compare.
func (s *Service) Approve(ctx context.Context, userCode, adminToken string) (string, error) {
	if subtle.ConstantTimeCompare([]byte(adminToken), []byte(s.AdminToken)) != 1 {
		return "", errors.New("admin token mismatch")
	}
	userCode = strings.ToUpper(userCode)

	var (
		state       string
		fingerprint string
		expiresAt   time.Time
	)
	err := s.Pool.QueryRow(ctx, `
		SELECT state, fingerprint, expires_at FROM device_codes WHERE user_code = $1
	`, userCode).Scan(&state, &fingerprint, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("unknown user_code %s", userCode)
	}
	if err != nil {
		return "", err
	}
	now := time.Now().UTC()
	if state != StatePending {
		return "", fmt.Errorf("cannot approve user_code in state %s", state)
	}
	if now.After(expiresAt) {
		_, _ = s.Pool.Exec(ctx,
			`UPDATE device_codes SET state = $1 WHERE user_code = $2`, StateExpired, userCode)
		return "", errors.New("user_code already expired")
	}
	if _, err := s.Pool.Exec(ctx, `
		UPDATE device_codes
		SET state = $1, approved_at = $2
		WHERE user_code = $3 AND state = $4
	`, StateApproved, now, userCode, StatePending); err != nil {
		return "", fmt.Errorf("approve user_code: %w", err)
	}
	return fingerprint, nil
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

// HashBearer returns the canonical sha256 hash we store. Exposed for
// tests and middleware unit tests.
func HashBearer(bearer string) string {
	h := sha256.Sum256([]byte(bearer))
	return hex.EncodeToString(h[:])
}

// ErrUnknownToken is returned when a bearer doesn't map to a live
// device_token row.
var ErrUnknownToken = errors.New("unknown or revoked token")

// userCodeAlphabet excludes ambiguous characters so users typing the
// code don't confuse 0/O or 1/I/L.
const userCodeAlphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789"

func newUserCode() (string, error) {
	// 7 chars grouped as XXX-XXXX → easy to read and type.
	buf := make([]byte, 7)
	max := byte(len(userCodeAlphabet))
	for i := range buf {
		b := []byte{0}
		if _, err := rand.Read(b); err != nil {
			return "", err
		}
		buf[i] = userCodeAlphabet[b[0]%max]
	}
	return string(buf[:3]) + "-" + string(buf[3:]), nil
}

func newDeviceCode() (string, error) {
	b := make([]byte, 16)
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
