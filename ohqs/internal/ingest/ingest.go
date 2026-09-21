// Package ingest pulls curated tool lists (awesome-* READMEs and similar)
// into catalog.Record drafts so an operator can bulk-add a source in one
// go. Output lands in catalog/ingested.yaml for review; catalog.Load already
// indexes that file, so a fresh build picks the records up immediately.
package ingest

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/openhat/quick-start/internal/catalog"
)

// Entry is one parsed "- [label](url) — description" list item.
type Entry struct {
	Label string
	URL   string
	Desc  string
}

// KnownSources maps a short name to a raw markdown list URL.
var KnownSources = map[string]string{
	"awesome-web-security": "https://raw.githubusercontent.com/qazbnm456/awesome-web-security/master/README.md",
	"awesome-hacking":      "https://raw.githubusercontent.com/carpedm20/awesome-hacking/master/README.md",
	"awesome-pentest":      "https://raw.githubusercontent.com/enaqx/awesome-pentest/master/README.md",
	"awesome-recon":        "https://raw.githubusercontent.com/jhangj/awesome-recon/master/README.md",
	"android-security":     "https://raw.githubusercontent.com/ashishb/android-security-awesome/master/README.md",
	"awesome-osint":        "https://raw.githubusercontent.com/jivoi/awesome-osint/master/README.md",
}

var itemRe = regexp.MustCompile(`(?m)^\s*\*\s*\[([^\]]+)\]\((https?://[^)\s]+)\)(?:\s*[—-]\s*(.*))?$`)

// Fetch downloads a raw list. It rejects pages that do not look like markdown.
func Fetch(ctx context.Context, rawURL string) (string, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", fmt.Errorf("bad url: %w", err)
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return "", fmt.Errorf("unsupported scheme %q", u.Scheme)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "ohqs-ingest/1.0")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fetch %s: %s", rawURL, resp.Status)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return "", err
	}
	body := string(b)
	if !strings.Contains(body, "http") {
		return "", fmt.Errorf("%s did not return a link list", rawURL)
	}
	return body, nil
}

// Parse extracts "- [label](url) — desc" items. Lines using "* -" or plain "-"
// are also accepted because awesome lists use all three spellings.
func Parse(md string) []Entry {
	var out []Entry
	for _, m := range itemRe.FindAllStringSubmatch(md, -1) {
		label := strings.TrimSpace(m[1])
		link := strings.TrimSpace(m[2])
		if label == "" || link == "" {
			continue
		}
		desc := strings.TrimSpace(m[3])
		out = append(out, Entry{Label: label, URL: link, Desc: desc})
	}
	return out
}

// Build converts entries into record drafts: slugged id, guessed kind, summary
// from the description, homepage set. Entries whose label/name is too vague
// (e.g. just "github") are dropped.
func Build(es []Entry, defaultKind string) []catalog.Record {
	seenURL := map[string]bool{}
	seenID := map[string]int{}
	var out []catalog.Record
	for _, e := range es {
		u := normalizeURL(e.URL)
		if u == "" || seenURL[u] {
			continue
		}
		if len(e.Label) > 64 || len(e.Label) < 2 {
			continue
		}
		id := slug(e.Label)
		if id == "" {
			continue
		}
		n := seenID[id] + 1
		seenID[id] = n
		if n > 1 {
			id = fmt.Sprintf("%s-%d", id, n)
		}
		kind := defaultKind
		if k := guessKind(e.URL); k != "" {
			kind = k
		}
		seenURL[u] = true
		out = append(out, catalog.Record{
			ID:       id,
			Name:     e.Label,
			Kind:     kind,
			Summary:  firstSentence(e.Desc),
			Tags:     []string{},
			Homepage: u,
		})
	}
	return out
}

// Merge filters drafts that already exist in the catalog (by id or homepage).
// It returns the new records and a count of duplicates skipped.
func Merge(cat *catalog.Catalog, drafts []catalog.Record) ([]catalog.Record, int) {
	have := map[string]bool{}
	for _, r := range cat.Records {
		have[r.ID] = true
		if u := normalizeURL(r.Homepage); u != "" {
			have["url:"+u] = true
		}
	}
	var out []catalog.Record
	skipped := 0
	for _, d := range drafts {
		if have[d.ID] || have["url:"+normalizeURL(d.Homepage)] {
			skipped++
			continue
		}
		out = append(out, d)
	}
	return out, skipped
}

// firstSentence keeps the description short for the summary field.
func firstSentence(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if i := strings.IndexAny(s, ".;"); i > 0 && i < 200 {
		s = s[:i]
	}
	if len(s) > 200 {
		s = s[:200] + "…"
	}
	return strings.TrimSpace(s)
}

func normalizeURL(u string) string {
	u = strings.TrimSpace(u)
	if u == "" {
		return ""
	}
	parsed, err := url.Parse(u)
	if err != nil {
		return ""
	}
	parsed.Fragment = ""
	parsed.RawQuery = ""
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	parsed.Host = strings.ToLower(parsed.Host)
	s := strings.TrimRight(parsed.String(), "/")
	if s == "https://github.com" || s == "http://github.com" {
		return ""
	}
	return s
}

func guessKind(u string) string {
	low := strings.ToLower(u)
	switch {
	case strings.Contains(low, "chromewebstore"), strings.Contains(low, "addons.mozilla.org"):
		return "extension"
	case strings.Contains(low, "github.com/"):
		// Heuristic: os-like names get os, everything else stays tool.
		last := low[strings.LastIndex(low, "/")+1:]
		if strings.Contains(last, "os") && (strings.Contains(low, "kali") || strings.Contains(low, "parrot") || strings.Contains(low, "commando")) {
			return "os"
		}
	}
	return ""
}

func slug(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	lastDash := false
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			lastDash = false
		case strings.ContainsRune(" -_.", r):
			if !lastDash && b.Len() > 0 {
				b.WriteByte('-')
				lastDash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}
