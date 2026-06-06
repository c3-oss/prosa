package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"

	prosav1 "github.com/c3-oss/prosa/gen/go/prosa/v1"
	"github.com/c3-oss/prosa/gen/go/prosa/v1/prosav1connect"
)

// panicHealth panics on every call, standing in for any handler that hits
// a nil deref or out-of-bounds while assembling its response.
type panicHealth struct {
	prosav1connect.UnimplementedHealthServiceHandler
}

func (panicHealth) Check(context.Context, *connect.Request[prosav1.CheckRequest]) (*connect.Response[prosav1.CheckResponse], error) {
	panic("boom")
}

// With the recover option a panicking handler must surface as
// connect.CodeInternal to the caller, not an EOF/closed connection. See
// issue #84.
func TestRecoverHandlerConvertsPanicToInternal(t *testing.T) {
	mux := http.NewServeMux()
	path, handler := prosav1connect.NewHealthServiceHandler(panicHealth{}, connect.WithRecover(recoverHandler))
	mux.Handle(path, handler)

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	client := prosav1connect.NewHealthServiceClient(srv.Client(), srv.URL)
	_, err := client.Check(context.Background(), connect.NewRequest(&prosav1.CheckRequest{}))
	require.Error(t, err)
	require.Equal(t, connect.CodeInternal, connect.CodeOf(err))
}
