// GitHub catalog crawling: search the GitHub Search API for security tool
// repos (by topic, query, or star threshold), map them onto catalog.Record
// drafts, and hand them to the same review flow as Markdown sources. Uses the
// GITHUB_TOKEN when set (higher rate limits); unauthenticated still works at
// the default 10 search requests/minute.
package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/openhat/quick-start/internal/catalog"
)

// GitHubSource holds the API endpoint and token for searching GitHub repos.
type GitHubSource struct {
	// BaseURL defaults to https://api.github.com. Tests override it.
	BaseURL string
	Token   string
}

// ghRepo is the minimal shape of a GitHub search result we care about.
type ghRepo struct {
	FullName    string   `json:"full_name"`
	HTMLURL     string   `json:"html_url"`
	Description string   `json:"description"`
	Topics      []string `json:"topics"`
	Stargazers  int      `json:"stargazers_count"`
	License     struct {
		SPDXID string `json:"spdx_id"`
	} `json:"license"`
	Homepage string `json:"homepage"`
	Archived bool   `json:"archived"`
	Language string `json:"language"`
}

type ghSearchResponse struct {
	TotalCount int      `json:"total_count"`
	Items      []ghRepo `json:"items"`
}

// RecommendTopicQueries are topics that map cleanly onto the existing catalog
// kinds: red/blue tooling, recon, web, mobile, cloud, OSINT, authz, etc. Used
// by `ohqs ingest github --all`.
var RecommendTopicQueries = []string{
	"topic:red-team",
	"topic:redteaming",
	"topic:offensive-security",
	"topic:penetration-testing",
	"topic:post-exploitation",
	"topic:c2",
	"topic:reconnaissance",
	"topic:web-security",
	"topic:mobile-security",
	"topic:cloud-security",
	"topic:osint",
	"topic:security-tools",
	"topic:vulnerability-scanners",
	"topic:exploit-development",
	"topic:network-security",
	"topic:secrets-management",
}

// SearchRepos runs one GitHub search query (sorted by stars descending) and
// returns record drafts. skipArchived filters archived repos out. Returns up to
// limit results; a token in GitHubSource raises the rate budget.
func (g *GitHubSource) SearchRepos(ctx context.Context, q string, skipArchived bool, limit int) ([]catalog.Record, error) {
	base := strings.TrimRight(g.BaseURL, "/")
	if base == "" {
		base = "https://api.github.com"
	}
	pageLimit := 100
	if limit > 0 && limit < pageLimit {
		pageLimit = limit
	}
	var records []catalog.Record
	for page := 1; page <= 10; page++ {
		if len(records) >= limit {
			break
		}
		reqQB := q
		if skipArchived {
			reqQB += " archived:false"
		}
		u := fmt.Sprintf("%s/search/repositories?q=%s&sort=stars&order=desc&per_page=%d&page=%d",
			base, url.QueryEscape(reqQB), pageLimit, page)
		resp, err := g.do(ctx, u)
		if err != nil {
			return records, err
		}
		var body ghSearchResponse
		if err := json.NewDecoder(io.LimitReader(resp, 8<<20)).Decode(&body); err != nil {
			return records, fmt.Errorf("decode search results: %w", err)
		}
		for _, r := range body.Items {
			if skipArchived && r.Archived {
				continue
			}
			rec, ok := ghToRecord(r)
			if ok {
				records = append(records, rec)
			}
			if len(records) >= limit {
				break
			}
		}
		if len(body.Items) < pageLimit || len(records) >= limit {
			break
		}
	}
	return records, nil
}

// SearchAllTopics runs each RecommendedTopicQuery and merges the drafts into
// one set, skipping known duplicates between queries (same repo appears once).
// limit caps the total returned.
func (g *GitHubSource) SearchAllTopics(ctx context.Context, skipArchived bool, perQuery, limit int) ([]catalog.Record, error) {
	seen := map[string]bool{}
	var all []catalog.Record
	for _, t := range RecommendTopicQueries {
		if limit > 0 && len(all) >= limit {
			break
		}
		recs, err := g.SearchRepos(ctx, t, skipArchived, perQuery)
		if err != nil {
			// Keep going; a single topic failing should not abort the crawl.
			continue
		}
		for _, r := range recs {
			if seen[r.Homepage] {
				continue
			}
			seen[r.Homepage] = true
			all = append(all, r)
		}
	}
	return all, nil
}

func (g *GitHubSource) do(ctx context.Context, rawURL string) (io.ReadCloser, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if g.Token != "" {
		req.Header.Set("Authorization", "Bearer "+g.Token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests {
		// Secondary rate limit — back off on the reset header.
		wait := 30 * time.Second
		if rl := resp.Header.Get("x-ratelimit-reset"); rl != "" {
			if ts, err := strconv.ParseInt(rl, 10, 64); err == nil {
				d := time.Until(time.Unix(ts, 0))
				if d > 0 {
					wait = d + time.Second
				}
			}
		}
		resp.Body.Close()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(wait):
		}
		// One retry.
		resp, err = http.DefaultClient.Do(req)
		if err != nil {
			return nil, err
		}
	}
	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("github search %s: %s: %s", u.Path, resp.Status, strings.TrimSpace(string(b)))
	}
	return resp.Body, nil
}

// ghToRecord converts a GitHub repo into a catalog draft: id from the repo
// slug, kind inferred from topics (red/post-exploitation/C2 → tool; osint →
// reconnaissance; guides/training → reference), tags copied from topics.
func ghToRecord(r ghRepo) (catalog.Record, bool) {
	if r.FullName == "" || r.HTMLURL == "" {
		return catalog.Record{}, false
	}
	slug := slug(r.FullName)
	if slug == "" {
		return catalog.Record{}, false
	}
	kind := "tool"
	for _, t := range r.Topics {
		lt := strings.ToLower(t)
		switch {
		case lt == "osint", lt == "reconnaissance", lt == "recon":
			kind = "tool"
		case lt == "blue-team", lt == "defensive-security", lt == "detection":
			kind = "tool"
		}
	}
	summary := strings.TrimSpace(r.Description)
	if summary == "" {
		summary = "GitHub repository: " + r.FullName
	}
	if len(summary) > 300 {
		summary = summary[:300] + "…"
	}
	lang := strings.TrimSpace(r.Language)
	tags := make([]string, 0, len(r.Topics)+1)
	tags = append(tags, r.Topics...)
	if lang != "" {
		tags = append(tags, strings.ToLower(lang))
	}
	if r.Archived {
		tags = append(tags, "archived")
	}
	return catalog.Record{
		ID:       slug,
		Name:     strings.TrimSuffix(strings.TrimPrefix(r.FullName, "/"), "/"),
		Kind:     kind,
		Summary:  summary,
		Tags:     tags,
		Homepage: r.HTMLURL,
	}, true
}

// sortByStars orders whole record sets by something stable; used by tests.
func sortRecordsByHomepage(recs []catalog.Record) {
	sort.Slice(recs, func(i, j int) bool { return recs[i].Homepage < recs[j].Homepage })
}
