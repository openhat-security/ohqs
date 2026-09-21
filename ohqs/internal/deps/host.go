package deps

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

type Host struct {
	GOOS    string `json:"goos"`
	GOARCH  string `json:"goarch"`
	Name    string `json:"name"`
	Distro  string `json:"distro,omitempty"`
	Prefix  string `json:"prefix"`
	Git     string `json:"git,omitempty"`
	Go      string `json:"go,omitempty"`
	Cargo   string `json:"cargo,omitempty"`
	Python3 string `json:"python3,omitempty"`
	Perl    string `json:"perl,omitempty"`
}

func Detect(root string) Host {
	h := Host{
		GOOS:   runtime.GOOS,
		GOARCH: runtime.GOARCH,
		Name:   osName(runtime.GOOS),
		Prefix: Prefix(root),
	}
	if runtime.GOOS == "linux" {
		h.Distro = linuxDistro()
	}
	h.Git = toolVersion("git", "version")
	h.Go = toolVersion("go", "version")
	h.Cargo = toolVersion("cargo", "--version")
	h.Python3 = pythonVersion()
	h.Perl = toolVersion("perl", "-v")
	return h
}

func Prefix(root string) string {
	return filepath.Join(root, "bin", "tools")
}

func osName(goos string) string {
	switch goos {
	case "darwin":
		return "macOS"
	case "windows":
		return "Windows"
	case "linux":
		return "Linux"
	default:
		return goos
	}
}

func linuxDistro() string {
	b, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return ""
	}
	var id, pretty string
	for _, line := range strings.Split(string(b), "\n") {
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		v = strings.Trim(v, `"'`)
		switch k {
		case "ID":
			id = v
		case "PRETTY_NAME":
			pretty = v
		}
	}
	if pretty != "" {
		return pretty
	}
	return id
}

func toolVersion(name string, arg string) string {
	path, err := exec.LookPath(name)
	if err != nil {
		return ""
	}
	out, err := exec.Command(path, arg).CombinedOutput()
	if err != nil {
		return path
	}
	line := strings.TrimSpace(strings.SplitN(string(out), "\n", 2)[0])
	if line == "" {
		return path
	}
	return line
}

func pythonVersion() string {
	for _, c := range pythonCmd() {
		if _, err := exec.LookPath(c[0]); err == nil {
			out, err := exec.Command(c[0], append(c[1:], "--version")...).CombinedOutput()
			if err == nil {
				return strings.TrimSpace(string(out))
			}
		}
	}
	return ""
}

func pythonCmd() [][]string {
	if runtime.GOOS == "windows" {
		return [][]string{{"py", "-3"}, {"python"}, {"python3"}}
	}
	return [][]string{{"python3"}, {"python"}}
}

func (h Host) Supported(platforms []string) bool {
	if len(platforms) == 0 {
		return true
	}
	for _, p := range platforms {
		if p == h.GOOS {
			return true
		}
	}
	return false
}
