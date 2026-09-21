package web

import (
	"embed"
	"html/template"
	"io/fs"
	"net/http"

	"github.com/openhat/quick-start/internal/browser"
	"github.com/openhat/quick-start/internal/deps"
	"github.com/openhat/quick-start/internal/history"
	"github.com/openhat/quick-start/internal/jobs"
	"github.com/openhat/quick-start/internal/planner"
)

//go:embed templates/*.html static/*
var files embed.FS

type Page struct {
	Situation     string
	Scope         string
	Target        string
	Path          string
	Authorized    bool
	UseLLM        bool
	OpenAIBaseURL string
	OpenAIModel   string
	OpenAIKeySet  bool
	LLMNote       string
	Error         string
	Plan          *planner.Plan
	Host          deps.Host
	Deps          *deps.Report
	Job           *jobs.View
	Jobs          []jobs.Meta
	History       []history.Entry
	Browser       *browser.Result
}

func Templates() (*template.Template, error) {
	return template.ParseFS(files, "templates/*.html")
}

func Static() http.Handler {
	sub, err := fs.Sub(files, "static")
	if err != nil {
		panic(err)
	}
	return http.FileServer(http.FS(sub))
}
