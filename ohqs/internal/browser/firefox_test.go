package browser

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/openhat/quick-start/internal/catalog"
)

func TestPoliciesJSON(t *testing.T) {
	b, err := policiesJSON([]catalog.Record{
		{ID: "foxyproxy", AddonID: "foxyproxy@eric.h.jung", XPIURL: "https://example.test/foxy.xpi"},
		{ID: "skip", Kind: "extension"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatal(err)
	}
	pol := doc["policies"].(map[string]any)
	ext := pol["ExtensionSettings"].(map[string]any)
	if _, ok := ext["foxyproxy@eric.h.jung"]; !ok {
		t.Fatalf("missing addon: %s", b)
	}
	if _, ok := ext[""]; ok {
		t.Fatal("empty addon id")
	}
}

func TestXPIRecordsDedup(t *testing.T) {
	got := xpiRecords([]catalog.Record{
		{AddonID: "a", XPIURL: "u"},
		{AddonID: "a", XPIURL: "u2"},
		{AddonID: "b", XPIURL: "v"},
	})
	if len(got) != 2 {
		t.Fatalf("got %d", len(got))
	}
}

func TestCatalogXPIFields(t *testing.T) {
	root, err := catalog.FindRoot("../..")
	if err != nil {
		t.Fatal(err)
	}
	cat, err := catalog.Load(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"foxyproxy", "pwnfox", "cookie-editor"} {
		rec, ok := cat.ByID[id]
		if !ok || rec.AddonID == "" || rec.XPIURL == "" {
			t.Fatalf("%s missing addon_id/xpi_url", id)
		}
	}
}

func TestFirefoxReadyRejectsPartialBundle(t *testing.T) {
	root := t.TempDir()
	bin := firefoxBinary(root)
	if err := os.MkdirAll(filepath.Dir(bin), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bin, []byte("not-firefox"), 0o755); err != nil {
		t.Fatal(err)
	}
	if firefoxReady(root) {
		t.Fatal("partial bundle must not be ready")
	}
}

func TestMountPointFromPlist(t *testing.T) {
	plist := `<?xml version="1.0"?>
<dict>
  <key>mount-point</key>
  <string>/Volumes/Firefox</string>
</dict>`
	if p := mountPointFromPlist(plist); p != "/Volumes/Firefox" {
		t.Fatalf("got %q", p)
	}
}
