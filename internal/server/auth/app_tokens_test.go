package auth

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestAppTokenLifecycleWithPostgres(t *testing.T) {
	svc, ctx := newPostgresService(t)

	tok, secret, err := svc.CreateAppToken(ctx, "prosa-webp-widgets")
	require.NoError(t, err)
	require.NotEmpty(t, tok.ID)
	require.Equal(t, "prosa-webp-widgets", tok.Name)
	require.True(t, strings.HasPrefix(secret, appTokenPrefix))

	resolved, err := svc.AppTokenFromBearer(ctx, secret)
	require.NoError(t, err)
	require.Equal(t, tok.ID, resolved.ID)
	require.Equal(t, tok.Name, resolved.Name)

	tokens, err := svc.ListAppTokens(ctx)
	require.NoError(t, err)
	require.Len(t, tokens, 1)
	require.NotNil(t, tokens[0].LastUsedAt)
	require.Nil(t, tokens[0].RevokedAt)

	require.NoError(t, svc.RevokeAppToken(ctx, tok.ID))
	_, err = svc.AppTokenFromBearer(ctx, secret)
	require.ErrorIs(t, err, ErrUnknownToken)

	tokens, err = svc.ListAppTokens(ctx)
	require.NoError(t, err)
	require.Len(t, tokens, 1)
	require.NotNil(t, tokens[0].RevokedAt)
}
