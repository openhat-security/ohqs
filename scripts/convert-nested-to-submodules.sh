#!/usr/bin/env bash
# Convert nested clones under third-party-resources/ into git submodules
# without re-downloading. Does not commit. Safe to re-run.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "==> git init (required for submodules)"
  git init -b main
fi

relpath() {
  python3 -c "import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))" "$1" "$2"
}

converted=0
skipped=0
failed=0

while IFS= read -r path; do
  if [ ! -d "$path/.git" ] && [ ! -f "$path/.git" ]; then
    continue
  fi
  url="$(git -C "$path" remote get-url origin 2>/dev/null || true)"
  if [ -z "$url" ]; then
    echo "skip $path (no origin)" >&2
    skipped=$((skipped + 1))
    continue
  fi
  commit="$(git -C "$path" rev-parse HEAD 2>/dev/null || true)"
  if [ -z "$commit" ]; then
    echo "skip $path (no HEAD)" >&2
    skipped=$((skipped + 1))
    continue
  fi

  name="$path"
  gitdir=".git/modules/$path"

  if [ -d "$path/.git" ]; then
    mkdir -p "$(dirname "$gitdir")"
    rm -rf "$gitdir"
    mv "$path/.git" "$gitdir"
    echo "gitdir: $(relpath "$gitdir" "$path")" > "$path/.git"
    git --git-dir="$gitdir" config core.bare false
    git --git-dir="$gitdir" config core.worktree "$(relpath "$path" "$gitdir")"
  fi

  git config -f .gitmodules "submodule.$name.path" "$path"
  git config -f .gitmodules "submodule.$name.url" "$url"
  git config -f .gitmodules "submodule.$name.shallow" true
  git config "submodule.$name.url" "$url"
  git config "submodule.$name.active" true

  git update-index --add --cacheinfo 160000 "$commit" "$path"
  echo "submodule $path @ ${commit:0:8} <- $url"
  converted=$((converted + 1))
done < <(find third-party-resources -mindepth 2 -maxdepth 2 -type d ! -name '.*' | sort)

echo
echo "converted=$converted skipped=$skipped failed=$failed"
echo "Next: commit .gitmodules and the gitlinks when you are ready."
echo "Users fetch trees later with: make submodules   or   ohqs submodules"
