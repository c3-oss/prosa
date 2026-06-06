package cli

import (
	"context"
	"log/slog"
	"sync/atomic"
)

type warningCounterHandler struct {
	count *atomic.Int64
}

func (h warningCounterHandler) Enabled(_ context.Context, level slog.Level) bool {
	return level >= slog.LevelWarn
}

func (h warningCounterHandler) Handle(context.Context, slog.Record) error {
	h.count.Add(1)
	return nil
}

func (h warningCounterHandler) WithAttrs([]slog.Attr) slog.Handler {
	return h
}

func (h warningCounterHandler) WithGroup(string) slog.Handler {
	return h
}
