package server

import (
	"strings"
	"testing"
)

func TestSanitizeZipPath(t *testing.T) {
	cases := map[string]string{
		"PLAYBOOK.md":        "PLAYBOOK.md",
		"src/setup.py":       "src/setup.py",
		"../etc/passwd":      "",
		"/etc/passwd":        "",
		`C:\Windows\win.ini`: "",
		"./foo/./bar":        "foo/bar",
		"":                   "",
	}
	for in, want := range cases {
		if got := SanitizeZipPath(in); got != want {
			t.Fatalf("SanitizeZipPath(%q)=%q want %q", in, got, want)
		}
	}
}

func TestRedactSecrets(t *testing.T) {
	in := "Bearer abcdefghijklmnopqrstuvwxyz012345\nsk-or-v1-abcdefghijklmnopqrstuvwxyz\nohqs_c_ABCDEFGHIJKLMNOP\n"
	out := RedactSecrets(in)
	if strings.Contains(out, "ohqs_c_ABCDEFGHIJKLMNOP") {
		t.Fatalf("ohqs token not redacted: %s", out)
	}
	if !strings.Contains(out, "ohqs_REDACTED") {
		t.Fatalf("missing ohqs_REDACTED: %s", out)
	}
	if strings.Contains(out, "sk-or-v1-abcdefghijklmnopqrstuvwxyz") {
		t.Fatalf("sk-or not redacted: %s", out)
	}
	if !strings.Contains(out, "Bearer REDACTED") {
		t.Fatalf("bearer not redacted: %s", out)
	}
}

func TestIsEnvSecretFile(t *testing.T) {
	if !IsEnvSecretFile(".env") {
		t.Fatal("expected .env secret")
	}
	if IsEnvSecretFile(".env.example") {
		t.Fatal(".env.example should not be secret")
	}
}
