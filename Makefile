# ohqs — OpenHat Quick Start
#   make start        one command: build, index, open the UI
#   make help         list targets

BIN      := bin/ohqs
OHQS_DIR := ohqs
GO_PKGS  := ./cmd/... ./internal/...
GO_SRC   := $(shell find $(OHQS_DIR)/cmd $(OHQS_DIR)/internal -type f \( -name '*.go' -o -name '*.html' -o -name '*.css' \) 2>/dev/null)

# recommend / commands (PATH is reserved by make — use SRC for --path)
AUTHORIZED ?=
SCOPE      ?=
SITUATION  ?=
TARGET     ?=
SRC        ?=
WORDLIST   ?=
EXPORT     ?=
OUT        ?= ./ohqs-out/example
Q          ?=
ID         ?=
SCRIPT     ?= $(OUT)/commands.sh

.PHONY: all help build test vet fmt tidy check index reindex index-semantic index-download \
	setup configure search show recommend commands run \
	start serve up stop deps install-tools install-cli \
	build-index-pack \
	submodules convert-submodules clean

.DEFAULT_GOAL := start

all: build index setup
	@echo
	@echo "Ready. Next:"
	@echo "  make start"
	@echo "  make search Q=\"ai slop\""
	@echo "  make recommend AUTHORIZED=1 SCOPE=\"...\" SITUATION=\"...\" TARGET=https://in-scope.example"
	@echo "  make help"

help:
	@printf '%s\n' \
		'make [target]' \
		'' \
		'  start               build, install ohqs on PATH, index, open the UI' \
		'  stop                stop the UI if we started it' \
		'' \
		'Build and catalog' \
		'  all                 build + index + setup (no server)' \
		'  build               go build -o bin/ohqs (from ohqs/)' \
		'  index               rebuild data/ohqs.sqlite (lexical)' \
		'  reindex             alias for index' \
		'  index-semantic      rebuild data/ohqs.sqlite + vector embeddings (needs Ollama nomic-embed-text or HF_TOKEN)' \
		'  index-download      fetch the release-built index (with vectors) into data/ohqs.sqlite' \
		'  build-index-pack    build dist/ohqs-index.sqlite + index-manifest.json for GitHub Release assets' \
		'  setup               Kali / Exegol / BlackArch notes' \
		'  configure           print resolved repo/catalog/index/listen paths' \
		'' \
		'Quality' \
		'  test                go test ./cmd/... ./internal/... (in ohqs/)' \
		'  vet                 go vet (in ohqs/)' \
		'  fmt                 gofmt -w cmd internal (in ohqs/)' \
		'  tidy                go mod tidy (in ohqs/)' \
		'  check               fmt + vet + test' \
		'' \
		'Use (authorized work only)' \
		'  serve / up          aliases for start' \
		'  search Q=nuclei' \
		'  show ID=gitleaks' \
		'  recommend AUTHORIZED=1 SCOPE="..." SITUATION="..." [TARGET=] [SRC=] [WORDLIST=] [EXPORT=]' \
		'  (CLI) ohqs recommend --llm   OpenAI-compatible plan (OHQS_OPENAI_* or --openai-*)' \
		'  commands            recommend and write commands.sh (OUT=./ohqs-out/example)' \
		'  deps                 host OS + which plan tools are already installed' \
		'  install-tools        clone/build only missing tools this playbook needs' \
		'  install-cli          copy bin/ohqs onto PATH (bin/tools + Go/user bin)' \
		'  (CLI) ohqs browser   isolated Firefox with extensions pre-installed' \
		'  run [SCRIPT=./ohqs-out/example/commands.sh]' \
		'' \
		'Third-party checkouts (not fetched by git clone)' \
		'  submodules          shallow-fetch ALL third-party submodules' \
		'  (CLI) ohqs submodules [id|path]   same, optionally one catalog id' \
		'  convert-submodules  absorb nested clones into .gitmodules (maintainers)' \
		'' \
		'  clean               remove bin/ohqs and the sqlite index'

$(BIN): $(GO_SRC) $(OHQS_DIR)/go.mod $(OHQS_DIR)/go.sum
	mkdir -p $(dir $@)
	cd $(OHQS_DIR) && go build -o ../$@ ./cmd/ohqs

build: $(BIN)

test:
	cd $(OHQS_DIR) && go test $(GO_PKGS)

vet:
	cd $(OHQS_DIR) && go vet $(GO_PKGS)

fmt:
	cd $(OHQS_DIR) && gofmt -w cmd internal

tidy:
	cd $(OHQS_DIR) && go mod tidy

check: fmt vet test

index: $(BIN)
	$(BIN) index

reindex: index

index-semantic: $(BIN)
	$(BIN) index --semantic

index-download: $(BIN)
	$(BIN) index download

# Ship the vectorized catalog as a release asset so users skip local embedding.
# Later: attach dist/ files to the GitHub release (ohqs-index.sqlite fetched by
# `ohqs index download` -> /releases/latest/download/ohqs-index.sqlite).
build-index-pack: check $(BIN)
	rm -rf dist/index
	mkdir -p dist/index
	@N=$$($(BIN) index --semantic --db dist/index/ohqs-index.sqlite --vacuum 2>/dev/null | sed -n 's/^indexed \([0-9]*\) records.*/\1/p'); \
	printf '{"asset":"ohqs-index.sqlite","commit":"%s","built":"%s","embedder":"ollama nomic-embed-text / HF all-MiniLM-L6-v2","records":%s}\n' \
		"$$(git rev-parse --short HEAD 2>/dev/null || echo dev)" \
		"$$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
		"$${N:-unknown}" \
		> dist/index/index-manifest.json
	@echo
	@echo "Release assets in dist/index/: ohqs-index.sqlite + index-manifest.json"
	@echo "Upload them to the GitHub release; users then run: make index-download"

setup: $(BIN)
	$(BIN) setup
	$(BIN) configure

configure: $(BIN)
	$(BIN) configure

search: $(BIN)
	@test -n "$(Q)" || { echo 'usage: make search Q="nuclei"'; exit 1; }
	$(BIN) search $(Q)

show: $(BIN)
	@test -n "$(ID)" || { echo 'usage: make show ID=gitleaks'; exit 1; }
	$(BIN) show $(ID)

recommend: $(BIN)
	@test "$(AUTHORIZED)" = "1" && test -n "$(SCOPE)" && test -n "$(SITUATION)" || { \
		echo 'usage: make recommend AUTHORIZED=1 SCOPE="..." SITUATION="..." [TARGET=] [SRC=] [WORDLIST=] [EXPORT=]'; \
		exit 1; \
	}
	$(BIN) recommend --authorized --scope "$(SCOPE)" --situation "$(SITUATION)" \
		$(if $(TARGET),--target "$(TARGET)") \
		$(if $(SRC),--path "$(SRC)") \
		$(if $(WORDLIST),--wordlist "$(WORDLIST)") \
		$(if $(EXPORT),--export "$(EXPORT)")

commands: $(BIN)
	@test "$(AUTHORIZED)" = "1" && test -n "$(SCOPE)" && test -n "$(SITUATION)" || { \
		echo 'usage: make commands AUTHORIZED=1 SCOPE="..." SITUATION="..." [TARGET=] [SRC=] [OUT=$(OUT)]'; \
		exit 1; \
	}
	$(BIN) recommend --authorized --scope "$(SCOPE)" --situation "$(SITUATION)" \
		$(if $(TARGET),--target "$(TARGET)") \
		$(if $(SRC),--path "$(SRC)") \
		$(if $(WORDLIST),--wordlist "$(WORDLIST)") \
		--export "$(or $(EXPORT),$(OUT))"

deps: $(BIN)
	@if [ -n "$(SITUATION)" ]; then \
		test "$(AUTHORIZED)" = "1" && test -n "$(SCOPE)" || { echo 'usage: make deps AUTHORIZED=1 SCOPE="..." SITUATION="..."'; exit 1; }; \
		$(BIN) deps --authorized --scope "$(SCOPE)" --situation "$(SITUATION)" $(if $(TARGET),--target "$(TARGET)") $(if $(SRC),--path "$(SRC)"); \
	else \
		$(BIN) deps; \
	fi

install-tools: $(BIN)
	@test "$(AUTHORIZED)" = "1" && test -n "$(SCOPE)" && test -n "$(SITUATION)" || { \
		echo 'usage: make install-tools AUTHORIZED=1 SCOPE="..." SITUATION="..." [TARGET=]'; \
		exit 1; \
	}
	$(BIN) install --authorized --scope "$(SCOPE)" --situation "$(SITUATION)" \
		$(if $(TARGET),--target "$(TARGET)") \
		$(if $(SRC),--path "$(SRC)")

run: $(BIN)
	$(BIN) run $(SCRIPT)

install-cli: $(BIN)
	$(BIN) install-cli

start serve up: $(BIN) install-cli
	@test -f data/ohqs.sqlite || $(MAKE) index
	@./scripts/start.sh

stop:
	@./scripts/stop.sh

submodules:
	./scripts/sync-submodules.sh

convert-submodules:
	./scripts/convert-nested-to-submodules.sh

clean:
	rm -f $(BIN) data/ohqs.sqlite
