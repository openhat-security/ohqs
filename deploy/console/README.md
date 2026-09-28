# ohqs console (templ + HTMX)

Local product console for OpenHat Quick Start. **Worker API stays on `:8788`.** This UI listens on **`:8790`** and proxies `/v1/*` same-origin so a strict CSP can forbid open CDNs.

## Pins

| Dep | Version | Notes |
|---|---|---|
| [templ](https://templ.guide) | `v0.3.1020` | Go UI templates |
| [htmx](https://htmx.org) | `2.0.11` | Vendored at `internal/ui/assets/vendor/htmx.min.js` (same-origin) |
| chi | `v5.2.1` | Router |

## Brand

Ink / cream / **signal red** — not a generic green terminal theme.

## Run (local only)

Keep the worker healthy:

```bash
# already pinned in this checkout:
curl -sS http://127.0.0.1:8788/healthz   # → ok
```

Start the console:

```bash
cd deploy/console
make run
# → http://127.0.0.1:8790
```

Or:

```bash
bin/ohqs-console -addr 127.0.0.1:8790 -api http://127.0.0.1:8788
```

Env overrides: `OHQS_CONSOLE_ADDR`, `OHQS_WORKER_API`.

## Ports

| Port | Role |
|---|---|
| **8788** | Cloudflare worker (wrangler) — `/healthz`, `/v1/*`, legacy static `deploy/web` assets |
| **8790** | Go + templ + HTMX console (this package). Proxies `/v1/*` → 8788 |

Do **not** push/prod from here. Do **not** start Wails from this console package.

## Pages

Nav switches via hash (`#playbook` · `#catalog` · `#bounties`). Catalog and Bounties call same-origin `/v1/search` and `/v1/bounties` (proxied to the worker). Record lists use `textContent` / `createElement` only — no live HTML render of untrusted content.

## UX after Plan + code

Tabbed preview: **PLAYBOOK · files · status**

- **PLAYBOOK** — engagement steps from `/v1/recommend`
- **files** — VS Code–style path list + read-only editor (`textContent` only; no live HTML/SVG render; paths sanitized; secrets redacted; no auto-exec)
- **status** — credits used + plan/scaffold live|template|stub (premium only when both are live)

Preserved: Plan+code mode, progress animation (HTMX indicator), credit rules, zip download.

## CSP

`default-src 'none'` with `'self'` for script/style/img/connect. No CDN script-src.
