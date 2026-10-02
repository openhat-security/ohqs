#!/usr/bin/env bash
# Push to main and deploy the Cloudflare Worker via GitHub Actions.
#
# Usage:
#   ./scripts/gh-deploy.sh              # check, commit deploy paths, push, run workflow
#   ./scripts/gh-deploy.sh --check-only # local make check + worker typecheck only
#   ./scripts/gh-deploy.sh --push-only  # push current branch; no commit
#   ./scripts/gh-deploy.sh --dispatch-only  # trigger Deploy worker without push
#
# Requires: gh CLI (logged in), git remote origin, repo secrets CLOUDFLARE_* on GitHub.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REPO="${GITHUB_REPOSITORY:-openhat-security/ohqs}"
WORKFLOW="deploy-worker.yml"
BRANCH="${DEPLOY_BRANCH:-main}"

CHECK_ONLY=false
PUSH_ONLY=false
DISPATCH_ONLY=false
SKIP_CHECK=false
COMMIT_MSG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check-only) CHECK_ONLY=true; shift ;;
    --push-only) PUSH_ONLY=true; shift ;;
    --dispatch-only) DISPATCH_ONLY=true; shift ;;
    --skip-check) SKIP_CHECK=true; shift ;;
    -m|--message)
      COMMIT_MSG="${2:-}"
      shift 2
      ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

run_checks() {
  echo "== ohqs: make check"
  make check
  echo "== worker: npm ci + typecheck"
  (cd deploy/worker && npm ci && npm run typecheck)
}

preflight() {
  command -v gh >/dev/null || { echo "install gh: https://cli.github.com/" >&2; exit 1; }
  gh auth status >/dev/null 2>&1 || { echo "run: gh auth login" >&2; exit 1; }
  if ! gh secret list --repo "$REPO" 2>/dev/null | grep -q CLOUDFLARE_API_TOKEN; then
    echo "warn: CLOUDFLARE_API_TOKEN not listed for $REPO (deploy job will fail)" >&2
  fi
  if ! gh secret list --repo "$REPO" 2>/dev/null | grep -q CLOUDFLARE_ACCOUNT_ID; then
    echo "warn: CLOUDFLARE_ACCOUNT_ID not listed for $REPO" >&2
  fi
  echo "hint: if deploy fails with Cloudflare code 10000, run ./scripts/verify-cloudflare-deploy.sh and refresh gh secrets" >&2
}

commit_deploy_paths() {
  if [[ -n "$COMMIT_MSG" ]]; then
    :
  else
    COMMIT_MSG="chore(ci): deploy worker via Actions

Update GitHub workflows and deploy/worker|web changes."
  fi

  # Paths that trigger Deploy worker (see .github/workflows/deploy-worker.yml)
  git add \
    .github/workflows/deploy-worker.yml \
    .github/workflows/ci.yml \
    deploy/worker \
    deploy/web \
    scripts/gh-deploy.sh \
    2>/dev/null || true

  if git diff --cached --quiet; then
    echo "== nothing staged to commit (deploy paths unchanged)"
    return 0
  fi

  git commit -m "$COMMIT_MSG"
}

push_branch() {
  local branch
  branch="$(git rev-parse --abbrev-ref HEAD)"
  if [[ "$branch" != "$BRANCH" ]]; then
    echo "warn: on branch $branch, pushing to origin (expected $BRANCH for auto-deploy on push)" >&2
  fi
  git push -u origin HEAD
}

dispatch_workflow() {
  echo "== gh workflow run $WORKFLOW --ref $BRANCH"
  gh workflow run "$WORKFLOW" --repo "$REPO" --ref "$BRANCH"
  echo "== waiting for run (timeout ~10m)"
  sleep 3
  run_id="$(gh run list --repo "$REPO" --workflow="$WORKFLOW" --limit 1 --json databaseId --jq '.[0].databaseId')"
  gh run watch "$run_id" --repo "$REPO" --exit-status
  echo "== done: https://github.com/$REPO/actions/runs/$run_id"
}

if [[ "$CHECK_ONLY" == true ]]; then
  run_checks
  exit 0
fi

preflight

if [[ "$DISPATCH_ONLY" == true ]]; then
  dispatch_workflow
  exit 0
fi

if [[ "$SKIP_CHECK" != true ]]; then
  run_checks
fi

if [[ "$PUSH_ONLY" != true ]]; then
  commit_deploy_paths
fi

push_branch

# Push to main with matching paths already triggers deploy-worker; dispatch ensures a run
# even when only workflow files changed or you want an explicit re-deploy.
dispatch_workflow
