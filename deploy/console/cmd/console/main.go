// Command console serves the local OpenHat ohqs console (templ + HTMX).
// It proxies /v1/* to the worker API (default http://127.0.0.1:8788) so the
// browser stays same-origin under a strict CSP. Worker stays pinned on :8788.
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/openhat/quick-start/deploy/console/internal/server"
)

func main() {
	addr := flag.String("addr", envOr("OHQS_CONSOLE_ADDR", "127.0.0.1:8790"), "listen address (UI)")
	api := flag.String("api", envOr("OHQS_WORKER_API", "http://127.0.0.1:8788"), "worker API base (proxied at /v1)")
	flag.Parse()

	srv, err := server.New(server.Options{
		APIBase: *api,
	})
	if err != nil {
		log.Fatalf("console: %v", err)
	}

	httpSrv := &http.Server{
		Addr:              *addr,
		Handler:           srv,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       120 * time.Second,
		WriteTimeout:      180 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	fmt.Printf("ohqs console (templ+HTMX)  http://%s\n", *addr)
	fmt.Printf("  worker API proxy /v1/* → %s\n", *api)
	fmt.Printf("  healthz (console)       http://%s/healthz\n", *addr)
	fmt.Printf("  worker healthz          %s/healthz\n", *api)
	fmt.Println("  local only — no push/prod; do not start Wails from here")
	log.Fatal(httpSrv.ListenAndServe())
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
