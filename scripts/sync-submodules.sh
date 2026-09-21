#!/usr/bin/env bash
# Opt-in shallow fetch of third-party submodules.
#   ./scripts/sync-submodules.sh              # all
#   ./scripts/sync-submodules.sh <path>...    # selected paths
# Default `git clone` of this repo does NOT download these trees.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ohqs: not a git repository; cannot fetch submodules" >&2
  exit 1
fi
if [ ! -f .gitmodules ]; then
  echo "ohqs: missing .gitmodules" >&2
  exit 1
fi

echo "==> git submodule update --init --depth 1${*:+ -- $*}"
if [ "$#" -eq 0 ]; then
  git submodule update --init --depth 1
else
  git submodule update --init --depth 1 -- "$@"
fi
echo
git submodule status
