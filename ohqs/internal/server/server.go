package server

import (
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/openhat/quick-start/internal/appconfig"
	"github.com/openhat/quick-start/internal/browser"
	"github.com/openhat/quick-start/internal/catalog"
	"github.com/openhat/quick-start/internal/deps"
	"github.com/openhat/quick-start/internal/export"
	"github.com/openhat/quick-start/internal/history"
	"github.com/openhat/quick-start/internal/index"
	"github.com/openhat/quick-start/internal/jobs"
	"github.com/openhat/quick-start/internal/llm"
	"github.com/openhat/quick-start/internal/models"
	"github.com/openhat/quick-start/internal/planner"
	"github.com/openhat/quick-start/internal/retrieve"
	"github.com/openhat/quick-start/internal/web"
)

// indexState owns the catalog + open index and serializes access to the store,
// so the browser UI can rebuild or re-download the index under the lock without
// clobbering a database another request is using.
type indexState struct {
	mu    sync.Mutex
	cat   *catalog.Catalog
	store *index.Store
	path  string
}

func newIndexState(cat *catalog.Catalog, store *index.Store) *indexState {
	return &indexState{
		cat:   cat,
		store: store,
		path:  filepath.Join(cat.Root, "data", "ohqs.sqlite"),
	}
}

// with runs fn while holding the lock; the store is never swapped underneath it.
func (s *indexState) with(fn func(st *index.Store)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn(s.store)
}

// setStore swaps the live store after a download, closing the old one. Caller
// must hold s.mu.
func (s *indexState) setStore(st *index.Store) {
	old := s.store
	s.store = st
	if old != nil {
		_ = old.Close()
	}
}

// indexStatus is the JSON shape of GET /v1/index.
type indexStatus struct {
	Exists     bool   `json:"exists"`
	Path       string `json:"path"`
	Records    int    `json:"records"`
	HasVectors bool   `json:"has_vectors"`
	Embedder   string `json:"embedder,omitempty"`
	ModTime    string `json:"mod_time,omitempty"`
}

// indexStatusResponse inspects the on-disk database with a short-lived read so
// the running server store is never disturbed.
func indexStatusResponse(iv *indexState) indexStatus {
	out := indexStatus{Path: iv.path}
	st, err := index.Open(iv.path)
	if err != nil {
		return out
	}
	defer st.Close()
	out.Exists = true
	out.Records, _ = st.RecordCount()
	out.HasVectors, _ = st.HasVectors()
	if out.HasVectors {
		out.Embedder, _ = st.VectorMeta()
	}
	if fi, err := os.Stat(iv.path); err == nil {
		out.ModTime = fi.ModTime().UTC().Format(time.RFC3339)
	}
	return out
}

func New(cat *catalog.Catalog, store *index.Store) http.Handler {
	tmpl, err := web.Templates()
	if err != nil {
		panic(err)
	}
	js := jobs.Open(cat.Root, filepath.Join(cat.Root, "data", "jobs"))
	hs := history.Open(filepath.Join(cat.Root, "data", "history"))
	iv := newIndexState(cat, store)
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Handle("/static/*", http.StripPrefix("/static/", web.Static()))
	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		page := pageLists(js, hs)
		page.Host = deps.Detect(cat.Root)
		if persisted, err := settingsConfig(cat).LoadLLM(); err == nil {
			page.OpenAIBaseURL = persisted.BaseURL
			page.OpenAIModel = persisted.Model
			page.OpenAIKeySet = strings.TrimSpace(persisted.APIKey) != "" ||
				strings.TrimSpace(llm.Resolve("", "", "").APIKey) != ""
		}
		if id := req.URL.Query().Get("job"); id != "" {
			attachJob(iv, js, &page, id)
		}
		if id := req.URL.Query().Get("history"); id != "" {
			attachHistory(iv, hs, &page, id)
		}
		render(w, tmpl, page)
	})
	r.Post("/", func(w http.ResponseWriter, req *http.Request) {
		saveLLMFromForm(cat, req)
		page := pageFromForm(req)
		page.Host = deps.Detect(cat.Root)
		if err := fillPlan(iv, &page); err != nil {
			page.Error = err.Error()
		} else {
			_, _ = hs.Add(history.SourceWeb, requestFromPage(page), page.Plan)
		}
		page.Jobs = js.List(8)
		page.History = hs.List(20)
		render(w, tmpl, page)
	})
	r.Post("/install", func(w http.ResponseWriter, req *http.Request) {
		startJob(w, tmpl, iv, js, hs, req, jobs.TypeInstall)
	})
	r.Post("/run", func(w http.ResponseWriter, req *http.Request) {
		startJob(w, tmpl, iv, js, hs, req, jobs.TypeRun)
	})
	r.Post("/deps", func(w http.ResponseWriter, req *http.Request) {
		page := pageFromForm(req)
		page.Host = deps.Detect(cat.Root)
		if err := fillPlan(iv, &page); err != nil {
			page.Error = err.Error()
		}
		applyLists(&page, js, hs)
		render(w, tmpl, page)
	})
	r.Post("/browser", func(w http.ResponseWriter, req *http.Request) {
		page := pageFromForm(req)
		page.Host = deps.Detect(cat.Root)
		recs := browser.DefaultRecords(cat)
		if err := fillPlan(iv, &page); err != nil {
			page.Error = err.Error()
		} else {
			recs = append(recs, planExt(page.Plan)...)
		}
		res, err := browser.Setup(cat.Root, recs, true)
		page.Browser = res
		if err != nil {
			page.Error = err.Error()
		}
		applyLists(&page, js, hs)
		render(w, tmpl, page)
	})
	r.Post("/export", func(w http.ResponseWriter, req *http.Request) {
		page := pageFromForm(req)
		persisted, _ := settingsConfig(cat).LoadLLM()
		var plan *planner.Plan
		var err error
		iv.with(func(st *index.Store) {
			plan, err = llm.Build(cat, st, requestFromPage(page), llm.ResolveWith(persisted, page.OpenAIBaseURL, "", page.OpenAIModel), nil)
		})
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="commands.sh"`)
		_, _ = w.Write([]byte(export.Script(plan, deps.Prefix(cat.Root))))
	})
	r.Get("/jobs/{id}", func(w http.ResponseWriter, req *http.Request) {
		v, err := js.View(chi.URLParam(req, "id"), 80<<10)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		writeJSON(w, v)
	})
	r.Post("/jobs/{id}/stop", func(w http.ResponseWriter, req *http.Request) {
		if err := js.Stop(chi.URLParam(req, "id")); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	r.Post("/jobs/{id}/resume", func(w http.ResponseWriter, req *http.Request) {
		if err := js.Resume(chi.URLParam(req, "id")); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("ok\n"))
	})
	r.Get("/v1/search", func(w http.ResponseWriter, req *http.Request) {
		q := req.URL.Query().Get("q")
		result := searchResult{Q: q}
		iv.with(func(st *index.Store) {
			result.Records, result.Source = retrieve.SituationRanked(req.Context(), cat, st, q, 20)
		})
		writeJSON(w, result)
	})
	r.Get("/v1/index", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, indexStatusResponse(iv))
	})
	r.Post("/v1/index/rebuild", func(w http.ResponseWriter, _ *http.Request) {
		var err error
		iv.with(func(st *index.Store) {
			err = st.Rebuild(cat)
		})
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeJSON(w, indexStatusResponse(iv))
	})
	r.Post("/v1/index/download", func(w http.ResponseWriter, req *http.Request) {
		if err := iv.download(req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeJSON(w, indexStatusResponse(iv))
	})
	r.Get("/v1/tools/{id}", func(w http.ResponseWriter, req *http.Request) {
		id := chi.URLParam(req, "id")
		rec, ok := cat.ByID[id]
		if !ok {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		writeJSON(w, rec)
	})
	r.Post("/v1/recommend", func(w http.ResponseWriter, req *http.Request) {
		var body struct {
			planner.Request
			OpenAIBaseURL string `json:"openai_base_url"`
			OpenAIAPIKey  string `json:"openai_api_key"`
			OpenAIModel   string `json:"openai_model"`
		}
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		persisted, _ := settingsConfig(cat).LoadLLM()
		var plan *planner.Plan
		var err error
		iv.with(func(st *index.Store) {
			plan, err = llm.Build(cat, st, body.Request, llm.ResolveWith(persisted, body.OpenAIBaseURL, body.OpenAIAPIKey, body.OpenAIModel), nil)
		})
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		_, _ = hs.Add(history.SourceAPI, body.Request, plan)
		writeJSON(w, plan)
	})
	r.Get("/v1/history", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, hs.List(50))
	})
	r.Get("/v1/models", func(w http.ResponseWriter, _ *http.Request) {
		h := models.Detect()
		writeJSON(w, modelsResponse{Host: h, Fits: models.Recommend(h, 6)})
	})
	// remoteModels lists the served models at a loopback OpenAI-compatible
	// endpoint so the UI can offer a real dropdown. Discovery is restricted to
	// local hosts; pointing the forms at a remote base URL still works for
	// generation, it just cannot be auto-discovered here.
	r.Get("/v1/models/remote", func(w http.ResponseWriter, req *http.Request) {
		base := strings.TrimSpace(req.URL.Query().Get("base"))
		items, note := discoverRemoteModels(base)
		writeJSON(w, remoteModelsResponse{Base: base, Items: items, Note: note})
	})
	r.Post("/v1/deps", func(w http.ResponseWriter, req *http.Request) {
		var body planner.Request
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		var plan *planner.Plan
		var err error
		iv.with(func(st *index.Store) {
			plan, err = planner.Build(cat, st, body)
		})
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeJSON(w, deps.Check(cat.Root, cat, plan))
	})
	return r
}

// searchResult wraps /v1/search records with the rank source so the UI can say
// "semantic (ollama nomic-embed-text)" vs "lexical".
type searchResult struct {
	Q       string           `json:"q"`
	Source  string           `json:"source"`
	Records []catalog.Record `json:"records"`
}

type modelsResponse struct {
	Host models.HostInfo         `json:"host"`
	Fits []models.Recommendation `json:"fits"`
}

type remoteModelsResponse struct {
	Base  string   `json:"base"`
	Items []string `json:"items"`
	Note  string   `json:"note,omitempty"`
}

// discoverRemoteModels lists model ids served at an OpenAI-compatible endpoint.
// Only loopback hosts are allowed (no SSRF from the browser UI). Returns the
// sorted ids plus a human note when discovery is skipped.
func discoverRemoteModels(base string) (ids []string, note string) {
	u, err := url.Parse(base)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, "enter a base URL like http://127.0.0.1:8001/v1 (local) to auto-fill the model list"
	}
	host := u.Hostname()
	if host != "127.0.0.1" && host != "localhost" && host != "::1" {
		return nil, "discovery is local-only; type the served model name for a remote endpoint"
	}
	endpoint := strings.TrimRight(base, "/") + "/models"
	client := &http.Client{Timeout: 6 * time.Second}
	resp, err := client.Get(endpoint)
	if err != nil {
		return nil, "no model server reachable at that base URL"
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Sprintf("model server returned %s", resp.Status)
	}
	var body struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body); err != nil {
		return nil, "endpoint did not answer /models as JSON"
	}
	seen := map[string]bool{}
	for _, m := range body.Data {
		if m.ID != "" {
			seen[m.ID] = true
		}
	}
	for id := range seen {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids, ""
}

// download fetches the release-built index into a temp file and swaps it in
// under the lock; the old store is closed only after the new one opens.
func (iv *indexState) download(req *http.Request) error {
	url := req.URL.Query().Get("url")
	if url == "" {
		url = "https://github.com/openhat/quick-start/releases/latest/download/ohqs-index.sqlite"
	}
	tmp := iv.path + ".tmp"
	if err := index.Fetch(url, tmp, 10*time.Minute); err != nil {
		return fmt.Errorf("download index: %w", err)
	}
	defer os.Remove(tmp)
	st, err := index.Open(tmp)
	if err != nil {
		return fmt.Errorf("downloaded index is not a valid database: %w", err)
	}
	if err := st.Close(); err != nil {
		return err
	}
	iv.mu.Lock()
	defer iv.mu.Unlock()
	if err := os.Rename(tmp, iv.path); err != nil {
		return err
	}
	nst, err := index.Open(iv.path)
	if err != nil {
		return err
	}
	iv.setStore(nst)
	return nil
}

func startJob(w http.ResponseWriter, tmpl *template.Template, iv *indexState, js *jobs.Store, hs *history.Store, req *http.Request, kind string) {
	page := pageFromForm(req)
	page.Host = deps.Detect(iv.cat.Root)
	if err := fillPlan(iv, &page); err != nil {
		page.Error = err.Error()
		applyLists(&page, js, hs)
		render(w, tmpl, page)
		return
	}
	m, err := js.Create(kind, requestFromPage(page), page.Plan)
	if err != nil {
		page.Error = err.Error()
		applyLists(&page, js, hs)
		render(w, tmpl, page)
		return
	}
	if kind == jobs.TypeInstall && page.Deps != nil {
		_ = js.SeedInstall(m.ID, *page.Deps)
	}
	if err := js.Start(m.ID); err != nil {
		page.Error = err.Error()
	}
	attachJob(iv, js, &page, m.ID)
	page.History = hs.List(20)
	render(w, tmpl, page)
}

func pageLists(js *jobs.Store, hs *history.Store) web.Page {
	return web.Page{Jobs: js.List(8), History: hs.List(20)}
}

func applyLists(page *web.Page, js *jobs.Store, hs *history.Store) {
	page.Jobs = js.List(8)
	page.History = hs.List(20)
}

func attachHistory(iv *indexState, hs *history.Store, page *web.Page, id string) {
	e, err := hs.Get(id)
	if err != nil {
		page.Error = err.Error()
		return
	}
	page.Situation = e.Request.Situation
	page.Scope = e.Request.Scope
	page.Target = e.Request.Target
	page.Path = e.Request.Path
	page.Authorized = e.Request.Authorized
	page.UseLLM = e.Request.UseLLM
	_ = fillPlan(iv, page)
}

func fillPlan(iv *indexState, page *web.Page) error {
	cat := iv.cat
	persisted, _ := settingsConfig(cat).LoadLLM()
	cfg := llm.ResolveWith(persisted, page.OpenAIBaseURL, "", page.OpenAIModel)
	page.OpenAIKeySet = cfg.APIKey != ""
	var plan *planner.Plan
	var err error
	iv.with(func(st *index.Store) {
		plan, err = llm.Build(cat, st, requestFromPage(*page), cfg, func(msg string) {
			page.LLMNote = msg
		})
	})
	if err != nil {
		return err
	}
	page.Plan = plan
	rep := deps.Check(cat.Root, cat, plan)
	page.Deps = &rep
	return nil
}

// settingsConfig builds an appconfig pointing at this repo's local LLM settings
// file so the server can read/write it without depending on the process cwd.
func settingsConfig(cat *catalog.Catalog) *appconfig.Config {
	return &appconfig.Config{SettingsPath: filepath.Join(cat.Root, "data", "config.json")}
}

// saveLLMFromForm persists any bring-your-own LLM fields the operator submitted.
// A blank field keeps the previously saved value (so a blank key never wipes it).
func saveLLMFromForm(cat *catalog.Catalog, req *http.Request) {
	base := strings.TrimSpace(req.FormValue("openai_base_url"))
	key := strings.TrimSpace(req.FormValue("openai_api_key"))
	model := strings.TrimSpace(req.FormValue("openai_model"))
	if base == "" && key == "" && model == "" {
		return
	}
	sc := settingsConfig(cat)
	persisted, _ := sc.LoadLLM()
	if base != "" {
		persisted.BaseURL = base
	}
	if key != "" {
		persisted.APIKey = key
	}
	if model != "" {
		persisted.Model = model
	}
	_ = sc.SaveLLM(persisted)
}

func attachJob(iv *indexState, js *jobs.Store, page *web.Page, id string) {
	v, err := js.View(id, 80<<10)
	if err != nil {
		page.Error = err.Error()
		page.Jobs = js.List(8)
		return
	}
	page.Job = v
	page.Jobs = js.List(8)
	if page.Plan != nil {
		return
	}
	page.Situation = v.Request.Situation
	page.Scope = v.Request.Scope
	page.Target = v.Request.Target
	page.Path = v.Request.Path
	page.Authorized = v.Request.Authorized
	page.UseLLM = v.Request.UseLLM
	_ = fillPlan(iv, page)
}

func pageFromForm(req *http.Request) web.Page {
	return web.Page{
		Situation:     req.FormValue("situation"),
		Scope:         req.FormValue("scope"),
		Target:        req.FormValue("target"),
		Path:          req.FormValue("path"),
		Authorized:    req.FormValue("authorized") == "1" || req.FormValue("authorized") == "on" || req.FormValue("authorized") == "true",
		UseLLM:        req.FormValue("use_llm") == "1" || req.FormValue("use_llm") == "on" || req.FormValue("use_llm") == "true",
		OpenAIBaseURL: req.FormValue("openai_base_url"),
		OpenAIModel:   req.FormValue("openai_model"),
	}
}

func requestFromPage(p web.Page) planner.Request {
	return planner.Request{
		Situation:  p.Situation,
		Scope:      p.Scope,
		Target:     p.Target,
		Path:       p.Path,
		Authorized: p.Authorized,
		UseLLM:     p.UseLLM,
	}
}

func planExt(plan *planner.Plan) []catalog.Record {
	if plan == nil {
		return nil
	}
	var steps [][]catalog.Record
	for _, s := range plan.Steps {
		steps = append(steps, s.Tools)
	}
	return browser.PlanRecords(steps)
}

func render(w http.ResponseWriter, tmpl *template.Template, page web.Page) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := tmpl.ExecuteTemplate(w, "page.html", page); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}
