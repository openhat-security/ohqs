// Playbooks are vendored from catalog/playbooks/*.yaml at build time — they are
// static, small, and rarely change, so keeping them embedded avoids a schema
// change + reseed to make the deterministic planner work at the edge. Keep in
// sync with the YAML files when editing.

export interface PlaybookStep {
  id: string;
  title: string;
  purpose: string;
  tool_ids: string[];
}

export interface Playbook {
  id: string;
  title: string;
  match: string[];
  steps: PlaybookStep[];
}

export const PLAYBOOKS: Playbook[] = [
  {
    id: "ai-slop-web",
    title: "AI-generated web app (authorized)",
    match: ["ai", "slop", "vibe", "cursor", "copilot", "next.js", "nextjs", "generated", "llm", "rag", "chat", "agent"],
    steps: [
      { id: "scope", title: "Confirm scope and stack", purpose: "Only test what is authorized. Note frameworks, auth, and whether there is an LLM feature.", tool_ids: [] },
      { id: "secrets", title: "Scan the repo or source maps for secrets", purpose: "AI-generated apps often commit .env files, API keys, and debug tokens.", tool_ids: ["gitleaks", "trufflehog"] },
      { id: "sast", title: "Static scan for missing authz and injection", purpose: "Look for routes without checks, string-built SQL, wildcard CORS, eval/innerHTML.", tool_ids: ["semgrep", "opengrep"] },
      { id: "deps", title: "Check dependencies and hallucinated packages", purpose: "AI tools invent package names. Confirm lockfile vs registry and known CVEs.", tool_ids: ["trivy", "osv-scanner"] },
      { id: "live-map", title: "Map the live app", purpose: "Confirm what is actually deployed vs what the repo claims.", tool_ids: ["httpx", "katana", "nuclei"] },
      { id: "access", title: "Exercise authn/authz", purpose: "Two roles if you have them. Look for IDOR on generated CRUD.", tool_ids: ["pwnfox", "cookie-editor", "zaproxy"] },
      { id: "llm-surface", title: "If there is a model or agent, probe application-layer LLM risks", purpose: "Prompt injection, secret leakage in replies, unsafe tool-calling. Only against in-scope endpoints.", tool_ids: ["garak", "promptfoo"] },
      { id: "report", title: "Write findings", purpose: "Evidence, impact, fix. Use the export report stub.", tool_ids: [] },
    ],
  },
  {
    id: "bounty-web",
    title: "In-scope web bug bounty",
    match: ["bounty", "hackerone", "bugcrowd", "intigriti", "web", "subdomain"],
    steps: [
      { id: "scope", title: "Read the program policy", purpose: "Stay in scope. Note wildcards, rate limits, and excluded assets.", tool_ids: [] },
      { id: "recon", title: "Enumerate and probe live hosts", purpose: "Passive subs, then live HTTP fingerprinting.", tool_ids: ["subfinder", "amass", "httpx"] },
      { id: "crawl", title: "Discover routes and parameters", purpose: "JS-aware crawl plus parameter guessing on in-scope hosts.", tool_ids: ["katana", "arjun", "ffuf"] },
      { id: "known", title: "Template checks for exposures", purpose: "Known panels, leaked files, misconfig — not a substitute for manual work.", tool_ids: ["nuclei"] },
      { id: "browser", title: "Authenticated browse with a proxy", purpose: "Real session, cookies, client-side secrets.", tool_ids: ["foxyproxy", "pwnfox", "zaproxy", "caido"] },
      { id: "report", title: "Write the report to the program’s template", purpose: "Clear repro without extra weaponization.", tool_ids: [] },
    ],
  },
  {
    id: "nextjs-clerk",
    title: "Next.js + Clerk client assessment (authorized)",
    match: ["clerk", "next.js", "nextjs", "vibe", "cursor", "copilot", "ai", "slop", "saas"],
    steps: [
      { id: "scope", title: "Scope, RoE, and Clerk integration map", purpose: "Confirm written authorization. Map App Router vs Pages, which routes use Clerk middleware, webhook endpoints, and API routes that trust client-supplied userId/orgId. Out of scope is Clerk's platform — only this app's integration.", tool_ids: ["nextjs-clerk", "wstg"] },
      { id: "secrets", title: "Scan repo for Clerk keys and AI slop leaks", purpose: "Vibe-coded repos often commit .env.local, CLERK_SECRET_KEY, webhook secrets, and OpenAI keys beside auth config.", tool_ids: ["gitleaks", "trufflehog"] },
      { id: "clerk-config", title: "Review Clerk dashboard and env wiring", purpose: "From the repo and (if provided) dashboard read-only access, verify production vs dev keys, webhook signing (svix), allowed redirect URLs, session settings, and that secret keys never reach the client bundle.", tool_ids: ["nextjs-clerk"] },
      { id: "sast", title: "Static scan — authz gaps, XSS sinks, unsafe API routes", purpose: "AI-generated Next.js often skips auth on app/api routes, uses dangerouslySetInnerHTML, and trusts searchParams for IDs.", tool_ids: ["semgrep", "opengrep"] },
      { id: "deps", title: "Dependencies and known CVEs", purpose: "Lockfile typos, hallucinated packages, and vulnerable Next/React/Clerk versions.", tool_ids: ["trivy", "osv-scanner"] },
      { id: "live-map", title: "Map the deployed app", purpose: "Compare live routes, headers, and tech fingerprint to the repo. Find exposed _next/data, source maps, and debug endpoints.", tool_ids: ["httpx", "katana", "nuclei"] },
      { id: "middleware", title: "Middleware and route protection audit", purpose: "Read middleware.ts matcher — confirm /app, /api, and server actions are covered. Test unauthenticated access to protected paths and static bypasses.", tool_ids: ["nextjs-clerk"] },
      { id: "browser-authz", title: "Two-role authz in the test browser", purpose: "Sign in as User A and User B (Clerk test accounts). Use PwnFox containers. Proxy via ZAP/Caido. Hunt IDOR on orgId, userId, and generated CRUD IDs.", tool_ids: ["pwnfox", "cookie-editor", "foxyproxy", "zaproxy"] },
      { id: "xss", title: "XSS and unsafe HTML in client components", purpose: "Profile fields, chat UIs, error pages, and search — anywhere vibe coding used raw HTML or unsanitized user content. Confirm in proxy; save request/response to evidence/.", tool_ids: ["nextjs-clerk", "zaproxy"] },
      { id: "webhooks", title: "Clerk webhooks and server-side trust", purpose: "Verify Svix signature on webhook routes. Attempt replay/tamper only on in-scope staging if RoE allows — document missing verification as critical misconfiguration.", tool_ids: ["nextjs-clerk"] },
      { id: "report", title: "Client deliverable — findings for rebuild decision", purpose: "One finding per issue — title, severity, steps to reproduce, evidence path, business impact, fix. Recommend rebuild when critical authz or secret exposure affects all users.", tool_ids: ["asvs", "cheatsheetseries"] },
    ],
  },
  {
    id: "smb-external",
    title: "External SMB web/app audit",
    match: ["smb", "audit", "contract", "customer", "saas"],
    steps: [
      { id: "roe", title: "Rules of engagement", purpose: "Written authorization, time window, contacts, no DoS unless allowed.", tool_ids: [] },
      { id: "inventory", title: "Inventory the agreed hosts", purpose: "Only the customer’s list plus agreed wildcards.", tool_ids: ["nmap", "httpx"] },
      { id: "slop", title: "If the app was AI-built, run the AI-slop pass", purpose: "Secrets, SAST, deps, then live mapping.", tool_ids: ["gitleaks", "semgrep", "trivy"] },
      { id: "app", title: "Application mapping and access control", purpose: "Same as bounty-web but on the contracted hosts only.", tool_ids: ["zaproxy", "nuclei", "ffuf"] },
      { id: "report", title: "Deliver the report stub", purpose: "Severity, impact, evidence, fix for the customer.", tool_ids: [] },
    ],
  },
];