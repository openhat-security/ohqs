# Ingest every bug bounty program individually, recon each target, infer likely vulns, and index into the vector store

> Requested refactor/infra work. Not a bug in the current product — the current build cannot do this and requires bigger compute and authorized scanning runs.

## Summary

Today the catalog only knows **bug bounty platforms** (HackerOne, Bugcrowd, Intigriti, Immunefi, 128 more — 132 total). You can search by *platform name*, not by *company* or *vulnerability*. We want each **individual program listing** inside those platforms (thousands of programs, each with a company and in-scope assets) pulled in, the targets lightly recon'd, likely bug classes inferred, and everything embedded into the D1 vector store so `/v1/bounties?q=<company or vuln>` ranks real programs.

## Why this needs a bigger GPU (honest blocker)

The Cloudflare Worker + D1 edge cannot run this:

- Workers have hard CPU-time limits and no long-running processes — no place to run amass/nuclei/port scans.
- "Determine possible vulnerabilities" needs an LLM-classification pass over every target profile (version→CVE, framework defaults, bug-class inference). That classification is the GPU step. Embedded Workers AI (bge-small embeddings) can rank text but cannot recon or reason over scan data.
- Millions of program×asset observations need a queue + storage + a persistent jobs worker (a long-running box, ideally GPU-backed), not a serverless edge function.

So: **yes, we need a bigger GPU / dedicated recon box** — plus, critically, **written authorization per in-scope target**, because active scanning third-party infrastructure without authorization violates both law and every platform's rules.

## Requested process

### 1. Program acquisition (per platform)
- Platforms to ingest: HackerOne, Bugcrowd, Intigriti, Immunefi, Synack, YesWeHack, Code4rena, Cobalt, plus long-tail platforms already in `catalog/platforms.yaml` (110 marketplaces).
- For each program, capture: `platform`, `company`, `program_name`, in-scope assets (domains, webapps, mobile, blockchain addresses), payout/RoL, policy/safety rules.
- Data sources, in order of preference: platform export/API **only where the platform's ToS explicitly allows it**; otherwise the program's `security.txt` or public disclosure page. Respect robots.txt and rate limits.
- Store raw records as `kind: "bounty-program"` rows (new schema alongside `platform`).

### 2. Recon per target (passive-first, authorization-gated)
Only for in-scope assets the operator certifies with written permission:
- Passive: subdomain enumeration (subfinder/amass), certificate transparency (crt.sh), DNS/WHOIS, tech fingerprint (whatweb/wappalyzer), public code/search exposure.
- Light validation, scope-limited: `nmap` on authorized ports, nuclei with non-intrusive templates, HTTP endpoint census.
- Emit a normalized **target profile**: host, services, versions, frameworks, exposed endpoints, auth/API surface.

### 3. Vulnerability inference
- Rule layer: version → known CVEs (OSV/NVD feeds), framework defaults, common misconfig signatures, API/auth exposure patterns.
- GPU/LLM layer: per target profile, classify likely bug classes (SQLi, SSRF, IDOR, XSS, auth bypass, race conditions, smart-contract faults for Immunefi/C4 scope, …) with confidence, plus an evidence snippet per finding.
- Findings must be recorded in a queried evidence file; nothing is "auto-hacked", this only produces hypotheses + the data behind them.

### 4. Vector indexing
- Build one document per program (company + platform + scope + stack + inferred bug classes), embed with the same model as the catalog (`@cf/baai/bge-small-en-v1.5`, 384-dim), and insert into D1 `vectors`.
- Add the program rows to `records` so the existing `/v1/bounties?class=&q=` endpoint searches them with no frontend rewrite.
- Store a `manifests/programs.json` job ledger: per platform, which programs are ingested, recon status, vuln-inference status.

### 5. Search semantics (the user-facing payoff)
- `q=stripe` → the Stripe program + its marketplaces.
- `q=idor` / `q=ssrf` / `q=smart contract reentrancy` → every program whose recon+stack makes that bug class plausible, ranked.
- `q=next.js admin panelfür` — surface stack matches + inferred classes with their evidence links.

## Acceptance criteria

1. `records` contains one row per individual program (not just per platform) → `/v1/index` shows the growth and `/v1/bounties` lists them.
2. `/v1/bounties?q=<company>` and `?q=<vuln class>` return ranked programs with a "ranked by" source string, same contract as today.
3. `manifests/programs.json` tracks per-platform progress; recon evidence files exist for every scanned host and cite which scope authorized it.
4. No active scan traffic ever touches a host that is not in a written-authorized scope; the pipeline refuses otherwise.

## Not in scope / refused by design

- No automation that "hacks" targets; recon + hypothesis + evidence only.
- No bypassing platform ToS, logins, or protections to scrape program data.
- No scanning of out-of-scope or unaffiliated hosts.