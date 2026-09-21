// Default Worker API is baked in; the page only exposes an optional override.
const API_BASE_DEFAULT = "https://ohqs.ukryty.workers.dev";
const LS_KEY = "ohqs.apiBase";

function apiBase() {
  const saved = localStorage.getItem(LS_KEY);
  return (saved && saved.trim()) ? saved.trim().replace(/\/+$/, "") : API_BASE_DEFAULT;
}

function setApiBase(v) {
  const t = (v || "").trim();
  if (t) localStorage.setItem(LS_KEY, t);
  else localStorage.removeItem(LS_KEY);
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
    src.textContent = "search failed: " + esc(e.message);
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
    if (r.note && bountyClass !== "contract") {
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
    src.textContent = "bounties failed: " + esc(e.message);
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
  const scope = (document.getElementById("rely-scope").value || "").trim();
  const target = (document.getElementById("rely-target").value || "").trim();
  const authorized = (document.getElementById("rely-authed").value || "false") === "true";
  const out = document.getElementById("rely-out");
  const st = document.getElementById("rely-status");
  const mdBtn = document.getElementById("rely-md");
  out.innerHTML = "";
  mdBtn.hidden = true;
  if (!situation) { st.textContent = "situation is required."; return; }
  if (!scope) { st.textContent = "scope is required — paste the program/contract, not a guess."; return; }
  if (!authorized) { st.textContent = "not authorized — the planner refuses to plan without written permission."; return; }
  const body = { situation: situation, scope: scope, authorized: true };
  if (target) body.target = target;
  st.textContent = "planning…";
  try {
    const plan = await fetchJSON("/v1/recommend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    mdBtn.hidden = false;
    st.textContent = plan.playbook_title + " · " + plan.tools.length + " tools · " + plan.steps.length + " steps";
    const info = document.createElement("p");
    info.className = "meta";
    info.textContent = "Playbook: " + plan.playbook + " — " + plan.playbook_title + "   ·   Scope: " + plan.scope;
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
  const scope = document.getElementById("rely-scope").value.trim();
  const target = document.getElementById("rely-target").value.trim();
  const body = { situation: situation, scope: scope, authorized: true };
  if (target) body.target = target;
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

// ---- boot ----

window.addEventListener("DOMContentLoaded", function () {
  const base = document.getElementById("api-base");
  if (base) {
    base.value = localStorage.getItem(LS_KEY) || "";
    base.addEventListener("change", function () {
      setApiBase(base.value);
      document.getElementById("search-results").innerHTML = "";
      document.getElementById("search-source").textContent = "";
      refreshIndex();
    });
  }
  const q = document.getElementById("search-q");
  if (q) q.addEventListener("keydown", function (ev) { if (ev.key === "Enter") runSearch(); });

  // Bounties tab: class toggle + search, loaded lazily on first view.
  document.querySelectorAll("#bounty-class button").forEach(function (b) {
    b.addEventListener("click", function () {
      setBountyClass(b.getAttribute("data-class"));
      runBountySearch();
    });
  });
  const bq = document.getElementById("bounty-q");
  if (bq) bq.addEventListener("keydown", function (ev) { if (ev.key === "Enter") runBountySearch(); });
  let bountiesLoaded = false;

  const sit = document.getElementById("rely-situation");
  if (sit) sit.addEventListener("input", syncPlaybookGate);
  document.getElementById("rely-authed").addEventListener("change", function () {
    const st = document.getElementById("rely-status");
    if (st) st.textContent = "";
  });

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

  // Deep link: /?q=command+and+control pre-fills + runs a catalog search.
  const pre = new URLSearchParams(location.search).get("q");
  if (pre) {
    q.value = pre;
    runSearch();
  }
});