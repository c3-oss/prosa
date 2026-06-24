package panel

import (
	"crypto/sha256"
	"fmt"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"

	"github.com/c3-oss/prosa/internal/buildinfo"
	"github.com/c3-oss/prosa/internal/panel/assets"
)

// Some platforms lack a registry entry for woff2, which would serve the
// embedded fonts as octet-stream. Register the font types explicitly.
func init() {
	_ = mime.AddExtensionType(".woff2", "font/woff2")
	_ = mime.AddExtensionType(".woff", "font/woff")
}

func assetPath(name string) string {
	name = strings.TrimLeft(path.Clean("/"+name), "/")
	return "/assets/" + assetVersionSegment() + "/" + name
}

func assetVersionSegment() string {
	version := strings.TrimSpace(buildinfo.Version)
	if version == "" || version == "dev" {
		version = strings.TrimSpace(buildinfo.Commit)
	}
	if version == "" || version == "none" {
		version = "dev"
	}

	var b strings.Builder
	for _, r := range version {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '.', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	if b.Len() == 0 {
		return "dev"
	}
	return b.String()
}

func assetHandler() (http.Handler, error) {
	sub, err := fs.Sub(assets.FS, ".")
	if err != nil {
		return nil, fmt.Errorf("open panel assets: %w", err)
	}
	etags, err := assetETags(sub)
	if err != nil {
		return nil, err
	}
	files := http.FileServer(http.FS(sub))
	version := assetVersionSegment()
	immutable := version != "dev"

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/assets/")
		versioned := false
		if head, tail, ok := strings.Cut(name, "/"); ok && head == version {
			name = tail
			versioned = immutable
		}
		name = strings.TrimLeft(path.Clean("/"+name), "/")

		if versioned {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		if etag := etags[name]; etag != "" {
			w.Header().Set("ETag", etag)
		}

		rr := r.Clone(r.Context())
		rr.URL.Path = "/" + name
		files.ServeHTTP(w, rr)
	}), nil
}

func assetETags(fsys fs.FS) (map[string]string, error) {
	out := map[string]string{}
	err := fs.WalkDir(fsys, ".", func(name string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		b, err := fs.ReadFile(fsys, name)
		if err != nil {
			return fmt.Errorf("read panel asset %s: %w", name, err)
		}
		sum := sha256.Sum256(b)
		out[name] = fmt.Sprintf(`"%x"`, sum[:])
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("fingerprint panel assets: %w", err)
	}
	return out, nil
}
