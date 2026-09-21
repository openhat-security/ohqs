package browser

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/openhat/quick-start/internal/catalog"
)

type Found struct {
	ID     string
	Name   string
	Family string // firefox | chromium
	Bin    string
}

type Result struct {
	Browser  string   `json:"browser"`
	Family   string   `json:"family"`
	Binary   string   `json:"binary"`
	Profile  string   `json:"profile"`
	Launcher string   `json:"launcher"`
	URLs     []string `json:"urls"`
	Note     string   `json:"note"`
}

func Detect() []Found {
	var out []Found
	for _, c := range candidates() {
		if _, err := os.Stat(c.Bin); err == nil {
			out = append(out, c)
			continue
		}
		if p, err := exec.LookPath(filepath.Base(c.Bin)); err == nil {
			c.Bin = p
			out = append(out, c)
		}
	}
	return out
}

func candidates() []Found {
	switch runtime.GOOS {
	case "darwin":
		return []Found{
			{ID: "firefox", Name: "Firefox", Family: "firefox", Bin: "/Applications/Firefox.app/Contents/MacOS/firefox"},
			{ID: "waterfox", Name: "Waterfox", Family: "firefox", Bin: "/Applications/Waterfox.app/Contents/MacOS/waterfox"},
			{ID: "chrome", Name: "Google Chrome", Family: "chromium", Bin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"},
			{ID: "brave", Name: "Brave", Family: "chromium", Bin: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"},
			{ID: "edge", Name: "Microsoft Edge", Family: "chromium", Bin: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"},
		}
	case "windows":
		return []Found{
			{ID: "firefox", Name: "Firefox", Family: "firefox", Bin: `C:\Program Files\Mozilla Firefox\firefox.exe`},
			{ID: "chrome", Name: "Google Chrome", Family: "chromium", Bin: `C:\Program Files\Google\Chrome\Application\chrome.exe`},
			{ID: "edge", Name: "Microsoft Edge", Family: "chromium", Bin: `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`},
			{ID: "brave", Name: "Brave", Family: "chromium", Bin: `C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe`},
		}
	default:
		return []Found{
			{ID: "firefox", Name: "Firefox", Family: "firefox", Bin: "firefox"},
			{ID: "waterfox", Name: "Waterfox", Family: "firefox", Bin: "waterfox"},
			{ID: "chrome", Name: "Google Chrome", Family: "chromium", Bin: "google-chrome"},
			{ID: "chromium", Name: "Chromium", Family: "chromium", Bin: "chromium"},
			{ID: "brave", Name: "Brave", Family: "chromium", Bin: "brave-browser"},
		}
	}
}

func Pick(want string) (Found, error) {
	return pickFrom(want, Detect())
}

func pickFrom(want string, found []Found) (Found, error) {
	want = strings.ToLower(strings.TrimSpace(want))
	if len(found) == 0 {
		return Found{}, fmt.Errorf("no Firefox/Chrome/Brave/Edge/Waterfox binary found")
	}
	if want == "" || want == "auto" {
		return found[0], nil
	}
	for _, f := range found {
		if f.ID == want {
			return f, nil
		}
	}
	fam := familyOf(want)
	for _, f := range found {
		if f.Family == fam {
			return f, nil
		}
	}
	return Found{}, fmt.Errorf("browser %q not installed (found: %s)", want, names(found))
}

func familyOf(id string) string {
	switch id {
	case "firefox", "waterfox":
		return "firefox"
	case "chrome", "chromium", "brave", "edge":
		return "chromium"
	default:
		return id
	}
}

func names(fs []Found) string {
	var s []string
	for _, f := range fs {
		s = append(s, f.ID)
	}
	return strings.Join(s, ", ")
}

func DefaultRecords(cat *catalog.Catalog) []catalog.Record {
	var out []catalog.Record
	for _, id := range []string{"foxyproxy", "pwnfox", "cookie-editor"} {
		if rec, ok := cat.ByID[id]; ok {
			out = append(out, rec)
		}
	}
	return out
}

func PlanRecords(planSteps [][]catalog.Record) []catalog.Record {
	seen := map[string]bool{}
	var out []catalog.Record
	for _, tools := range planSteps {
		for _, t := range tools {
			if t.Kind != "extension" || seen[t.ID] {
				continue
			}
			seen[t.ID] = true
			out = append(out, t)
		}
	}
	return out
}

func StoreURLs(recs []catalog.Record, family string) []string {
	seen := map[string]bool{}
	var urls []string
	add := func(u string) {
		if u == "" || seen[u] {
			return
		}
		seen[u] = true
		urls = append(urls, u)
	}
	for _, rec := range recs {
		if rec.Kind != "extension" {
			continue
		}
		switch family {
		case "firefox":
			add(rec.StoreFirefox)
			if rec.StoreFirefox == "" && strings.Contains(rec.Homepage, "addons.mozilla.org") {
				add(rec.Homepage)
			}
		default:
			add(rec.StoreChromium)
			if rec.StoreChromium == "" && strings.Contains(rec.Homepage, "chromewebstore") {
				add(rec.Homepage)
			}
		}
	}
	return urls
}

func Setup(root string, recs []catalog.Record, launch bool) (*Result, error) {
	recs = mergeExt(recs, nil)
	profile := filepath.Join(root, "data", "browser-profiles", "ohqs")
	if err := os.MkdirAll(profile, 0o755); err != nil {
		return nil, err
	}
	if err := writeUserPrefs(profile); err != nil {
		return nil, err
	}

	var (
		bin    string
		family = "firefox"
		name   = "OHQS Browser"
		note   = "Extensions are force-installed in this sandbox. Daily Firefox/Chrome is untouched."
		err    error
	)
	if len(xpiRecords(recs)) > 0 {
		bin, err = EnsureFirefox(root, recs, os.Stderr)
		if err != nil {
			return nil, err
		}
		if !strings.Contains(bin, "OHQS Browser") && !strings.Contains(bin, "bin/browsers") {
			name = "Firefox"
			note = "Using system Firefox. Managed OHQS Browser was not available; AMO extensions may not auto-install."
		}
	} else if dirs := unpackedDirs(root, recs); len(dirs) > 0 {
		bin, err = systemChromium()
		if err != nil {
			return nil, err
		}
		family = "chromium"
		name = "Chromium"
		note = "Unpacked extensions loaded. Chrome Web Store items cannot be pre-installed."
	} else {
		bin, err = EnsureFirefox(root, recs, os.Stderr)
		if err != nil {
			return nil, err
		}
	}

	b := Found{ID: "ohqs", Name: name, Family: family, Bin: bin}
	launcher := filepath.Join(root, "bin", "tools", "ohqs-browser")
	if err := writeLauncher(launcher, b, profile); err != nil {
		return nil, err
	}
	res := &Result{
		Browser:  name,
		Family:   family,
		Binary:   bin,
		Profile:  profile,
		Launcher: launcher,
		Note:     note,
	}
	if launch {
		args := launchArgs(b, profile, unpackedDirs(root, recs))
		cmd := exec.Command(bin, args...)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Start(); err != nil {
			return res, fmt.Errorf("launch %s: %w", name, err)
		}
		_ = cmd.Process.Release()
	}
	return res, nil
}

func mergeExt(base, extra []catalog.Record) []catalog.Record {
	seen := map[string]bool{}
	var out []catalog.Record
	for _, rec := range append(base, extra...) {
		if rec.ID == "" || seen[rec.ID] {
			continue
		}
		seen[rec.ID] = true
		out = append(out, rec)
	}
	return out
}

func unpackedDirs(root string, recs []catalog.Record) []string {
	var out []string
	for _, rec := range recs {
		if rec.SubmodulePath == "" {
			continue
		}
		p := filepath.Join(root, rec.SubmodulePath)
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			out = append(out, p)
		}
	}
	return out
}

func systemChromium() (string, error) {
	for _, id := range []string{"chrome", "chromium", "brave", "edge"} {
		for _, c := range Detect() {
			if c.ID == id {
				return c.Bin, nil
			}
		}
	}
	return "", fmt.Errorf("no Chromium-family browser found for unpacked extensions")
}

func launchArgs(b Found, profile string, unpacked []string) []string {
	if b.Family == "firefox" {
		return []string{"--profile", profile, "--new-instance", "--no-remote"}
	}
	args := []string{"--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check"}
	if len(unpacked) > 0 {
		args = append(args, "--load-extension="+strings.Join(unpacked, ","))
	}
	return args
}

func writeLauncher(path string, b Found, profile string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	args := launchArgs(b, profile, nil)
	quoted := make([]string, len(args))
	for i, a := range args {
		quoted[i] = "'" + strings.ReplaceAll(a, "'", `'\''`) + "'"
	}
	body := "#!/usr/bin/env bash\nexec '" + strings.ReplaceAll(b.Bin, "'", `'\''`) + "' " + strings.Join(quoted, " ") + " \"$@\"\n"
	if runtime.GOOS == "windows" {
		path += ".cmd"
		var parts []string
		for _, a := range args {
			parts = append(parts, `"`+a+`"`)
		}
		body = "@echo off\r\n\"" + b.Bin + "\" " + strings.Join(parts, " ") + " %*\r\n"
	}
	return os.WriteFile(path, []byte(body), 0o755)
}
