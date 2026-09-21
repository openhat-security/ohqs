package browser

import (
	"testing"

	"github.com/openhat/quick-start/internal/catalog"
)

func TestStoreURLs(t *testing.T) {
	recs := []catalog.Record{
		{ID: "foxy", Kind: "extension", StoreFirefox: "https://addons.mozilla.org/foxy", StoreChromium: "https://chromewebstore.google.com/foxy"},
		{ID: "pwnfox", Kind: "extension", StoreFirefox: "https://addons.mozilla.org/pwnfox"},
		{ID: "gitleaks", Kind: "tool", StoreFirefox: "https://example.invalid"},
	}
	ff := StoreURLs(recs, "firefox")
	if len(ff) != 2 {
		t.Fatalf("firefox urls %v", ff)
	}
	cr := StoreURLs(recs, "chromium")
	if len(cr) != 1 || cr[0] != "https://chromewebstore.google.com/foxy" {
		t.Fatalf("chromium urls %v", cr)
	}
}

func TestPlanRecords(t *testing.T) {
	got := PlanRecords([][]catalog.Record{
		{{ID: "foxyproxy", Kind: "extension"}, {ID: "gitleaks", Kind: "tool"}},
		{{ID: "foxyproxy", Kind: "extension"}, {ID: "pwnfox", Kind: "extension"}},
	})
	if len(got) != 2 {
		t.Fatalf("got %d", len(got))
	}
}
