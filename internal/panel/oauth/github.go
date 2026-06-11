// Package oauth speaks the minimal GitHub OAuth web flow needed by the
// panel: build the consent URL, exchange the code, fetch the primary
// verified email. No third-party SDK — the surface is tiny enough that
// stdlib + a couple of struct types is simpler than golang.org/x/oauth2.
package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

const (
	authEndpoint  = "https://github.com/login/oauth/authorize"
	tokenEndpoint = "https://github.com/login/oauth/access_token"
	emailsAPI     = "https://api.github.com/user/emails"
)

// GitHubAuthURL builds the GitHub OAuth consent URL.
func GitHubAuthURL(clientID, redirectURI, state string) string {
	q := url.Values{}
	q.Set("client_id", clientID)
	q.Set("redirect_uri", redirectURI)
	q.Set("state", state)
	q.Set("scope", "read:user user:email")
	q.Set("allow_signup", "false")
	return authEndpoint + "?" + q.Encode()
}

type ExchangeArgs struct {
	ClientID     string
	ClientSecret string
	RedirectURI  string
	Code         string
}

// GitHubExchange swaps the OAuth `code` for an access token.
func GitHubExchange(ctx context.Context, a ExchangeArgs) (string, error) {
	form := url.Values{}
	form.Set("client_id", a.ClientID)
	form.Set("client_secret", a.ClientSecret)
	form.Set("redirect_uri", a.RedirectURI)
	form.Set("code", a.Code)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("token request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("token endpoint returned %s: %s", resp.Status, string(body))
	}

	var out struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
		ErrorDesc   string `json:"error_description"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("decode token resp: %w", err)
	}
	if out.Error != "" {
		return "", fmt.Errorf("github error: %s — %s", out.Error, out.ErrorDesc)
	}
	if out.AccessToken == "" {
		return "", errors.New("github returned no access token")
	}
	return out.AccessToken, nil
}

// GitHubPrimaryEmail returns the verified primary email of the
// authenticated user.
func GitHubPrimaryEmail(ctx context.Context, accessToken string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, emailsAPI, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("emails request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("emails endpoint returned %s: %s", resp.Status, string(body))
	}
	var emails []struct {
		Email    string `json:"email"`
		Primary  bool   `json:"primary"`
		Verified bool   `json:"verified"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&emails); err != nil {
		return "", fmt.Errorf("decode emails: %w", err)
	}
	for _, e := range emails {
		if e.Primary && e.Verified {
			return e.Email, nil
		}
	}
	for _, e := range emails {
		if e.Verified {
			return e.Email, nil
		}
	}
	return "", errors.New("no verified email on github account")
}
