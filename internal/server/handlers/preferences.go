package handlers

import (
	"context"
	"errors"

	"connectrpc.com/connect"
	"github.com/jackc/pgx/v5/pgxpool"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
	"github.com/c3-oss/prosa/internal/server/auth"
)

// PreferencesHandler implements the PreferencesService Connect interface.
// Only owner callers (the panel, authenticated via the admin token) may
// read or write; the owner_email in the request scopes the rows.
type PreferencesHandler struct {
	prosav1connect.UnimplementedPreferencesServiceHandler
	Pool *pgxpool.Pool
}

func NewPreferencesHandler(pool *pgxpool.Pool) *PreferencesHandler {
	return &PreferencesHandler{Pool: pool}
}

// Get returns every stored preference for the owner as a key/value map.
func (h *PreferencesHandler) Get(ctx context.Context, req *connect.Request[prosav1.PreferencesServiceGetRequest]) (*connect.Response[prosav1.PreferencesServiceGetResponse], error) {
	if !auth.IsOwner(ctx) {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("owner context required"))
	}
	if req.Msg.OwnerEmail == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, missingFields("owner_email"))
	}
	rows, err := h.Pool.Query(
		ctx,
		`SELECT pref_key, pref_value FROM panel_preferences WHERE owner_email = $1`,
		req.Msg.OwnerEmail,
	)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	defer rows.Close()

	prefs := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, connect.NewError(connect.CodeInternal, err)
		}
		prefs[k] = v
	}
	if err := rows.Err(); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&prosav1.PreferencesServiceGetResponse{Preferences: prefs}), nil
}

// Set upserts one preference for the owner. The panel validates the value
// against its own catalog before calling; the server stores it verbatim.
func (h *PreferencesHandler) Set(ctx context.Context, req *connect.Request[prosav1.PreferencesServiceSetRequest]) (*connect.Response[prosav1.PreferencesServiceSetResponse], error) {
	if !auth.IsOwner(ctx) {
		return nil, connect.NewError(connect.CodePermissionDenied, errors.New("owner context required"))
	}
	var missing []string
	if req.Msg.OwnerEmail == "" {
		missing = append(missing, "owner_email")
	}
	if req.Msg.Key == "" {
		missing = append(missing, "key")
	}
	if req.Msg.Value == "" {
		missing = append(missing, "value")
	}
	if len(missing) > 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, missingFields(missing...))
	}
	if _, err := h.Pool.Exec(
		ctx,
		`INSERT INTO panel_preferences (owner_email, pref_key, pref_value, updated_at)
		 VALUES ($1, $2, $3, NOW())
		 ON CONFLICT (owner_email, pref_key) DO UPDATE SET
		   pref_value = EXCLUDED.pref_value,
		   updated_at = NOW()`,
		req.Msg.OwnerEmail, req.Msg.Key, req.Msg.Value,
	); err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&prosav1.PreferencesServiceSetResponse{}), nil
}
