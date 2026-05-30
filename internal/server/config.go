// Package server hosts the prosa server runtime: config, HTTP wiring,
// Connect handlers, and storage adapters (Postgres + S3-compatible).
// The CLI talks to it via the generated Connect clients in
// gen/go/prosa/v1/prosav1connect.
package server

import (
	"errors"
	"fmt"
	"os"
	"strconv"
)

// Config is the env-driven runtime configuration for prosa-server. All
// fields can be overridden via the PROSA_* env vars listed inline.
type Config struct {
	// HTTP listen address. PROSA_LISTEN_ADDR (default ":7070").
	ListenAddr string

	// Postgres connection string. PROSA_DB_URL. Required.
	DBURL string

	// S3-compatible endpoint. PROSA_S3_ENDPOINT (e.g. "localhost:9000"
	// for MinIO; "s3.amazonaws.com" or "<account>.r2.cloudflarestorage.com"
	// for prod). Required.
	S3Endpoint string

	// PROSA_S3_BUCKET (default "prosa-raw").
	S3Bucket string

	// PROSA_S3_ACCESS_KEY / PROSA_S3_SECRET_KEY. Required.
	S3AccessKey string
	S3SecretKey string

	// PROSA_S3_USE_SSL (default false; flip to true for production).
	S3UseSSL bool

	// PROSA_S3_REGION (default "us-east-1"; MinIO ignores it, R2/B2
	// accept any string).
	S3Region string

	// PROSA_ADMIN_TOKEN — bearer used by `prosa-server --approve` to flip
	// a PENDING device_code to APPROVED. Required for the device-code
	// flow to make progress until the painel ships.
	AdminToken string

	// PROSA_VERIFICATION_URI — surfaced in StartLoginResponse so the CLI
	// can print the address the user types the code into. Required.
	VerificationURI string
}

// Load reads the configuration from environment variables and validates
// that the required fields are populated. Defaults match the dev
// docker-compose.yml so a fresh checkout boots without extra exports.
func Load() (Config, error) {
	cfg := Config{
		ListenAddr:      envDefault("PROSA_LISTEN_ADDR", ":7070"),
		DBURL:           os.Getenv("PROSA_DB_URL"),
		S3Endpoint:      os.Getenv("PROSA_S3_ENDPOINT"),
		S3Bucket:        envDefault("PROSA_S3_BUCKET", "prosa-raw"),
		S3AccessKey:     os.Getenv("PROSA_S3_ACCESS_KEY"),
		S3SecretKey:     os.Getenv("PROSA_S3_SECRET_KEY"),
		S3Region:        envDefault("PROSA_S3_REGION", "us-east-1"),
		AdminToken:      os.Getenv("PROSA_ADMIN_TOKEN"),
		VerificationURI: os.Getenv("PROSA_VERIFICATION_URI"),
	}
	useSSL, _ := strconv.ParseBool(os.Getenv("PROSA_S3_USE_SSL"))
	cfg.S3UseSSL = useSSL

	var missing []string
	if cfg.DBURL == "" {
		missing = append(missing, "PROSA_DB_URL")
	}
	if cfg.S3Endpoint == "" {
		missing = append(missing, "PROSA_S3_ENDPOINT")
	}
	if cfg.S3AccessKey == "" {
		missing = append(missing, "PROSA_S3_ACCESS_KEY")
	}
	if cfg.S3SecretKey == "" {
		missing = append(missing, "PROSA_S3_SECRET_KEY")
	}
	if cfg.AdminToken == "" {
		missing = append(missing, "PROSA_ADMIN_TOKEN")
	}
	if cfg.VerificationURI == "" {
		missing = append(missing, "PROSA_VERIFICATION_URI")
	}
	if len(missing) > 0 {
		return Config{}, fmt.Errorf("missing required env vars: %v", missing)
	}
	return cfg, nil
}

// LoadForApprove is a relaxed loader for the `--approve` sub-command:
// it only needs ListenAddr (to know where to call) and AdminToken (to
// authenticate). The DB/S3 plumbing is irrelevant since the admin client
// just hits the AuthService over HTTP.
func LoadForApprove() (Config, error) {
	cfg := Config{
		ListenAddr: envDefault("PROSA_LISTEN_ADDR", ":7070"),
		AdminToken: os.Getenv("PROSA_ADMIN_TOKEN"),
	}
	if cfg.AdminToken == "" {
		return Config{}, errors.New("PROSA_ADMIN_TOKEN required for --approve")
	}
	return cfg, nil
}

func envDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
