package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/a-h/templ"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/openhat/quick-start/deploy/console/internal/ui"
)

type Options struct {
	APIBase string
}

type Server struct {
	mux     *chi.Mux
	apiBase string
	proxy   *httputil.ReverseProxy
	assets  http.Handler
}

func New(opts Options) (*Server, error) {
	base := strings.TrimRight(opts.APIBase, "/")
	if base == "" {
		base = "http://127.0.0.1:8788"
	}
	u, err := url.Parse(base)
	if err != nil {
		return nil, fmt.Errorf("api base: %w", err)
	}
	proxy := httputil.NewSingleHostReverseProxy(u)
	orig := proxy.Director
	proxy.Director = func(r *http.Request) {
		orig(r)
		r.Host = u.Host
		r.Header.Set("X-Forwarded-Host", r.Header.Get("Host"))
		r.Header.Del("Accept-Encoding") // simplify body handling if needed
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, e error) {
		http.Error(w, "worker API unreachable: "+e.Error()+" (is wrangler on :8788?)", http.StatusBadGateway)
	}

	s := &Server{
		apiBase: base,
		proxy:   proxy,
		assets:  ui.Assets(),
	}
	s.mux = chi.NewRouter()
	s.mux.Use(middleware.RequestID)
	s.mux.Use(middleware.RealIP)
	s.mux.Use(middleware.Recoverer)
	s.mux.Use(strictCSP)

	s.mux.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})

	s.mux.Handle("/assets/*", http.StripPrefix("/assets/", s.assets))

	s.mux.Get("/", s.handleHome)
	s.mux.Get("/hx/ping", s.handlePing)
	s.mux.Post("/hx/recommend", s.handleRecommend)

	// Same-origin API surface — keep worker as source of truth for /v1/*.
	s.mux.Handle("/v1/*", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.proxy.ServeHTTP(w, r)
	}))

	return s, nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

func strictCSP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Same-origin only: vendored HTMX + local CSS/JS. No open CDNs.
		w.Header().Set("Content-Security-Policy",
			"default-src 'none'; "+
				"base-uri 'self'; "+
				"form-action 'self'; "+
				"frame-ancestors 'none'; "+
				"script-src 'self'; "+
				"style-src 'self'; "+
				"img-src 'self' data:; "+
				"font-src 'self'; "+
				"connect-src 'self'; "+
				"object-src 'none'; "+
				"worker-src 'none'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleHome(w http.ResponseWriter, r *http.Request) {
	templ.Handler(ui.Home(ui.HomeData{
		APIBase:   s.apiBase,
		ListenTip: r.Host,
	})).ServeHTTP(w, r)
}

func (s *Server) handlePing(w http.ResponseWriter, r *http.Request) {
	ok, detail := s.probeWorker(r)
	templ.Handler(ui.WorkerStatus(ok, detail)).ServeHTTP(w, r)
}

func (s *Server) probeWorker(r *http.Request) (bool, string) {
	client := &http.Client{Timeout: 3 * time.Second}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, s.apiBase+"/healthz", nil)
	if err != nil {
		return false, err.Error()
	}
	res, err := client.Do(req)
	if err != nil {
		return false, "unreachable: " + err.Error()
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 64))
	if res.StatusCode == 200 && bytes.Contains(bytes.TrimSpace(b), []byte("ok")) {
		return true, "worker " + s.apiBase + " · healthz ok"
	}
	return false, fmt.Sprintf("worker %s · HTTP %d", s.apiBase, res.StatusCode)
}

type recommendBody struct {
	Situation  string `json:"situation"`
	Mode       string `json:"mode"`
	Authorized bool   `json:"authorized"`
	Target     string `json:"target,omitempty"`
	Model      string `json:"model,omitempty"`
	Language   string `json:"language,omitempty"`
	Complexity int    `json:"complexity,omitempty"`
}

func (s *Server) handleRecommend(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad form", 400)
		return
	}
	token := strings.TrimSpace(r.Header.Get("X-OHQS-Token"))
	if token == "" {
		token = strings.TrimSpace(r.FormValue("api_token"))
	}
	mode := r.FormValue("mode")
	if mode != "code" {
		mode = "written"
	}
	complexity := 3
	if mode == "code" {
		fmt.Sscanf(r.FormValue("complexity"), "%d", &complexity)
		if complexity < 1 {
			complexity = 1
		}
		if complexity > 10 {
			complexity = 10
		}
	}
	body := recommendBody{
		Situation:  strings.TrimSpace(r.FormValue("situation")),
		Mode:       mode,
		// Console dropped scope UI; always assert authorized lab (server RoE gate).
		Authorized: true,
		Target:     strings.TrimSpace(r.FormValue("target")),
		Model:      strings.TrimSpace(r.FormValue("model")),
		Language:   strings.TrimSpace(r.FormValue("language")),
		Complexity: complexity,
	}
	if body.Situation == "" {
		templ.Handler(ui.ResultError("situation is required")).ServeHTTP(w, r)
		return
	}
	if token == "" || !strings.HasPrefix(token, "ohqs_") {
		templ.Handler(ui.ResultError("paste an ohqs_* portal API token (session only) — mint in openhat-portal → Tokens")).ServeHTTP(w, r)
		return
	}

	payload, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(r.Context(), http.MethodPost, s.apiBase+"/v1/recommend", bytes.NewReader(payload))
	if err != nil {
		templ.Handler(ui.ResultError(err.Error())).ServeHTTP(w, r)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")

	client := &http.Client{Timeout: 150 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		templ.Handler(ui.ResultError("worker recommend failed: "+err.Error())).ServeHTTP(w, r)
		return
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 32<<20))
	if res.StatusCode >= 400 {
		msg := strings.TrimSpace(string(raw))
		if len(msg) > 400 {
			msg = msg[:400] + "…"
		}
		templ.Handler(ui.ResultError(fmt.Sprintf("recommend HTTP %d: %s", res.StatusCode, msg))).ServeHTTP(w, r)
		return
	}

	var plan map[string]any
	if err := json.Unmarshal(raw, &plan); err != nil {
		templ.Handler(ui.ResultError("bad JSON from worker")).ServeHTTP(w, r)
		return
	}
	view := buildResultView(plan)
	templ.Handler(ui.ResultPanel(view)).ServeHTTP(w, r)
}

func buildResultView(plan map[string]any) ui.ResultView {
	v := ui.ResultView{
		Title:    str(plan["playbook_title"]),
		Playbook: str(plan["playbook"]),
		Scope:    str(plan["scope"]),
		Mode:     str(plan["mode"]),
		Language: str(plan["language"]),
		LabNotice: str(plan["lab_notice"]),
		Note:     str(plan["planner_note"]),
		ZipBase64: str(plan["zip_base64"]),
	}
	if c, ok := plan["complexity"].(float64); ok {
		v.Complexity = int(c)
	}
	if c, ok := plan["recommend_credits"].(float64); ok {
		v.Credits = int(c)
	}
	v.PlanStatus = str(plan["plan_status"])
	if v.PlanStatus == "" {
		v.PlanStatus = "live"
	}
	v.ScaffoldStatus = str(plan["scaffold_status"])
	if v.ScaffoldStatus == "" {
		v.ScaffoldStatus = str(plan["scaffold"])
	}
	if v.ScaffoldStatus == "llm" {
		v.ScaffoldStatus = "live"
	}
	if v.ScaffoldStatus == "deterministic" {
		v.ScaffoldStatus = "stub"
	}

	if steps, ok := plan["steps"].([]any); ok {
		for _, s := range steps {
			m, _ := s.(map[string]any)
			if m == nil {
				continue
			}
			st := ui.StepView{
				N:       int(num(m["n"])),
				Title:   str(m["title"]),
				Purpose: str(m["purpose"]),
				How:     str(m["how"]),
				LookFor: str(m["look_for"]),
				Next:    str(m["next"]),
			}
			if cmds, ok := m["commands"].([]any); ok {
				for _, c := range cmds {
					st.Commands = append(st.Commands, str(c))
				}
			}
			if tools, ok := m["tools"].([]any); ok {
				for _, t := range tools {
					tm, _ := t.(map[string]any)
					if tm == nil {
						st.Tools = append(st.Tools, str(t))
						continue
					}
					name := str(tm["name"])
					id := str(tm["id"])
					if id != "" {
						name = name + " (" + id + ")"
					}
					st.Tools = append(st.Tools, name)
				}
			}
			v.Steps = append(v.Steps, st)
		}
	}

	seen := map[string]struct{}{}
	addFile := func(path, content string) {
		safe := SanitizeZipPath(path)
		if safe == "" {
			return
		}
		if _, ok := seen[safe]; ok {
			return
		}
		seen[safe] = struct{}{}
		text, ph := PreviewContent(safe, content)
		v.Files = append(v.Files, ui.FileView{Path: safe, Content: text, Placeholder: ph})
	}
	if zf, ok := plan["zip_files"].([]any); ok {
		for _, item := range zf {
			switch t := item.(type) {
			case string:
				addFile(t, "")
			case map[string]any:
				addFile(str(t["path"]), str(t["content"]))
				if str(t["path"]) == "" {
					addFile(str(t["name"]), str(t["content"]))
				}
			}
		}
	}
	return v
}

func str(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return fmt.Sprintf("%v", t)
	case nil:
		return ""
	default:
		return fmt.Sprintf("%v", t)
	}
}

func num(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case int:
		return float64(t)
	default:
		return 0
	}
}
