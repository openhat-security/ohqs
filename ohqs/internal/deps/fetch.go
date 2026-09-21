package deps

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/openhat/quick-start/internal/catalog"
)

func sourceReady(dir string) bool {
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return false
	}
	markers := []string{
		".git", "go.mod", "Cargo.toml", "pyproject.toml", "setup.py",
		"sqlmap.py", "dirsearch.py", "jwt_tool.py", "program/nikto.pl",
		"README.md", "readme.md",
	}
	for _, m := range markers {
		if _, err := os.Stat(filepath.Join(dir, m)); err == nil {
			return true
		}
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	return len(ents) > 0
}

func fetch(root string, rec catalog.Record, out io.Writer) error {
	rel := SourceRel(rec)
	dir := filepath.Join(root, rel)
	if sourceReady(dir) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return err
	}
	if listedInGitmodules(root, rel) && isGitRepo(root) {
		fmt.Fprintf(out, "  git submodule update --init --depth 1 -- %s\n", rel)
		cmd := exec.Command("git", "submodule", "update", "--init", "--depth", "1", "--", rel)
		cmd.Dir = root
		cmd.Stdout = out
		cmd.Stderr = out
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("submodule %s: %w", rel, err)
		}
		if sourceReady(dir) {
			return nil
		}
	}
	url := GitURL(rec.Homepage)
	if url == "" {
		return fmt.Errorf("no git URL for %s (homepage %s)", rec.ID, rec.Homepage)
	}
	if _, err := os.Stat(dir); err == nil {
		_ = os.RemoveAll(dir)
	}
	fmt.Fprintf(out, "  git clone --depth 1 %s\n", url)
	cmd := exec.Command("git", "clone", "--depth", "1", "--single-branch", url, dir)
	cmd.Stdout = out
	cmd.Stderr = out
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("clone %s: %w", rec.ID, err)
	}
	return nil
}

func listedInGitmodules(root, rel string) bool {
	b, err := os.ReadFile(filepath.Join(root, ".gitmodules"))
	if err != nil {
		return false
	}
	want := "path = " + rel
	for _, line := range strings.Split(string(b), "\n") {
		if strings.TrimSpace(line) == want {
			return true
		}
	}
	return false
}

func isGitRepo(root string) bool {
	cmd := exec.Command("git", "rev-parse", "--is-inside-work-tree")
	cmd.Dir = root
	return cmd.Run() == nil
}
