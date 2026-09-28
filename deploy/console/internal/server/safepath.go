package server

import (
	"path"
	"strings"
	"unicode"
)

// SanitizeZipPath rejects absolute paths, drive letters, and .. segments.
// Returns a normalized relative path or empty string if unsafe.
func SanitizeZipPath(raw string) string {
	p := strings.TrimSpace(strings.ReplaceAll(raw, "\\", "/"))
	if p == "" {
		return ""
	}
	if strings.HasPrefix(p, "/") || strings.HasPrefix(p, "~") {
		return ""
	}
	if len(p) >= 2 && unicode.IsLetter(rune(p[0])) && p[1] == ':' {
		return ""
	}
	parts := strings.Split(p, "/")
	out := make([]string, 0, len(parts))
	for _, seg := range parts {
		if seg == "" || seg == "." {
			continue
		}
		if seg == ".." {
			return ""
		}
		out = append(out, seg)
	}
	if len(out) == 0 {
		return ""
	}
	return path.Join(out...)
}

func IsEnvSecretFile(p string) bool {
	base := path.Base(p)
	if base == ".env.example" || base == ".env.sample" || base == ".env.template" {
		return false
	}
	return base == ".env" || strings.HasPrefix(base, ".env.")
}
