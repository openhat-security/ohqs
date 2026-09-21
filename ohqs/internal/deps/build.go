package deps

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/openhat/quick-start/internal/catalog"
)

func inferBuild(rec catalog.Record, src string) string {
	if rec.Build != "" {
		return rec.Build
	}
	if rec.Kind == "guide" {
		return "data"
	}
	switch {
	case exists(filepath.Join(src, "go.mod")):
		return "go"
	case exists(filepath.Join(src, "Cargo.toml")):
		return "cargo"
	case exists(filepath.Join(src, "program", "nikto.pl")):
		return "perl"
	case exists(filepath.Join(src, "pyproject.toml")), exists(filepath.Join(src, "setup.py")), findPythonScript(src, rec) != "":
		return "python"
	default:
		return ""
	}
}

func buildFromSource(root string, rec catalog.Record, host Host, out io.Writer) error {
	src := filepath.Join(root, SourceRel(rec))
	kind := inferBuild(rec, src)
	bin := BinName(rec)
	switch kind {
	case "data":
		if !sourceReady(src) {
			return fmt.Errorf("source missing at %s", SourceRel(rec))
		}
		return nil
	case "go":
		if host.Go == "" {
			return fmt.Errorf("Go is not installed (https://go.dev/dl/)")
		}
		pkg := goPackage(src, rec, bin)
		dest := filepath.Join(host.Prefix, exeName(bin))
		return goBuild(src, dest, pkg, rec.GoExperiment, out)
	case "cargo":
		if host.Cargo == "" {
			return fmt.Errorf("Rust/cargo is not installed")
		}
		fmt.Fprintf(out, "  cargo build --release\n")
		cmd := exec.Command("cargo", "build", "--release")
		cmd.Dir = src
		cmd.Stdout = out
		cmd.Stderr = out
		if err := cmd.Run(); err != nil {
			return err
		}
		built := filepath.Join(src, "target", "release", exeName(bin))
		if _, err := os.Stat(built); err != nil {
			built = filepath.Join(src, "target", "release", bin)
		}
		return copyFile(built, filepath.Join(host.Prefix, exeName(bin)))
	case "python":
		if host.Python3 == "" {
			return fmt.Errorf("python3 is not installed")
		}
		script := findPythonScript(src, rec)
		if script == "" {
			return fmt.Errorf("no python entrypoint in %s", SourceRel(rec))
		}
		return writeShim(filepath.Join(host.Prefix, bin), pythonExec(script))
	case "perl":
		if host.Perl == "" {
			return fmt.Errorf("perl is not installed")
		}
		script := filepath.Join(src, "program", "nikto.pl")
		if _, err := os.Stat(script); err != nil {
			return err
		}
		return writeShim(filepath.Join(host.Prefix, bin), "perl "+quote(script))
	case "manual", "":
		return fmt.Errorf("no source build for %s", rec.ID)
	default:
		return fmt.Errorf("unknown build %q", kind)
	}
}

func goBuild(src, dest, pkg, experiment string, out io.Writer) error {
	var buf strings.Builder
	w := io.MultiWriter(out, &buf)
	if experiment != "" {
		fmt.Fprintf(out, "  GOEXPERIMENT=%s go build -o %s %s\n", experiment, dest, pkg)
	} else {
		fmt.Fprintf(out, "  go build -o %s %s\n", dest, pkg)
	}
	cmd := exec.Command("go", "build", "-o", dest, pkg)
	cmd.Dir = src
	cmd.Stdout = w
	cmd.Stderr = w
	if experiment != "" {
		cmd.Env = append(os.Environ(), "GOEXPERIMENT="+experiment)
	}
	err := cmd.Run()
	if err == nil {
		return nil
	}
	if experiment != "jsonv2" && needsJSONV2(buf.String()) {
		fmt.Fprintf(out, "  retry with GOEXPERIMENT=jsonv2 (this Go hides encoding/json/v2 otherwise)\n")
		return goBuild(src, dest, pkg, "jsonv2", out)
	}
	return err
}

func needsJSONV2(log string) bool {
	return strings.Contains(log, "encoding/json/v2") || strings.Contains(log, "encoding/json/jsontext")
}

func goPackage(src string, rec catalog.Record, bin string) string {
	for _, name := range []string{bin, rec.ID} {
		dir := filepath.Join(src, "cmd", name)
		if ents, err := os.ReadDir(dir); err == nil {
			for _, e := range ents {
				if strings.HasSuffix(e.Name(), ".go") {
					return "./cmd/" + name
				}
			}
		}
	}
	return "."
}

func findPythonScript(src string, rec catalog.Record) string {
	candidates := []string{
		filepath.Join(src, rec.ID+".py"),
		filepath.Join(src, BinName(rec)+".py"),
		filepath.Join(src, "sqlmap.py"),
		filepath.Join(src, "dirsearch.py"),
		filepath.Join(src, "jwt_tool.py"),
		filepath.Join(src, rec.ID, rec.ID+".py"),
	}
	for _, p := range candidates {
		if exists(p) {
			return p
		}
	}
	return ""
}

func pythonExec(script string) string {
	for _, c := range pythonCmd() {
		if _, err := exec.LookPath(c[0]); err == nil {
			return strings.Join(append(c, quote(script)), " ")
		}
	}
	return "python3 " + quote(script)
}

func writeShim(dest, execLine string) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		return os.WriteFile(dest+".cmd", []byte("@echo off\r\n"+execLine+" %*\r\n"), 0o755)
	}
	body := "#!/usr/bin/env bash\nexec " + execLine + " \"$@\"\n"
	return os.WriteFile(dest, []byte(body), 0o755)
}

func quote(p string) string {
	if runtime.GOOS == "windows" {
		return `"` + p + `"`
	}
	return `'` + strings.ReplaceAll(p, `'`, `'\''`) + `'`
}

func copyFile(src, dest string) error {
	in, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	mode := os.FileMode(0o755)
	if runtime.GOOS == "windows" {
		mode = 0o644
	}
	return os.WriteFile(dest, in, mode)
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
