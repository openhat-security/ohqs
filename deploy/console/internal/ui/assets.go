package ui

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed assets/*
var assetsFS embed.FS

// Assets is the http.FileSystem rooted at assets/ (css, js, vendor).
func Assets() http.Handler {
	sub, err := fs.Sub(assetsFS, "assets")
	if err != nil {
		panic(err)
	}
	return http.FileServer(http.FS(sub))
}
