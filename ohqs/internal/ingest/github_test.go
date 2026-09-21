package ingest

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestGitHubSearchRepos(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/search/repositories" {
			http.NotFound(w, r)
			return
		}
		body := `{
			"total_count": 2,
			"items": [
				{"full_name": "projectdiscovery/nuclei", "html_url": "https://github.com/projectdiscovery/nuclei",
				 "description": "Fast and customizable vulnerability scanner.", "topics": ["security", "red-team"],
				 "stargazers_count": 22000, "archived": false, "language": "Go"},
				{"full_name": "C2 ltd/Implant", "html_url": "https://github.com/c2ltd/implant",
				 "description": "", "topics": ["c2"], "stargazers_count": 5, "archived": true, "language": "Go"}
			]
		}`
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	g := GitHubSource{BaseURL: srv.URL}
	recs, err := g.SearchRepos(context.Background(), "topic:red-team", true, 10)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(recs) != 1 {
		t.Fatalf("want 1 non-archived, got %d: %+v", len(recs), recs)
	}
	r := recs[0]
	if r.ID != "projectdiscovery-nuclei" {
		t.Errorf("slug id: got %q", r.ID)
	}
	if r.Homepage != "https://github.com/projectdiscovery/nuclei" {
		t.Errorf("homepage: %q", r.Homepage)
	}
	if !strings.Contains(r.Summary, "vulnerability scanner") {
		t.Errorf("summary: %q", r.Summary)
	}
	found := false
	for _, tg := range r.Tags {
		if tg == "red-team" {
			found = true
		}
	}
	if !found {
		t.Errorf("topics not carried into tags: %v", r.Tags)
	}
}

func TestGitHubSearchRateLimitRetry(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.Header().Set("x-ratelimit-reset", fmt.Sprintf("%d", time.Now().Add(3*time.Second).Unix()))
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"total_count":0,"items":[]}`))
	}))
	defer srv.Close()

	g := GitHubSource{BaseURL: srv.URL, Token: "t"}
	if _, err := g.SearchRepos(context.Background(), "topic:x", true, 10); err != nil {
		t.Fatalf("search with retry: %v", err)
	}
}

func TestGitHubSearchAllTopicsDedupes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("q")
		name := strings.TrimPrefix(strings.TrimPrefix(q, "topic:"), `"`)
		name = strings.TrimSuffix(name, `"`)
		if name == "" {
			name = "recon-extra"
		}
		body := `{"total_count":1,"items":[{"full_name": "` + name + `/repo", "html_url": "https://github.com/` + name + `/repo",
			"description": "", "topics": [], "archived": false, "language": ""}]}`
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	g := GitHubSource{BaseURL: srv.URL}
	recs, err := g.SearchAllTopics(context.Background(), true, 5, 0)
	if err != nil {
		t.Fatalf("all topics: %v", err)
	}
	// Each topic query returns one repo with a distinct homepage, so dedupe must keep them.
	if len(recs) != len(RecommendTopicQueries) {
		t.Fatalf("want %d unique repos, got %d", len(RecommendTopicQueries), len(recs))
	}
}
