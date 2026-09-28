package server

import (
	"regexp"
	"strings"
)

var (
	reOhqs   = regexp.MustCompile(`\bohqs_[A-Za-z0-9_-]{8,}\b`)
	reSkOr   = regexp.MustCompile(`\bsk-or-v1-[A-Za-z0-9_-]{16,}\b`)
	reSk     = regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{16,}\b`)
	reBearer = regexp.MustCompile(`(?i)\bBearer\s+[A-Za-z0-9._-]{20,}`)
	reAssign = regexp.MustCompile(`(?im)^(OPENROUTER_API_KEY|LLM_API_KEY|FLEXPRICE_API_KEY|ADMIN_TOKEN|OHQS_API_TOKEN|API_TOKEN|API_KEY|SECRET|PASSWORD|TOKEN)[ \t]*=[ \t]*\S[^\r\n]*$`)
)

// RedactSecrets strips common secret patterns for read-only preview.
func RedactSecrets(text string) string {
	out := text
	out = reOhqs.ReplaceAllString(out, "ohqs_REDACTED")
	out = reSkOr.ReplaceAllString(out, "sk-REDACTED")
	out = reSk.ReplaceAllString(out, "sk-REDACTED")
	out = reBearer.ReplaceAllString(out, "Bearer REDACTED")
	out = reAssign.ReplaceAllStringFunc(out, func(m string) string {
		eq := strings.IndexByte(m, '=')
		if eq < 0 {
			return m
		}
		return m[:eq+1] + "REDACTED"
	})
	return out
}

func LooksBinary(s string) bool {
	if s == "" {
		return false
	}
	if strings.ContainsRune(s, 0) {
		return true
	}
	n := len(s)
	if n > 2048 {
		n = 2048
	}
	bad := 0
	for i := 0; i < n; i++ {
		c := s[i]
		if c < 9 || (c > 13 && c < 32) || c == 127 {
			bad++
		}
	}
	return float64(bad) > float64(n)*0.05
}

// PreviewContent returns text safe for the read-only editor (never executed).
func PreviewContent(path, content string) (text string, placeholder bool) {
	if IsEnvSecretFile(path) {
		return "[secrets redacted in preview]\n\nReal .env values are not shown here.\nUse Download .zip for local editing — never commit ohqs_* tokens or live API keys.\nPlaceholders belong in .env.example only.", true
	}
	if LooksBinary(content) {
		return "[binary or non-text file — not shown in preview]", true
	}
	return RedactSecrets(content), false
}
