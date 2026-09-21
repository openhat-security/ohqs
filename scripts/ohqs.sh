#!/usr/bin/env bash
# Build, index, and print ohqs setup. Run from anywhere:
#   ./scripts/ohqs.sh
#   ./scripts/ohqs.sh build|index|setup|serve|all
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
bin="$root/bin/ohqs"

die() { echo "ohqs.sh: $*" >&2; exit 1; }

need_go() {
  command -v go >/dev/null 2>&1 || die "Go is not on PATH. Install from https://go.dev/dl/"
}

build() {
  need_go
  mkdir -p "$root/bin"
  echo "==> go build -o bin/ohqs ./cmd/ohqs (from ohqs/)"
  (cd "$root/ohqs" && go build -o "$bin" ./cmd/ohqs)
  "$bin" install-cli
  echo "    $bin"
}

index() {
  [[ -x "$bin" ]] || build
  echo "==> ohqs index"
  "$bin" index
}

setup() {
  [[ -x "$bin" ]] || build
  echo "==> ohqs setup"
  "$bin" setup
  echo "==> ohqs configure"
  "$bin" configure
}

serve() {
  [[ -x "$bin" ]] || build
  [[ -f "$root/data/ohqs.sqlite" ]] || index
  exec "$root/scripts/start.sh"
}

usage() {
  cat <<EOF
usage: ./scripts/ohqs.sh [all|build|index|setup|serve|help]

  all     build + index + print setup (default)
  build   go build -o bin/ohqs (from ohqs/)
  index   rebuild data/ohqs.sqlite
  setup   print Kali/Exegol/BlackArch notes
  serve   build if needed, then start the UI on 127.0.0.1:8787
EOF
}

cmd="${1:-all}"
shift || true
case "$cmd" in
  all)
    build
    index
    setup
    echo
    echo "Ready. Examples:"
    echo "  $bin search \"ai slop\""
    echo "  $bin recommend --authorized --scope \"...\" --situation \"...\""
    echo "  ./scripts/ohqs.sh serve"
    echo "See EXAMPLES.md"
    ;;
  build) build ;;
  index) index ;;
  setup) setup ;;
  serve) serve "$@" ;;
  help|-h|--help) usage ;;
  *) usage; die "unknown command: $cmd" ;;
esac
