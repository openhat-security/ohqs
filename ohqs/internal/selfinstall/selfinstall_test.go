package selfinstall

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPathEnvPutsRepoFirst(t *testing.T) {
	root := t.TempDir()
	p := PathEnv(root)
	if !strings.HasPrefix(p, filepath.Join(root, "bin")) {
		t.Fatalf("PATH %s", p)
	}
	if !strings.Contains(p, filepath.Join(root, "bin", "tools")) {
		t.Fatalf("missing tools: %s", p)
	}
}

func TestCopyExe(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src")
	if err := os.WriteFile(src, []byte("ohqs-bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(dir, "tools", ExeName())
	if err := copyExe(src, dest); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "ohqs-bin" {
		t.Fatalf("got %q", b)
	}
}
