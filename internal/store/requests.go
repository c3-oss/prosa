package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/c3-oss/prosa/pkg/session"
)

func replaceRequestsTx(ctx context.Context, tx *sql.Tx, sess session.Session) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM session_requests WHERE session_id = ?`, sess.ID); err != nil {
		return fmt.Errorf("clear requests for %s: %w", sess.ID, err)
	}
	for i, request := range sess.Requests {
		payload, err := json.Marshal(request)
		if err != nil {
			return fmt.Errorf("encode request %d for %s: %w", i, sess.ID, err)
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO session_requests(session_id, ordinal, payload) VALUES (?, ?, ?)`,
			sess.ID, i, string(payload)); err != nil {
			return fmt.Errorf("insert request %d for %s: %w", i, sess.ID, err)
		}
	}
	return nil
}

func attachRequests(ctx context.Context, db *sql.DB, list []session.Session) error {
	const batchSize = 500
	for start := 0; start < len(list); start += batchSize {
		end := min(start+batchSize, len(list))
		batch := list[start:end]
		args := make([]any, len(batch))
		byID := make(map[string]int, len(batch))
		for i := range batch {
			args[i] = batch[i].ID
			byID[batch[i].ID] = i
			batch[i].Requests = nil
		}
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(batch)), ",")
		rows, err := db.QueryContext(ctx,
			`SELECT session_id, payload FROM session_requests WHERE session_id IN (`+placeholders+`) ORDER BY session_id, ordinal`,
			args...)
		if err != nil {
			return fmt.Errorf("query requests: %w", err)
		}
		for rows.Next() {
			var id, payload string
			if err := rows.Scan(&id, &payload); err != nil {
				rows.Close()
				return fmt.Errorf("scan request: %w", err)
			}
			var request session.RequestUsage
			if err := json.Unmarshal([]byte(payload), &request); err != nil {
				rows.Close()
				return fmt.Errorf("decode request for %s: %w", id, err)
			}
			i := byID[id]
			batch[i].Requests = append(batch[i].Requests, request)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return fmt.Errorf("read requests: %w", err)
		}
	}
	return nil
}
