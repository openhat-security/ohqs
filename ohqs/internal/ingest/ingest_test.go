package ingest

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	md := strings.Join([]string{
		"# Tools",
		"- [Burp Suite](https://portswigger.net/burp) - Web proxy for authorized testing",
		"* [sqlmap](https://github.com/sqlmapproject/sqlmap) — SQL injection",
		"- [Nuclei](https://github.com/projectdiscovery/nuclei)",
		"  no URL line should be ignored",
	}, "\n")
	es := Parse(md)
	if len(es) != 3 {
		t.Fatalf("want 3 entries, got %d", len(es))
	}
	if es[0].Label != "Burp Suite" || es[0].URL != "https://portswigger.net/burp" || es[0].Desc != "Web proxy for authorized testing" {
		t.Errorf("bad first entry: %+v", es[0])
	}
	if es[1].Desc != "SQL injection" {
		t.Errorf("bad desc for alternate bullet: %+v", es[1])
	}
}

func TestBuildDedupesURLs(t *testing.T) {
	md := "- [burp](https://PortSwigger.net/burp/) - one\n- [burp2](https://portswigger.net/burp) - dup\n- [nuclei](https://github.com/projectdiscovery/nuclei) - two\n"
	recs := Build(Parse(md), "tool")
	if len(recs) != 2 {
		t.Fatalf("want 2 (dedupe), got %d: %+v", len(recs), recs)
	}
	if recs[0].ID != "burp" || recs[0].Homepage != "https://portswigger.net/burp" {
		t.Errorf("bad normalized record: %+v", recs[0])
	}
	if recs[1].Kind != "tool" {
		t.Errorf("default kind not applied: %+v", recs[1])
	}
}

func TestGuessKind(t *testing.T) {
	if got := guessKind("https://chromewebstore.google.com/detail/foobar"); got != "extension" {
		t.Errorf("chrome store -> extension, got %q", got)
	}
	if got := guessKind("https://github.com/foo/bar-tool"); got != "" {
		t.Errorf("github tool should stay default, got %q", got)
	}
}

func TestFetch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("- [X](https://example.com/x) - desc\n"))
	}))
	defer srv.Close()
	got, err := Fetch(context.Background(), srv.URL)
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if !strings.Contains(got, "example.com") {
		t.Errorf("unexpected body: %q", got)
	}
	if _, err := Fetch(context.Background(), "not a url"); err == nil {
		t.Errorf("bad url should error")
	}
}
