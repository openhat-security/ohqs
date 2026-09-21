package browser

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/openhat/quick-start/internal/catalog"
)

var fetchMu sync.Mutex

const (
	bundleName = "OHQS Browser.app"
	bundleID   = "com.openhat.ohqs.browser"
)

func firefoxHome(root string) string {
	return filepath.Join(root, "bin", "browsers", "firefox")
}

func firefoxBinary(root string) string {
	home := firefoxHome(root)
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, bundleName, "Contents", "MacOS", "firefox")
	case "windows":
		return filepath.Join(home, "firefox.exe")
	default:
		return filepath.Join(home, "firefox", "firefox")
	}
}

func policiesPath(root string) string {
	home := firefoxHome(root)
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, bundleName, "Contents", "Resources", "distribution", "policies.json")
	case "windows":
		return filepath.Join(home, "distribution", "policies.json")
	default:
		return filepath.Join(home, "firefox", "distribution", "policies.json")
	}
}

func xpiRecords(recs []catalog.Record) []catalog.Record {
	var out []catalog.Record
	seen := map[string]bool{}
	for _, rec := range recs {
		if rec.AddonID == "" || rec.XPIURL == "" || seen[rec.AddonID] {
			continue
		}
		seen[rec.AddonID] = true
		out = append(out, rec)
	}
	return out
}

func policiesJSON(recs []catalog.Record) ([]byte, error) {
	ext := map[string]map[string]string{}
	for _, rec := range xpiRecords(recs) {
		ext[rec.AddonID] = map[string]string{
			"installation_mode": "force_installed",
			"install_url":       rec.XPIURL,
		}
	}
	doc := map[string]any{
		"policies": map[string]any{
			"DontCheckDefaultBrowser": true,
			"DisableAppUpdate":        true,
			"OverrideFirstRunPage":    "",
			"OverridePostUpdatePage":  "",
			"ExtensionSettings":       ext,
		},
	}
	return json.MarshalIndent(doc, "", "  ")
}

func writePolicies(root string, recs []catalog.Record) error {
	path := policiesPath(root)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, err := policiesJSON(recs)
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o644)
}

func writeUserPrefs(profile string) error {
	if err := os.MkdirAll(profile, 0o755); err != nil {
		return err
	}
	body := `user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("trailhead.firstrun.didSeeAboutWelcome", true);
user_pref("browser.aboutwelcome.enabled", false);
`
	return os.WriteFile(filepath.Join(profile, "user.js"), []byte(body), 0o644)
}

func firefoxReady(root string) bool {
	bin := firefoxBinary(root)
	if _, err := os.Stat(bin); err != nil {
		return false
	}
	home := firefoxHome(root)
	var need []string
	switch runtime.GOOS {
	case "darwin":
		base := filepath.Join(home, bundleName, "Contents")
		need = []string{
			filepath.Join(base, "MacOS", "libmozglue.dylib"),
			filepath.Join(base, "MacOS", "XUL"),
			filepath.Join(base, "Resources", "omni.ja"),
		}
	case "windows":
		need = []string{
			filepath.Join(home, "xul.dll"),
			filepath.Join(home, "omni.ja"),
		}
	default:
		need = []string{
			filepath.Join(home, "firefox", "libxul.so"),
			filepath.Join(home, "firefox", "omni.ja"),
		}
	}
	for _, p := range need {
		if _, err := os.Stat(p); err != nil {
			return false
		}
	}
	return true
}

func EnsureFirefox(root string, recs []catalog.Record, log io.Writer) (string, error) {
	if log == nil {
		log = io.Discard
	}
	fetchMu.Lock()
	defer fetchMu.Unlock()

	if !firefoxReady(root) {
		if _, err := os.Stat(firefoxBinary(root)); err == nil {
			fmt.Fprintln(log, "ohqs: managed Firefox is incomplete (missing XUL/omni.ja); re-downloading")
			_ = os.RemoveAll(filepath.Join(firefoxHome(root), bundleName))
			if runtime.GOOS != "darwin" {
				_ = os.RemoveAll(filepath.Join(firefoxHome(root), "firefox"))
			}
		} else {
			fmt.Fprintln(log, "ohqs: downloading Firefox for the isolated test browser (one-time)")
		}
		if err := fetchFirefox(root, log); err != nil {
			if fallback := systemFirefox(); fallback != "" {
				fmt.Fprintf(log, "ohqs: managed Firefox failed (%v); using system Firefox\n", err)
				return fallback, nil
			}
			return "", fmt.Errorf("firefox: %w", err)
		}
		if !firefoxReady(root) {
			if fallback := systemFirefox(); fallback != "" {
				fmt.Fprintln(log, "ohqs: managed Firefox still incomplete after download; using system Firefox")
				return fallback, nil
			}
			return "", fmt.Errorf("firefox: download finished but the app bundle is incomplete")
		}
	}
	if err := writePolicies(root, recs); err != nil {
		return "", err
	}
	return firefoxBinary(root), nil
}

func systemFirefox() string {
	for _, c := range candidates() {
		if c.Family != "firefox" {
			continue
		}
		if _, err := os.Stat(c.Bin); err == nil {
			return c.Bin
		}
		if p, err := exec.LookPath(filepath.Base(c.Bin)); err == nil {
			return p
		}
	}
	return ""
}

func firefoxDownloadURL() string {
	osName := "linux64"
	switch runtime.GOOS {
	case "darwin":
		osName = "osx"
	case "windows":
		osName = "win64"
	default:
		if runtime.GOARCH == "arm64" {
			osName = "linux64-aarch64"
		}
	}
	return "https://download.mozilla.org/?product=firefox-latest-ssl&os=" + osName + "&lang=en-US"
}

func fetchFirefox(root string, log io.Writer) error {
	if err := os.MkdirAll(firefoxHome(root), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(firefoxHome(root), "firefox-dl-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	client := &http.Client{Timeout: 15 * time.Minute}
	req, err := http.NewRequest(http.MethodGet, firefoxDownloadURL(), nil)
	if err != nil {
		_ = tmp.Close()
		return err
	}
	req.Header.Set("User-Agent", "ohqs")
	resp, err := client.Do(req)
	if err != nil {
		_ = tmp.Close()
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_ = tmp.Close()
		return fmt.Errorf("download firefox: HTTP %s", resp.Status)
	}
	if _, err := io.Copy(tmp, resp.Body); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}

	name := strings.ToLower(resp.Request.URL.Path)
	switch {
	case runtime.GOOS == "darwin" || strings.HasSuffix(name, ".dmg"):
		return extractMacDMG(tmpName, root, log)
	case strings.HasSuffix(name, ".exe"):
		return fmt.Errorf("windows installer download is not supported; install Firefox or place firefox.exe in %s", firefoxHome(root))
	default:
		return extractTar(tmpName, firefoxHome(root))
	}
}

func extractMacDMG(dmg, root string, log io.Writer) error {
	mount, err := os.MkdirTemp("", "ohqs-firefox-dmg-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(mount)

	attach := exec.Command("hdiutil", "attach", "-nobrowse", "-readonly", "-mountpoint", mount, dmg)
	if out, err := attach.CombinedOutput(); err != nil {
		// Older hdiutil: fall back to default mount + plist parse.
		plist, err2 := exec.Command("hdiutil", "attach", "-nobrowse", "-readonly", "-plist", dmg).Output()
		if err2 != nil {
			return fmt.Errorf("hdiutil attach: %w (%s)", err, strings.TrimSpace(string(out)))
		}
		mount = mountPointFromPlist(string(plist))
		if mount == "" {
			return fmt.Errorf("could not find Firefox DMG mount point")
		}
	}
	defer func() { _ = exec.Command("hdiutil", "detach", mount, "-quiet", "-force").Run() }()

	src := filepath.Join(mount, "Firefox.app")
	if _, err := os.Stat(src); err != nil {
		matches, _ := filepath.Glob(filepath.Join(mount, "*.app"))
		if len(matches) == 0 {
			return fmt.Errorf("Firefox.app not in DMG")
		}
		src = matches[0]
	}
	dest := filepath.Join(firefoxHome(root), bundleName)
	_ = os.RemoveAll(dest)
	if out, err := exec.Command("ditto", src, dest).CombinedOutput(); err != nil {
		_ = os.RemoveAll(dest)
		return fmt.Errorf("copy Firefox.app: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	if _, err := os.Stat(filepath.Join(dest, "Contents", "MacOS", "XUL")); err != nil {
		_ = os.RemoveAll(dest)
		return fmt.Errorf("copy Firefox.app: incomplete bundle (missing XUL)")
	}
	_ = exec.Command("xattr", "-cr", dest).Run()
	if err := rebrandMacApp(dest); err != nil {
		return err
	}
	_ = exec.Command("codesign", "--force", "--deep", "--sign", "-", dest).Run()
	fmt.Fprintf(log, "ohqs: installed %s\n", dest)
	return nil
}

func mountPointFromPlist(plist string) string {
	for _, line := range strings.Split(plist, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "<string>/Volumes/") && strings.HasSuffix(line, "</string>") {
			return strings.TrimSuffix(strings.TrimPrefix(line, "<string>"), "</string>")
		}
	}
	return ""
}

func rebrandMacApp(app string) error {
	plist := filepath.Join(app, "Contents", "Info.plist")
	sets := [][]string{
		{"CFBundleName", bundleName[:strings.LastIndex(bundleName, ".app")]},
		{"CFBundleDisplayName", "OHQS Browser"},
		{"CFBundleIdentifier", bundleID},
	}
	for _, kv := range sets {
		cmd := exec.Command("plutil", "-replace", kv[0], "-string", kv[1], plist)
		if err := cmd.Run(); err != nil {
			_ = exec.Command("plutil", "-insert", kv[0], "-string", kv[1], plist).Run()
		}
	}
	return nil
}

func extractTar(archive, dest string) error {
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	cmd := exec.Command("tar", "-xf", archive, "-C", dest)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}
