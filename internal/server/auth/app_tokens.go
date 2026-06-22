package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const appTokenPrefix = "prosa_app_"

// AppTokenRecord is the database projection used by the owner management RPCs.
type AppTokenRecord struct {
	ID         string
	Name       string
	CreatedAt  time.Time
	LastUsedAt *time.Time
	RevokedAt  *time.Time
}

// CreateAppToken inserts a new app token and returns its plaintext secret once.
func (s *Service) CreateAppToken(ctx context.Context, name string) (AppTokenRecord, string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return AppTokenRecord{}, "", errors.New("name required")
	}
	id, err := newAppTokenID()
	if err != nil {
		return AppTokenRecord{}, "", err
	}
	secret, hash, err := newAppTokenSecret()
	if err != nil {
		return AppTokenRecord{}, "", err
	}
	createdAt := time.Now().UTC()
	if _, err := s.Pool.Exec(ctx, `
		INSERT INTO app_tokens(id, name, token_hash, created_at)
		VALUES ($1, $2, $3, $4)
	`, id, name, hash, createdAt); err != nil {
		return AppTokenRecord{}, "", fmt.Errorf("insert app token: %w", err)
	}
	return AppTokenRecord{
		ID:        id,
		Name:      name,
		CreatedAt: createdAt,
	}, secret, nil
}

// ListAppTokens returns app tokens newest first, including revoked rows.
func (s *Service) ListAppTokens(ctx context.Context) ([]AppTokenRecord, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT id, name, created_at, last_used_at, revoked_at
		FROM app_tokens
		ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []AppTokenRecord
	for rows.Next() {
		var tok AppTokenRecord
		if err := rows.Scan(&tok.ID, &tok.Name, &tok.CreatedAt, &tok.LastUsedAt, &tok.RevokedAt); err != nil {
			return nil, err
		}
		out = append(out, tok)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// RevokeAppToken marks a token revoked. Unknown ids are treated as no-ops.
func (s *Service) RevokeAppToken(ctx context.Context, id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New("id required")
	}
	_, err := s.Pool.Exec(ctx, `
		UPDATE app_tokens
		SET revoked_at = COALESCE(revoked_at, NOW())
		WHERE id = $1
	`, id)
	return err
}

// AppTokenFromBearer resolves a live app token from an Authorization secret.
func (s *Service) AppTokenFromBearer(ctx context.Context, bearer string) (AppToken, error) {
	hash := HashBearer(bearer)
	var (
		id        string
		name      string
		revokedAt *time.Time
	)
	err := s.Pool.QueryRow(ctx, `
		SELECT id, name, revoked_at FROM app_tokens WHERE token_hash = $1
	`, hash).Scan(&id, &name, &revokedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return AppToken{}, ErrUnknownToken
	}
	if err != nil {
		return AppToken{}, err
	}
	if revokedAt != nil {
		return AppToken{}, ErrUnknownToken
	}
	if _, err := s.Pool.Exec(ctx, `UPDATE app_tokens SET last_used_at = NOW() WHERE id = $1`, id); err != nil {
		return AppToken{}, err
	}
	return AppToken{ID: id, Name: name}, nil
}

func newAppTokenID() (string, error) {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func newAppTokenSecret() (raw, hash string, err error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", "", err
	}
	raw = appTokenPrefix + hex.EncodeToString(b)
	hash = HashBearer(raw)
	return raw, hash, nil
}
