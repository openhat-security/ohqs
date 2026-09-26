// Default Worker API is baked in; the page only exposes an optional override.
// When the console is served from the local worker (wrangler assets), prefer same origin.
const API_BASE_DEFAULT = "https://ohqs.ukryty.workers.dev";
const LS_KEY = "ohqs.apiBase";
const LS_KC = "ohqs.kcAccessToken";
const LS_API_TOKEN = "ohqs.apiToken";

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
  const r = await fetch(apiBase() + path, opts);
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

// ---- tabs (Catalog | Playbook) via #catalog / #playbook hash routing ----

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
  if (location.hash === "#account" || location.hash.indexOf("#ohqs_") === 0 || location.hash.indexOf("ohqs_access_token=") >= 0) return "account";
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
  }
}

window.runRecommend = async function () {
  const situation = (document.getElementById("rely-situation").value || "").trim();
  const target = (document.getElementById("rely-target").value || "").trim();
  const model = (document.getElementById("rely-model").value || "").trim();
  const out = document.getElementById("rely-out");
  const st = document.getElementById("rely-status");
  const mdBtn = document.getElementById("rely-md");
  out.innerHTML = "";
  mdBtn.hidden = true;
  if (!situation) { st.textContent = "situation is required."; return; }
  const body = { situation: situation };
  if (target) body.target = target;
  if (model) body.model = model;
  st.textContent = "planning…";
  try {
    const authTok = storedApiToken() || kcToken();
    const recHeaders = { "Content-Type": "application/json" };
    if (authTok) recHeaders["Authorization"] = "Bearer " + authTok;
    const plan = await fetchJSON("/v1/recommend", {
      method: "POST",
      headers: recHeaders,
      body: JSON.stringify(body),
    });
    mdBtn.hidden = false;
    st.textContent = plan.playbook_title + " · " + plan.tools.length + " tools · " + plan.steps.length + " steps";
    const info = document.createElement("p");
    info.className = "meta";
    info.textContent = "Playbook: " + plan.playbook + " — " + plan.playbook_title +
      (plan.scope ? "   ·   Scope: " + plan.scope : "");
    out.appendChild(info);
    (plan.steps || []).forEach(function (step) {
      const div = document.createElement("div");
      div.className = "step";
      const title = document.createElement("h3");
      title.textContent = step.n + ". " + step.title;
      div.appendChild(title);
      if (step.purpose) {
        const p = document.createElement("p");
        p.className = "meta";
        p.textContent = step.purpose;
        div.appendChild(p);
      }
      if (step.tools && step.tools.length) {
        const chips = document.createElement("p");
        chips.className = "tools";
        chips.innerHTML = step.tools.map(function (t) {
          return "<span>" + esc(t.name) + " <small>(" + esc(t.id) + ")</small></span>";
        }).join(" ");
        div.appendChild(chips);
      }
      if (step.how) {
        const h = document.createElement("p");
        h.innerHTML = "<span class='label'>How</span><br>" + step.how.replace(/\n/g, "<br>");
        div.appendChild(h);
      }
      if (step.commands && step.commands.length) {
        const pre = document.createElement("pre");
        pre.textContent = step.commands.join("\n");
        div.appendChild(pre);
      }
      if (step.links && step.links.length) {
        const ul = document.createElement("ul");
        ul.className = "links";
        (step.links || []).forEach(function (l) {
          const li = document.createElement("li");
          const a = document.createElement("a");
          a.href = l.url; a.target = "_blank"; a.rel = "noopener";
          a.textContent = l.label + " (" + l.url + ")";
          li.appendChild(a);
          ul.appendChild(li);
        });
        div.appendChild(ul);
      }
      if (step.look_for) {
        const l = document.createElement("p");
        l.innerHTML = "<span class='label'>Look for</span><br>" + step.look_for.replace(/\n/g, "<br>");
        div.appendChild(l);
      }
      if (step.next) {
        const n = document.createElement("p");
        n.innerHTML = "<span class='label'>Next</span> " + esc(step.next);
        div.appendChild(n);
      }
      out.appendChild(div);
    });
  } catch (e) {
    st.textContent = "playbook failed: " + e.message;
  }
};

window.downloadMarkdown = async function () {
  const situation = document.getElementById("rely-situation").value.trim();
  const target = document.getElementById("rely-target").value.trim();
  const model = (document.getElementById("rely-model").value || "").trim();
  const body = { situation: situation };
  if (target) body.target = target;
  if (model) body.model = model;
  try {
    const r = await fetch(apiBase() + "/v1/recommend?fmt=markdown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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



// ---- account / Keycloak / API tokens ----

function kcToken() {
  return (localStorage.getItem(LS_KC) || "").trim();
}

function setKcToken(t) {
  if (t) localStorage.setItem(LS_KC, t);
  else localStorage.removeItem(LS_KC);
}

function storedApiToken() {
  return (localStorage.getItem(LS_API_TOKEN) || "").trim();
}

function setStoredApiToken(t) {
  if (t) localStorage.setItem(LS_API_TOKEN, t);
  else localStorage.removeItem(LS_API_TOKEN);
}

async function authFetch(path, opts) {
  opts = opts || {};
  const headers = Object.assign({}, opts.headers || {});
  // Optional local debug: pasted / stored KC access token as Bearer.
  // Prefer HttpOnly cookie session (credentials: include) when no paste token.
  const tok = kcToken();
  if (tok) headers["Authorization"] = "Bearer " + tok;
  const r = await fetch(apiBase() + path, Object.assign({}, opts, {
    headers: headers,
    credentials: "include",
  }));
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
  if (!r.ok) throw new Error((data && data.error) || text || (r.status + " " + r.statusText));
  return data;
}

/** Legacy no-op: token-in-hash removed; strip any leftover #ohqs_access_token=… */
function captureOidcHash() {
  const h = location.hash || "";
  if (h.indexOf("ohqs_access_token=") < 0) return false;
  history.replaceState(null, "", location.pathname + location.search + "#account");
  return true;
}

window.loginKeycloak = function () {
  const returnTo = location.origin + location.pathname + "#account";
  location.href = apiBase() + "/v1/auth/login?return_to=" + encodeURIComponent(returnTo);
};

window.usePastedKcToken = function () {
  const el = document.getElementById("acct-paste-token");
  const t = (el && el.value || "").trim();
  if (!t) return;
  setKcToken(t);
  if (el) el.value = "";
  refreshAccount();
};

window.logoutKc = async function () {
  setKcToken("");
  setStoredApiToken("");
  try {
    await fetch(apiBase() + "/v1/auth/logout", { method: "POST", credentials: "include" });
  } catch (_) { /* ignore */ }
  refreshAccount();
};

window.signupOhqs = async function () {
  const status = document.getElementById("signup-status");
  const email = (document.getElementById("signup-email").value || "").trim();
  const password = document.getElementById("signup-password").value || "";
  const name = (document.getElementById("signup-name").value || "").trim();
  status.textContent = "creating…";
  try {
    const r = await fetchJSON("/v1/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, password: password, name: name || undefined }),
    });
    status.textContent = (r.created ? "Created " : "Existing ") + r.email + " — now Login with Keycloak.";
  } catch (e) {
    status.textContent = "signup failed: " + e.message;
  }
};

window.mintClientToken = async function () {
  const status = document.getElementById("acct-mint-status");
  const pre = document.getElementById("acct-raw-token");
  status.textContent = "minting…";
  pre.hidden = true;
  try {
    const r = await authFetch("/v1/tokens", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    setStoredApiToken(r.token);
    status.textContent = "Client token minted (prefix " + r.prefix + "). Copy now — shown once.";
    pre.textContent = r.token + "\n\n" + (r.warning || "");
    pre.hidden = false;
    await refreshAccountTokens();
  } catch (e) {
    status.textContent = "mint failed: " + e.message;
  }
};

window.mintAiToken = async function () {
  const status = document.getElementById("acct-mint-status");
  const pre = document.getElementById("acct-raw-token");
  status.textContent = "minting AI token…";
  pre.hidden = true;
  try {
    const r = await authFetch("/v1/tokens/ai", { method: "POST" });
    status.textContent = "Admin AI token minted (prefix " + r.prefix + "). Keep offline — never in README/CLI/www.";
    pre.textContent = r.token + "\n\n" + (r.warning || "");
    pre.hidden = false;
    await refreshAccountTokens();
  } catch (e) {
    status.textContent = "mint AI failed: " + e.message;
  }
};

window.revokeToken = async function (id) {
  try {
    await authFetch("/v1/tokens/" + encodeURIComponent(id) + "/revoke", { method: "POST" });
    await refreshAccountTokens();
  } catch (e) {
    alert("revoke failed: " + e.message);
  }
};

async function refreshAccountTokens() {
  const list = document.getElementById("acct-token-list");
  const usage = document.getElementById("acct-usage-list");
  if (!list) return;
  list.innerHTML = "";
  usage.innerHTML = "";
  try {
    const r = await authFetch("/v1/tokens");
    (r.tokens || []).forEach(function (tok) {
      const li = document.createElement("li");
      const revoked = tok.revoked_at ? " · REVOKED" : "";
      li.innerHTML = "<strong>" + esc(tok.type) + "</strong> " + esc(tok.prefix) + "… <span class='muted'>id=" + esc(tok.id) + revoked + "</span>";
      if (!tok.revoked_at) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn ghost";
        b.textContent = "Revoke";
        b.onclick = function () { revokeToken(tok.id); };
        li.appendChild(document.createTextNode(" "));
        li.appendChild(b);
      }
      list.appendChild(li);
    });
    if (!(r.tokens || []).length) {
      const li = document.createElement("li");
      li.textContent = "No tokens yet.";
      list.appendChild(li);
    }
  } catch (e) {
    list.innerHTML = "<li>Could not list tokens: " + esc(e.message) + "</li>";
  }
  try {
    const u = await authFetch("/v1/usage");
    (u.recent || []).slice(0, 20).forEach(function (row) {
      const li = document.createElement("li");
      li.textContent = new Date(row.ts * 1000).toLocaleString() + " · " + row.method + " " + row.route + " · " + row.status + " · ip=" + (row.ip || "?");
      usage.appendChild(li);
    });
    if (!(u.recent || []).length) {
      const li = document.createElement("li");
      li.textContent = "No usage yet.";
      usage.appendChild(li);
    }
  } catch (e) {
    usage.innerHTML = "<li>Usage unavailable: " + esc(e.message) + "</li>";
  }
}

async function refreshAccount() {
  const out = document.getElementById("acct-logged-out");
  const inn = document.getElementById("acct-logged-in");
  const userEl = document.getElementById("acct-user");
  const aiBtn = document.getElementById("acct-mint-ai");
  if (!out || !inn) return;
  // Cookie session (credentials) preferred; paste-token / localStorage KC is optional fallback.
  try {
    const me = await authFetch("/v1/auth/me");
    out.hidden = true;
    inn.hidden = false;
    const roles = me.roles || [];
    userEl.textContent = "Signed in as " + (me.email || me.sub || "?") +
      (roles.length ? (" · roles: " + roles.join(", ")) : "") +
      (me.auth ? (" · via " + me.auth) : "");
    if (aiBtn) aiBtn.hidden = roles.indexOf("admin") < 0;
    await refreshAccountTokens();
  } catch (e) {
    out.hidden = false;
    inn.hidden = true;
    if (userEl) userEl.textContent = "";
  }
}


// ---- boot ----

window.addEventListener("DOMContentLoaded", function () {
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
  syncPlaybookGate();
  refreshIndex();
  loadModels();

  captureOidcHash();
  if (pageFromHash() === "account") refreshAccount();
  window.addEventListener("hashchange", function () {
    if (pageFromHash() === "account") refreshAccount();
  });

  // Deep link: /?q=command+and+control pre-fills + runs a catalog search.
  const pre = new URLSearchParams(location.search).get("q");
  if (pre) {
    q.value = pre;
    runSearch();
  }
});