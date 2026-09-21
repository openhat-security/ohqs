package selfinstall

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

func ExeName() string {
	if runtime.GOOS == "windows" {
		return "ohqs.exe"
	}
	return "ohqs"
}

func PathEnv(root string) string {
	parts := []string{
		filepath.Join(root, "bin"),
		filepath.Join(root, "bin", "tools"),
	}
	if g := goBin(); g != "" {
		parts = append(parts, g)
	}
	if p := os.Getenv("PATH"); p != "" {
		parts = append(parts, p)
	}
	return strings.Join(parts, string(os.PathListSeparator))
}

func Destinations(root string) []string {
	seen := map[string]bool{}
	var out []string
	add := func(dir string) {
		if dir == "" {
			return
		}
		dir = filepath.Clean(dir)
		if seen[dir] || isSystemBin(dir) {
			return
		}
		seen[dir] = true
		out = append(out, filepath.Join(dir, ExeName()))
	}
	add(filepath.Join(root, "bin", "tools"))
	add(goBin())
	home, _ := os.UserHomeDir()
	if home != "" {
		add(filepath.Join(home, ".local", "bin"))
	}
	for _, dir := range []string{"/opt/homebrew/bin", "/usr/local/bin"} {
		if writableDir(dir) {
			add(dir)
		}
	}
	return out
}

func Install(root string) ([]string, error) {
	src, err := os.Executable()
	if err != nil {
		return nil, err
	}
	if resolved, err := filepath.EvalSymlinks(src); err == nil {
		src = resolved
	}
	var wrote []string
	for _, dest := range Destinations(root) {
		if sameFile(src, dest) {
			wrote = append(wrote, dest)
			continue
		}
		if err := copyExe(src, dest); err != nil {
			return wrote, fmt.Errorf("%s: %w", dest, err)
		}
		wrote = append(wrote, dest)
	}
	return wrote, nil
}

func goBin() string {
	if v := strings.TrimSpace(os.Getenv("GOBIN")); v != "" {
		return v
	}
	out, err := exec.Command("go", "env", "GOBIN").Output()
	if err == nil {
		if v := strings.TrimSpace(string(out)); v != "" {
			return v
		}
	}
	out, err = exec.Command("go", "env", "GOPATH").Output()
	if err != nil {
		return ""
	}
	gp := strings.TrimSpace(string(out))
	if gp == "" {
		return ""
	}
	if i := strings.IndexByte(gp, filepath.ListSeparator); i >= 0 {
		gp = gp[:i]
	}
	return filepath.Join(gp, "bin")
}

func copyExe(src, dest string) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dest + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		_ = os.Remove(tmp)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(tmp)
		return closeErr
	}
	if err := os.Rename(tmp, dest); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Chmod(dest, 0o755)
}

func sameFile(a, b string) bool {
	ai, err := os.Stat(a)
	if err != nil {
		return false
	}
	bi, err := os.Stat(b)
	if err != nil {
		return false
	}
	return os.SameFile(ai, bi)
}

func writableDir(dir string) bool {
	if dir == "" || isSystemBin(dir) {
		return false
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return false
	}
	f, err := os.CreateTemp(dir, ".ohqs-write-*")
	if err != nil {
		return false
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	return true
}

func isSystemBin(dir string) bool {
	switch filepath.Clean(dir) {
	case "/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/local/sbin":
		return true
	default:
		return false
	}
}
