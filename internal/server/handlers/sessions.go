package handlers

import (
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
	"github.com/c3-oss/prosa/internal/server/storage"
)

// SessionsHandler implements the SessionsService Connect interface.
type SessionsHandler struct {
	prosav1connect.UnimplementedSessionsServiceHandler
	Pool *pgxpool.Pool
	Obj  *storage.ObjectStore
}

func NewSessionsHandler(pool *pgxpool.Pool, obj *storage.ObjectStore) *SessionsHandler {
	return &SessionsHandler{Pool: pool, Obj: obj}
}
