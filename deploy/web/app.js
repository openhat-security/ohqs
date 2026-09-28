// Local demo default; optional override via localStorage (ohqs.apiBase).
// When the console is served from the local worker (wrangler assets), prefer same origin.
const API_BASE_DEFAULT = "http://127.0.0.1:8788";
const LS_KEY = "ohqs.apiBase";
const TOKEN_SS_KEY = "ohqs.apiToken";

function apiBase() {
  const saved = localStorage.getItem(LS_KEY);
  if (saved && saved.trim()) return saved.trim().replace(/\/+$/, "");
  if (typeof location !== "undefined" && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(location.origin)) {
    return location.origin;
  }
  return API_BASE_DEFAULT;
}

function apiBaseIsOverride() {
  return !!(localStorage.getItem(LS_KEY) || "").trim();
}

function setApiBase(v) {
  const t = (v || "").trim();
  if (t) localStorage.setItem(LS_KEY, t);
  else localStorage.removeItem(LS_KEY);
}

function getApiToken() {
  try {
    return (sessionStorage.getItem(TOKEN_SS_KEY) || "").trim();
  } catch (_) {
    return "";
  }
}

function setApiToken(v) {
  const t = (v || "").trim();
  try {
    if (t) sessionStorage.setItem(TOKEN_SS_KEY, t);
    else sessionStorage.removeItem(TOKEN_SS_KEY);
  } catch (_) { /* private mode / quota */ }
}

function syncTokenUI() {
  const input = document.getElementById("api-token");
  const clear = document.getElementById("api-token-clear");
  const hint = document.getElementById("api-token-hint");
  const tok = getApiToken();
  if (input && document.activeElement !== input) {
    // Keep the raw token out of the visible field after save; show a placeholder mask.
    input.value = tok ? "••••••••••••" : "";
    input.dataset.hasToken = tok ? "1" : "";
  }
  if (clear) clear.hidden = !tok;
  if (hint) {
    hint.textContent = tok
      ? "Portal API token set for this tab (sessionStorage). Clear to remove."
      : "Mint in openhat-portal → Tokens. Stored in this browser tab only (sessionStorage). Never put the token in the URL.";
  }
}

function authHeaders(extra) {
  const h = {};
  if (extra) {
    Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
  }
  const tok = getApiToken();
  if (tok) h["Authorization"] = "Bearer " + tok;
  return h;
}

// debounce lets the search run as you type instead of only on Enter/Search.
function debounce(fn, ms) {
  let t = null;
  return function () {
    const args = arguments;
    if (t) clearTimeout(t);
    t = setTimeout(function () { t = null; fn.apply(null, args); }, ms);
  };
}

async function fetchJSON(path, opts) {
  opts = opts || {};
  const headers = authHeaders(opts.headers || {});
  const r = await fetch(apiBase() + path, Object.assign({}, opts, { headers: headers }));
  if (!r.ok) {
    const t = await r.text();
    throw new Error(t || (r.status + " " + r.statusText));
  }
  return r.json();
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

// ---- tabs (Catalog | Playbook | Bounties) via hash routing — no Account ----

function showPage(name) {
  document.querySelectorAll("section[data-page]").forEach(function (s) {
    s.hidden = s.getAttribute("data-page") !== name;
  });
  document.querySelectorAll("a.tab").forEach(function (a) {
    a.classList.toggle("active", a.getAttribute("data-tab") === name);
  });
}

function pageFromHash() {
  if (location.hash === "#playbook") return "playbook";
  if (location.hash === "#bounties") return "bounties";
  return "catalog";
}

// ---- catalog search ----

function paintIndex(st) {
  const el = document.getElementById("index-status");
  if (!el) return;
  if (!st || !st.exists) {
    el.innerHTML = "index unavailable — check the API base above.";
    return;
  }
  const vector = st.has_vectors ? ("vectors ✓ (" + esc(st.embedder || "?") + ")") : "lexical only";
  el.textContent = st.records + " records · " + vector;
}

async function refreshIndex() {
  try {
    paintIndex(await fetchJSON("/v1/index"));
  } catch (e) {
    const el = document.getElementById("index-status");
    if (el) el.textContent = "index status unavailable: " + esc(e.message);
  }
}

window.runSearch = async function () {
  const q = (document.getElementById("search-q").value || "").trim();
  const box = document.getElementById("search-results");
  const src = document.getElementById("search-source");
  const handoff = document.getElementById("search-to-playbook");
  if (!q) return;
  box.innerHTML = "";
  src.textContent = "searching…";
  handoff.hidden = true;
  try {
    const r = await fetchJSON("/v1/search?q=" + encodeURIComponent(q));
    src.textContent = r.source ? ("ranked by " + r.source) : "";
    box.innerHTML = "";
    (r.records || []).forEach(function (rec) {
      const li = document.createElement("li");
      li.innerHTML =
        "<strong>" + esc(rec.name) + "</strong> <span class='muted'>(" + esc(rec.kind) + " · " + esc(rec.id) + ")</span> — " + esc(rec.summary);
      const hp = (rec.homepage || "").trim();
      if (hp) {
        const a = document.createElement("a");
        a.href = hp;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = " homepage";
        li.appendChild(a);
      }
      box.appendChild(li);
    });
    if (!r.records || !r.records.length) {
      const li = document.createElement("li");
      li.textContent = "no matches for “" + q + "”";
      box.appendChild(li);
    }
    if (r.records && r.records.length) {
      handoff.querySelector("button").textContent = "Build playbook from this query →";
      handoff.hidden = false;
    }
  } catch (e) {
    src.textContent = "search failed: " + esc(e.message) + " — tried " + esc(apiBase() + "/v1/search?q=" + encodeURIComponent(q));
  }
};

// ---- bounties tab: marketplace | program, separate from the catalog ----

let bountyClass = "marketplace";
let bountySearchSeq = 0;

function setBountyClass(cls) {
  bountyClass = cls === "contract" ? "contract" : cls === "program" ? "program" : "marketplace";
  document.querySelectorAll("#bounty-class button").forEach(function (b) {
    b.classList.toggle("active", b.getAttribute("data-class") === bountyClass);
  });
  document.getElementById("bounty-search-row").hidden = false;
  document.getElementById("bounty-note").hidden = true;
  document.getElementById("bounty-note").innerHTML = "";
  document.getElementById("bounty-results").innerHTML = "";
  document.getElementById("bounty-source").textContent = "";
}

window.runBountySearch = async function () {
  const seq = ++bountySearchSeq;
  const box = document.getElementById("bounty-results");
  const src = document.getElementById("bounty-source");
  const nota = document.getElementById("bounty-note");
  const q = (document.getElementById("bounty-q").value || "").trim();
  const fresh = () => seq === bountySearchSeq;
  box.innerHTML = "";
  nota.hidden = true;
  nota.innerHTML = "";
  src.textContent = "searching…";

  if (bountyClass === "contract") {
    // Contracts: show the contributor banner, then list real program data below.
    nota.hidden = false;
    const h = document.createElement("p");
    h.className = "label";
    h.textContent = "Help wanted · a contributor with a GPU keeps this fresh";
    nota.appendChild(h);
    const p1 = document.createElement("p");
    p1.textContent = "Listing scraped from free sources (bounty-targets-data, bbscope). Refresh daily or weekly; an LLM pass cleans the scopes via runhug — shoutout @chaseleto and any GPU contributor. Proxies / dummy creds: @adamsiwiec1.";
    nota.appendChild(p1);
    const ul = document.createElement("ul");
    ul.className = "links";
    const row = (label, href) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = href; a.target = "_blank"; a.rel = "noopener"; a.textContent = label;
      li.appendChild(a);
      ul.appendChild(li);
    };
    row("runhug — repeatable GPU deploy script →", "https://github.com/adamsiwiec1/runhug");
    row("pipeline (scripts/bounty-ingest) →", "https://github.com/openhat-security/ohqs/tree/main/scripts/bounty-ingest");
    nota.appendChild(ul);
  }

  try {
    const r = await fetchJSON(
      "/v1/bounties?class=" + encodeURIComponent(bountyClass) +
      "&q=" + encodeURIComponent(q)
    );
    if (!fresh()) return;
    if (r.note && (bountyClass !== "contract" || (r.records && r.records.length))) {
      nota.hidden = false;
      nota.appendChild(document.createTextNode(r.note));
      const a = document.createElement("a");
      a.href = "https://github.com/adamsiwiec1/runhug";
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = " runhug script for contributors";
      nota.appendChild(a);
    }
    const label = bountyClass === "program" ? "programs" : (bountyClass === "contract" ? "contracts" : "marketplaces");
    src.textContent = r.note ? "" : ((r.records || []).length + " " + label +
      (r.source ? " · ranked by " + r.source : ""));
    (r.records || []).forEach(function (rec) {
      const li = document.createElement("li");
      li.innerHTML =
        "<strong>" + esc(rec.name) + "</strong> <span class='muted'>(" + esc(rec.kind) + " · " + esc(rec.id) + ")</span> — " + esc(rec.summary);
      const hp = (rec.homepage || "").trim();
      if (hp) {
        const a = document.createElement("a");
        a.href = hp;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = " homepage";
        li.appendChild(a);
      }
      box.appendChild(li);
    });
    if (!r.records || !r.records.length) {
      const li = document.createElement("li");
      li.textContent = bountyClass === "contract"
        ? (q ? "no contracts match “" + q + "”" : "no contracts ingested yet.")
        : (q ? "no " + label + " match “" + q + "”" : "no " + label + " listed.");
      box.appendChild(li);
    }
  } catch (e) {
    if (!fresh()) return;
    src.textContent = "bounties failed: " + esc(e.message) + " — tried " + esc(apiBase() + "/v1/bounties?class=" + encodeURIComponent(bountyClass) + "&q=" + encodeURIComponent(q));
  }
};

// hand the current query over to the playbook tab as the situation.
window.goPlaybookWithQuery = function () {
  const q = (document.getElementById("search-q").value || "").trim();
  if (!q) return;
  const r = document.getElementById("rely-situation");
  r.value = q;
  syncPlaybookGate();
  r.focus();
  location.hash = "#playbook";
};

// ---- playbook generator ----

let lastZipBase64 = null;
let lastZipEntries = []; // [{ path, content }] sanitized, for VS Code–style preview
let playbookMode = "written"; // written | code

/** Reject absolute paths, drive letters, and .. segments. Returns normalized relative path or null. */
function sanitizeZipPath(raw) {
  let p = String(raw == null ? "" : raw).replace(/\\/g, "/").trim();
  if (!p) return null;
  if (p.startsWith("/") || p.startsWith("~") || /^[A-Za-z]:/.test(p)) return null;
  const parts = p.split("/").filter(function (seg) { return seg.length > 0; });
  if (!parts.length) return null;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "." || parts[i] === "..") return null;
  }
  return parts.join("/");
}

function isEnvSecretFile(path) {
  const base = path.split("/").pop() || "";
  if (base === ".env.example" || base === ".env.sample" || base === ".env.template") return false;
  return base === ".env" || /^\.env\./.test(base);
}

function looksBinaryText(s) {
  if (!s) return false;
  if (s.indexOf("\u0000") !== -1) return true;
  let bad = 0;
  const n = Math.min(s.length, 2048);
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c < 9 || (c > 13 && c < 32) || c === 127) bad++;
  }
  return bad > n * 0.05;
}

/** Client-side defense-in-depth; worker already strips before zip. */
function stripSecretsForPreview(text) {
  let out = String(text == null ? "" : text);
  out = out.replace(/\bohqs_[A-Za-z0-9_-]{8,}\b/g, "ohqs_REDACTED");
  out = out.replace(/\bsk-or-v1-[A-Za-z0-9_-]{16,}\b/g, "sk-REDACTED");
  out = out.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "sk-REDACTED");
  out = out.replace(/\bBearer\s+[A-Za-z0-9._-]{20,}/gi, "Bearer REDACTED");
  // Same-line only ([ \t], not \s) so "=" cannot swallow a newline into the next key.
  out = out.replace(/^(OPENROUTER_API_KEY|LLM_API_KEY|FLEXPRICE_API_KEY|ADMIN_TOKEN|OHQS_API_TOKEN|API_TOKEN|API_KEY|SECRET|PASSWORD|TOKEN)[ \t]*=[ \t]*\S[^\r\n]*$/gim, function (m) {
    const eq = m.indexOf("=");
    return m.slice(0, eq + 1) + "REDACTED";
  });
  return out;
}

function previewContentForPath(path, content) {
  if (isEnvSecretFile(path)) {
    return {
      text: "[secrets redacted in preview]\n\nReal .env values are not shown here.\nUse Download .zip for local editing — never commit ohqs_* tokens or live API keys.\nPlaceholders belong in .env.example only.",
      placeholder: true,
    };
  }
  if (looksBinaryText(content)) {
    return { text: "[binary or non-text file — not shown in preview]", placeholder: true };
  }
  return { text: stripSecretsForPreview(content), placeholder: false };
}

function readU16(dv, o) { return dv.getUint16(o, true); }
function readU32(dv, o) { return dv.getUint32(o, true); }

/** Parse uncompressed (STORE) zip from base64. Worker zipFiles uses method 0 only. */
function parseZipStoreBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let o = 0;
  const dec = new TextDecoder("utf-8", { fatal: false });
  while (o + 30 <= bytes.length) {
    const sig = readU32(dv, o);
    if (sig !== 0x04034b50) break;
    const method = readU16(dv, o + 8);
    const comp = readU32(dv, o + 18);
    const uncomp = readU32(dv, o + 22);
    const nameLen = readU16(dv, o + 26);
    const extraLen = readU16(dv, o + 28);
    const nameStart = o + 30;
    const nameEnd = nameStart + nameLen;
    const dataStart = nameEnd + extraLen;
    const dataEnd = dataStart + comp;
    if (dataEnd > bytes.length) break;
    const name = dec.decode(bytes.subarray(nameStart, nameEnd));
    const safe = sanitizeZipPath(name);
    if (safe && method === 0 && !safe.endsWith("/")) {
      const content = dec.decode(bytes.subarray(dataStart, dataStart + uncomp));
      out.push({ path: safe, content: content });
    }
    o = dataEnd;
  }
  return out;
}

/** Normalize zip_files API field and/or decoded zip_base64 into sanitized entries. */
function normalizeZipEntries(zipFiles, zipBase64) {
  const byPath = Object.create(null);
  function add(path, content) {
    const safe = sanitizeZipPath(path);
    if (!safe) return;
    if (Object.prototype.hasOwnProperty.call(byPath, safe)) return;
    byPath[safe] = content == null ? "" : String(content);
  }
  if (Array.isArray(zipFiles)) {
    zipFiles.forEach(function (item) {
      if (typeof item === "string") {
        add(item, "");
      } else if (item && typeof item === "object") {
        add(item.path || item.name, item.content != null ? item.content : "");
      }
    });
  }
  if (zipBase64) {
    try {
      parseZipStoreBase64(zipBase64).forEach(function (f) {
        // Prefer decoded content when zip_files was path-only or empty.
        if (!Object.prototype.hasOwnProperty.call(byPath, f.path) || byPath[f.path] === "") {
          byPath[f.path] = f.content;
        }
      });
    } catch (_) { /* keep whatever zip_files gave */ }
  }
  return Object.keys(byPath).sort().map(function (p) {
    return { path: p, content: byPath[p] };
  });
}

function buildZipTree(paths) {
  const root = { name: "", kids: Object.create(null), files: [] };
  paths.forEach(function (p) {
    const parts = p.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        node.files.push({ name: part, path: p });
      } else {
        if (!node.kids[part]) node.kids[part] = { name: part, kids: Object.create(null), files: [] };
        node = node.kids[part];
      }
    }
  });
  return root;
}


/** PLAYBOOK tab: markdown engagement steps only — never dump lab Python/src. */
function renderPlaybookMarkdown(out, plan, zipEntries) {
  if (!out) return;
  out.innerHTML = "";
  if (plan.lab_notice) {
    const lab = document.createElement("p");
    lab.className = "callout";
    lab.textContent = plan.lab_notice;
    out.appendChild(lab);
  }
  const info = document.createElement("p");
  info.className = "meta";
  info.textContent = "Playbook: " + (plan.playbook || "?") + " — " + (plan.playbook_title || "") +
    (plan.scope ? "   ·   Scope: " + plan.scope : "");
  out.appendChild(info);
  let md = "";
  const entries = zipEntries || lastZipEntries || [];
  const pb = entries.find(function (e) { return e.path === "PLAYBOOK.md"; });
  if (pb && pb.content && String(pb.content).trim()) {
    md = String(pb.content);
  } else {
    // Synthesize engagement markdown from steps (no lab source files).
    const lines = ["# Engagement plan", ""];
    if (plan.playbook_title) lines.push("**Playbook:** " + plan.playbook_title + (plan.playbook ? " (" + plan.playbook + ")" : ""), "");
    if (plan.goal) lines.push("**Goal:** " + plan.goal, "");
    if (plan.scope) lines.push("**Scope:** " + plan.scope, "");
    lines.push("## Steps", "");
    (plan.steps || []).forEach(function (step) {
      lines.push("### " + step.n + ". " + step.title, "");
      if (step.purpose) lines.push("**Purpose:** " + step.purpose, "");
      if (step.how) lines.push("**How:**", "", step.how, "");
      if (step.commands && step.commands.length) {
        lines.push("**Commands:**", "", "```bash");
        step.commands.forEach(function (c) { lines.push(c); });
        lines.push("```", "");
      }
      if (step.look_for) lines.push("**What to look for:**", "", step.look_for, "");
      if (step.next) lines.push("**Next:** " + step.next, "");
    });
    if (plan.checklist && plan.checklist.length) {
      lines.push("## Coverage checklist", "");
      plan.checklist.forEach(function (c) { lines.push("- [ ] " + c); });
    }
    lines.push("", "---", "ohqs does not generate exploits or payloads. Detection, triage, and reporting only.");
    md = lines.join("\n");
  }
  // Strip accidental lab Python dumps if a bad PLAYBOOK.md ever includes them.
  if (/^```python/m.test(md) || /\bdef check_sqli\b/.test(md) || /\bdef check_xss\b/.test(md)) {
    md = md
      .replace(/```python[\s\S]*?```/g, "```\n[lab Python omitted from PLAYBOOK — see files tab]\n```")
      .replace(/\bdef check_sqli\b[\s\S]*?(?=\ndef |\n#|$)/g, "")
      .replace(/\bdef check_xss\b[\s\S]*?(?=\ndef |\n#|$)/g, "");
  }
  const pre = document.createElement("pre");
  pre.className = "playbook-md";
  pre.textContent = md;
  out.appendChild(pre);
}

function hideZipPreview() {
  lastZipEntries = [];
  const wrap = document.getElementById("result-preview");
  if (wrap) wrap.hidden = true;
  const panel = document.getElementById("zip-preview");
  if (panel) panel.hidden = true;
  const tree = document.getElementById("zip-tree");
  if (tree) tree.innerHTML = "";
  const pathEl = document.getElementById("zip-editor-path");
  if (pathEl) pathEl.textContent = "Select a file";
  const body = document.getElementById("zip-editor-body");
  if (body) {
    body.textContent = "";
    body.classList.remove("is-placeholder");
  }
  const pb = document.getElementById("rely-out-playbook");
  if (pb) pb.innerHTML = "";
  const sg = document.getElementById("rely-status-grid");
  if (sg) sg.innerHTML = "";
  const dl = document.getElementById("zip-preview-download");
  if (dl) dl.hidden = true;
}

function activateResultTab(name) {
  document.querySelectorAll(".rtab[data-rtab]").forEach(function (t) {
    const on = t.getAttribute("data-rtab") === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll("[data-rtab-panel]").forEach(function (p) {
    const on = p.getAttribute("data-rtab-panel") === name;
    p.classList.toggle("active", on);
    p.hidden = !on;
  });
}

function paintStatusGrid(plan, used, planSt, scafSt) {
  const sg = document.getElementById("rely-status-grid");
  if (!sg) return;
  function row(dt, dd, cls) {
    const wrap = document.createElement("div");
    const dte = document.createElement("dt");
    dte.textContent = dt;
    const dde = document.createElement("dd");
    dde.textContent = dd;
    if (cls) dde.className = cls;
    wrap.appendChild(dte);
    wrap.appendChild(dde);
    sg.appendChild(wrap);
  }
  sg.innerHTML = "";
  row("Credits used", used + " credit" + (used === 1 ? "" : "s"));
  row("Plan", planSt || "?", planSt === "live" ? "st-live" : (planSt === "template" ? "st-fallback" : ""));
  const sc = plan.mode === "code" ? (scafSt || "?") : "n/a";
  row("Scaffold", sc, sc === "live" ? "st-live" : (sc === "stub" ? "st-fallback" : ""));
  row("Mode", plan.mode === "code"
    ? ("code · " + (plan.language || "?") + " · complexity " + (plan.complexity || "?"))
    : "written");
}

function selectZipPreviewFile(path) {
  const entry = lastZipEntries.find(function (e) { return e.path === path; });
  const pathEl = document.getElementById("zip-editor-path");
  const body = document.getElementById("zip-editor-body");
  if (!pathEl || !body) return;
  document.querySelectorAll("#zip-tree button.file-node").forEach(function (b) {
    b.classList.toggle("active", b.getAttribute("data-path") === path);
  });
  if (!entry) {
    pathEl.textContent = path || "Select a file";
    body.textContent = "";
    body.classList.remove("is-placeholder");
    return;
  }
  pathEl.textContent = entry.path;
  const preview = previewContentForPath(entry.path, entry.content);
  // textContent only — never innerHTML / eval / live HTML·SVG render
  body.textContent = preview.text;
  body.classList.toggle("is-placeholder", !!preview.placeholder);
}

function renderZipTreeNode(node, ul) {
  const dirNames = Object.keys(node.kids).sort();
  dirNames.forEach(function (dn) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.className = "dir-label";
    label.textContent = dn + "/";
    li.appendChild(label);
    const childUl = document.createElement("ul");
    renderZipTreeNode(node.kids[dn], childUl);
    li.appendChild(childUl);
    ul.appendChild(li);
  });
  node.files.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (f) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "file-node";
    btn.setAttribute("data-path", f.path);
    btn.textContent = f.name;
    btn.addEventListener("click", function () { selectZipPreviewFile(f.path); });
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

function showZipPreview(entries) {
  lastZipEntries = entries || [];
  const wrap = document.getElementById("result-preview");
  const panel = document.getElementById("zip-preview");
  const tree = document.getElementById("zip-tree");
  const filesTab = document.querySelector('.rtab[data-rtab="files"]');
  if (wrap) wrap.hidden = false;
  if (!panel || !tree) return;
  tree.innerHTML = "";
  if (!lastZipEntries.length) {
    if (filesTab) filesTab.disabled = true;
    panel.hidden = true;
    return;
  }
  if (filesTab) filesTab.disabled = false;
  panel.hidden = false;
  const dl = document.getElementById("zip-preview-download");
  if (dl) dl.hidden = !lastZipBase64;
  const rootUl = document.createElement("ul");
  renderZipTreeNode(buildZipTree(lastZipEntries.map(function (e) { return e.path; })), rootUl);
  tree.appendChild(rootUl);
  let first = lastZipEntries.find(function (e) { return e.path === "PLAYBOOK.md"; });
  if (!first) first = lastZipEntries[0];
  if (first) selectZipPreviewFile(first.path);
}

function recommendCreditsPreview(mode, complexity) {
  if (mode !== "code") return 1;
  const c = Math.max(1, Math.min(10, parseInt(complexity, 10) || 1));
  return 1 + Math.max(0, c - 1);
}

function syncCodeOpts() {
  const opts = document.getElementById("rely-code-opts");
  const zipBtn = document.getElementById("rely-zip");
  const hint = document.getElementById("rely-mode-hint");
  if (opts) opts.hidden = playbookMode !== "code";
  if (zipBtn && playbookMode !== "code") zipBtn.hidden = true;
  if (hint) {
    hint.textContent = playbookMode === "code"
      ? "Plan + code downloads a .zip with PLAYBOOK.md plus an authorized lab scaffold (install/setup/detect stubs). Never weaponized. Server charges credits at job start — UI preview is not the control."
      : "Written plan returns a markdown engagement playbook. Plan + code adds a downloadable .zip with the written plan plus an authorized lab scaffold (setup / detect / report stubs only — never weaponized payloads).";
  }
  updateCreditsPreview();
}

function updateCreditsPreview() {
  const el = document.getElementById("rely-credits-preview");
  if (!el) return;
  const c = (document.getElementById("rely-complexity") || {}).value || 3;
  const credits = recommendCreditsPreview(playbookMode, c);
  el.innerHTML = "Est. credits: <strong>" + credits + "</strong> (written = 1; code base 1, complexity premium only when both plan and scaffold are live LLM)";
}


function setPlanningProgress(state, opts) {
  opts = opts || {};
  const wrap = document.getElementById("rely-progress");
  const txt = document.getElementById("rely-progress-text");
  if (!wrap || !txt) return;
  if (state === "hide") {
    wrap.hidden = true;
    wrap.classList.remove("is-done", "is-fallback");
    txt.textContent = "";
    return;
  }
  wrap.hidden = false;
  wrap.classList.toggle("is-done", state === "done");
  wrap.classList.toggle("is-fallback", state === "fallback");
  if (state === "planning") {
    const n = opts.est != null ? opts.est : "?";
    txt.innerHTML = "planning… (est. <span class=\"credits\">" + n + " credits</span> · charged at job start)";
  } else if (state === "done" || state === "fallback") {
    const n = opts.used != null ? opts.used : "?";
    const split = opts.split ? (" · " + opts.split) : "";
    txt.innerHTML = "done · <span class=\"credits\">" + n + " used</span>" + (split ? "<span class=\"meta\">" + split + "</span>" : "");
  }
}

function setPlaybookMode(mode) {
  playbookMode = mode === "code" ? "code" : "written";
  const written = document.getElementById("rely-mode-written");
  const code = document.getElementById("rely-mode-code");
  if (written) written.classList.toggle("active", playbookMode === "written");
  if (code) code.classList.toggle("active", playbookMode === "code");
  syncCodeOpts();
}


// Populate the model / router dropdown from /v1/llm/models. The backend (Workers
// AI or the configured OpenAI-compatible / OpenRouter endpoint) is decided on the
// server; here we only render its offer list.
async function loadModels() {
  const sel = document.getElementById("rely-model");
  if (!sel) return;
  sel.innerHTML = '<option value="">server default…</option>';
  try {
    const r = await fetchJSON("/v1/llm/models");
    const opts = Array.isArray(r.models) ? r.models : [];
    sel.disabled = opts.length === 0;
    sel.innerHTML = "";
    if (!opts.length) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "server default (" + (r.active || "?") + ")";
      sel.appendChild(o);
      return;
    }
    opts.forEach(function (m) {
      const o = document.createElement("option");
      o.value = m.id;
      let label = m.name || m.id;
      if (m.router) label += " · router";
      else if (m.free) label += " · free";
      if (m.context) label += " · " + m.context + " ctx";
      o.textContent = label;
      if (m.id === r.active) o.selected = true;
      sel.appendChild(o);
    });
  } catch (e) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "server default (no model list)";
    sel.appendChild(o);
  }
}

// situation unlocks the scope/target/authorized gate.
function syncPlaybookGate() {
  const has = (document.getElementById("rely-situation").value || "").trim() !== "";
  const gate = document.getElementById("rely-gate");
  gate.hidden = !has;
  if (!has) {
    document.getElementById("rely-status").textContent = "";
    document.getElementById("rely-out").innerHTML = "";
    document.getElementById("rely-md").hidden = true;
    const zipBtn = document.getElementById("rely-zip");
    if (zipBtn) zipBtn.hidden = true;
    lastZipBase64 = null;
    hideZipPreview();
    setPlanningProgress("hide");
    const banner = document.getElementById("rely-fallback-banner");
    if (banner) { banner.hidden = true; banner.textContent = ""; }
  } else {
    syncCodeOpts();
  }
}

window.runRecommend = async function () {
  const situation = (document.getElementById("rely-situation").value || "").trim();
  const target = (document.getElementById("rely-target").value || "").trim();
  const model = (document.getElementById("rely-model").value || "").trim();
  const outLegacy = document.getElementById("rely-out");
  const out = document.getElementById("rely-out-playbook") || outLegacy;
  const st = document.getElementById("rely-status");
  const mdBtn = document.getElementById("rely-md");
  const zipBtn = document.getElementById("rely-zip");
  if (outLegacy) outLegacy.innerHTML = "";
  if (out) out.innerHTML = "";
  mdBtn.hidden = true;
  if (zipBtn) zipBtn.hidden = true;
  lastZipBase64 = null;
  hideZipPreview();
  if (!situation) { st.textContent = "situation is required."; return; }
  const body = { situation: situation, mode: playbookMode, authorized: true };
  if (target) body.target = target;
  if (model) body.model = model;
  if (playbookMode === "code") {
    body.language = (document.getElementById("rely-language").value || "python").trim();
    body.complexity = parseInt((document.getElementById("rely-complexity").value || "3"), 10);
  }
  const est = recommendCreditsPreview(playbookMode, body.complexity || 1);
  const banner = document.getElementById("rely-fallback-banner");
  if (banner) { banner.hidden = true; banner.textContent = ""; }
  setPlanningProgress("planning", { est: est });
  st.textContent = "";
  try {
    // Console has no login — /v1/recommend needs ohqs_* (paste field → Bearer).
    const plan = await fetchJSON("/v1/recommend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    mdBtn.hidden = false;
    if (plan.mode === "code" && (plan.zip_base64 || (plan.zip_files && plan.zip_files.length))) {
      lastZipBase64 = plan.zip_base64 || null;
      const entries = normalizeZipEntries(plan.zip_files, plan.zip_base64);
      if (entries.length) {
        showZipPreview(entries);
        // Primary download lives on the preview panel; keep legacy btn as secondary.
        if (zipBtn) zipBtn.hidden = false;
      } else if (plan.zip_base64 && zipBtn) {
        zipBtn.hidden = false;
      }
    }
    const used = plan.recommend_credits != null ? plan.recommend_credits : est;
    const note = (plan.planner_note || "").trim();
    const planSt = plan.plan_status || (/plan:\s*template|using template/i.test(note) ? "template" : "live");
    let scafSt = plan.scaffold_status || plan.scaffold || null;
    if (scafSt === "llm") scafSt = "live";
    if (scafSt === "deterministic") scafSt = "stub";
    const splitBits = ["plan: " + planSt];
    if (plan.mode === "code") splitBits.push("scaffold: " + (scafSt || "?"));
    const split = splitBits.join(" · ");
    const anyFallback = planSt === "template" || scafSt === "stub";
    const modeNote = plan.mode === "code" ? (" · plan+code/" + (plan.language || "?") + "/c" + (plan.complexity || "?")) : "";
    // Always show split in progress; amber banner only when plan or scaffold fell back.
    setPlanningProgress(anyFallback ? "fallback" : "done", { used: used, split: split });
    if (banner) {
      if (anyFallback) {
        banner.hidden = false;
        const head = planSt === "template" && scafSt === "live"
          ? "Plan used template (scaffold live) — complexity premium not charged. "
          : planSt === "live" && scafSt === "stub"
            ? "Scaffold stub (plan live) — complexity premium not charged. "
            : planSt === "template" && scafSt === "stub"
              ? "Plan template + scaffold stub — 1 credit. "
              : planSt === "template"
                ? "Plan template fallback. "
                : "Partial LLM fallback. ";
        banner.textContent = split + " — " + head + (note || "");
      } else {
        banner.hidden = true;
        banner.textContent = "";
      }
    }
    const creditNote = " · " + used + " credit" + (used === 1 ? "" : "s") + " used · " + split;
    st.textContent = plan.playbook_title + " · " + (plan.tools || []).length + " tools · " + (plan.steps || []).length + " steps" + modeNote + creditNote;
    const resultWrap = document.getElementById("result-preview");
    if (resultWrap) resultWrap.hidden = false;
    paintStatusGrid(plan, used, planSt, scafSt);
    activateResultTab("playbook");
    const filesTabBtn = document.querySelector('.rtab[data-rtab="files"]');
    if (filesTabBtn && !(plan.mode === "code" && lastZipEntries.length)) filesTabBtn.disabled = true;
    else if (filesTabBtn) filesTabBtn.disabled = false;
    renderPlaybookMarkdown(out, plan, lastZipEntries);
  } catch (e) {
    setPlanningProgress("hide");
    var msg = e.message || String(e);
    if (/401|API token|ohqs_/i.test(msg)) {
      st.textContent = "playbook needs an ohqs_* API token — paste yours below (mint in openhat-portal → Tokens). This console has no login.";
    } else {
      st.textContent = "playbook failed: " + msg;
    }
  }
};

window.downloadMarkdown = async function () {
  const situation = document.getElementById("rely-situation").value.trim();
  const target = document.getElementById("rely-target").value.trim();
  const model = (document.getElementById("rely-model").value || "").trim();
  const body = { situation: situation, mode: "written", authorized: true };
  if (target) body.target = target;
  if (model) body.model = model;
  try {
    const r = await fetch(apiBase() + "/v1/recommend?fmt=markdown", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await r.text());
    const txt = await r.text();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([txt], { type: "text/markdown" }));
    a.download = "ohqs-plan.md";
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    const st = document.getElementById("rely-status");
    st.textContent = "markdown failed: " + e.message;
  }
};




window.downloadZip = function () {
  const st = document.getElementById("rely-status");
  if (!lastZipBase64) {
    if (st) st.textContent = "No zip yet — build with Plan + code first (zip is included in that job; re-download is free).";
    return;
  }
  try {
    const bin = atob(lastZipBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    a.download = "ohqs-lab.zip";
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    if (st) st.textContent = "zip download failed: " + e.message;
  }
};

// ---- boot ----

window.addEventListener("DOMContentLoaded", function () {
  document.querySelectorAll(".rtab[data-rtab]").forEach(function (b) {
    b.addEventListener("click", function () {
      if (b.disabled) return;
      activateResultTab(b.getAttribute("data-rtab"));
    });
  });
  const tokenInput = document.getElementById("api-token");
  const tokenClear = document.getElementById("api-token-clear");
  syncTokenUI();
  if (tokenInput) {
    tokenInput.addEventListener("focus", function () {
      // Allow replacing a masked value with a fresh paste.
      if (tokenInput.dataset.hasToken === "1") {
        tokenInput.value = "";
        tokenInput.dataset.editing = "1";
      }
    });
    tokenInput.addEventListener("change", function () {
      const v = (tokenInput.value || "").trim();
      if (v && v.indexOf("•") === -1) {
        setApiToken(v);
      } else if (!v && tokenInput.dataset.editing !== "1") {
        // Explicit empty save (not just blur after clearing the mask).
        setApiToken("");
      }
      // If editing was opened via focus-mask-clear and left empty, keep existing token.
      delete tokenInput.dataset.editing;
      syncTokenUI();
    });
    tokenInput.addEventListener("blur", function () {
      delete tokenInput.dataset.editing;
      syncTokenUI();
    });
    tokenInput.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") {
        ev.preventDefault();
        tokenInput.blur();
      }
    });
  }
  if (tokenClear) {
    tokenClear.addEventListener("click", function () {
      setApiToken("");
      if (tokenInput) tokenInput.value = "";
      syncTokenUI();
    });
  }

  const base = document.getElementById("api-base");
  const baseReset = document.getElementById("api-base-reset");
  if (base) {
    base.value = localStorage.getItem(LS_KEY) || "";
    base.addEventListener("change", function () {
      if (base.value) setApiBase(base.value);
      else localStorage.removeItem(LS_KEY);
      if (baseReset) baseReset.hidden = !apiBaseIsOverride();
      document.getElementById("search-results").innerHTML = "";
      document.getElementById("search-source").textContent = "";
      refreshIndex();
    });
  }
  if (baseReset) {
    baseReset.hidden = !apiBaseIsOverride();
    baseReset.addEventListener("click", function () {
      localStorage.removeItem(LS_KEY);
      if (base) base.value = "";
      baseReset.hidden = true;
      refreshIndex();
    });
  }
  const q = document.getElementById("search-q");
  if (q) q.addEventListener("keydown", function (ev) { if (ev.key === "Enter") runSearch(); });
  if (q) q.addEventListener("input", debounce(runSearch, 350));

  // Bounties tab: class toggle + search, loaded lazily on first view.
  document.querySelectorAll("#bounty-class button").forEach(function (b) {
    b.addEventListener("click", function () {
      setBountyClass(b.getAttribute("data-class"));
      runBountySearch();
    });
  });
  const bq = document.getElementById("bounty-q");
  if (bq) bq.addEventListener("keydown", function (ev) { if (ev.key === "Enter") runBountySearch(); });
  if (bq) bq.addEventListener("input", debounce(runBountySearch, 350));
  let bountiesLoaded = false;

  const sit = document.getElementById("rely-situation");
  if (sit) sit.addEventListener("input", syncPlaybookGate);

  window.addEventListener("hashchange", function () {
    const page = pageFromHash();
    showPage(page);
    if (page === "bounties" && !bountiesLoaded) {
      bountiesLoaded = true;
      runBountySearch();
    }
  });
  const startPage = pageFromHash();
  showPage(startPage);
  if (startPage === "bounties") {
    bountiesLoaded = true;
    runBountySearch();
  }
  const modeSeg = document.getElementById("rely-mode-seg");
  if (modeSeg) {
    modeSeg.addEventListener("click", function (ev) {
      const btn = ev.target && ev.target.closest ? ev.target.closest("[data-mode]") : null;
      if (!btn) return;
      setPlaybookMode(btn.getAttribute("data-mode"));
    });
  }
  const complexity = document.getElementById("rely-complexity");
  if (complexity) {
    complexity.addEventListener("input", updateCreditsPreview);
    complexity.addEventListener("change", updateCreditsPreview);
  }
  setPlaybookMode("written");
  syncPlaybookGate();
  refreshIndex();
  loadModels();

  // Deep link: /?q=command+and+control pre-fills + runs a catalog search.
  const pre = new URLSearchParams(location.search).get("q");
  if (pre) {
    q.value = pre;
    runSearch();
  }
});