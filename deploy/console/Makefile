# Local OpenHat console (templ + HTMX). Worker API remains on :8788.
BIN ?= ../../bin/ohqs-console
ADDR ?= 127.0.0.1:8790
API  ?= http://127.0.0.1:8788

.PHONY: generate build run tidy test

generate:
	templ generate ./internal/ui/...

tidy:
	go mod tidy

test:
	go test ./...

build: generate
	go build -o $(BIN) ./cmd/console

run: build
	$(BIN) -addr $(ADDR) -api $(API)
