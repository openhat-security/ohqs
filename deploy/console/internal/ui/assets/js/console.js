/* OpenHat ohqs console — client helpers (token, models, tabs, zip, catalog, bounties). No auto-exec. */
(function () {
  "use strict";

  var TOKEN_KEY = "ohqs.apiToken";
  var lastZipB64 = null;
  var fileMap = Object.create(null);
  var bountyClass = "marketplace";
  var bountySearchSeq = 0;
  var bountiesLoaded = false;
  var searchSeq = 0;

  function getToken() {
    try { return (sessionStorage.getItem(TOKEN_KEY) || "").trim(); } catch (_) { return ""; }
  }
  function setToken(v) {
    v = (v || "").trim();
    try {
      if (v) sessionStorage.setItem(TOKEN_KEY, v);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch (_) {}
  }

  function syncTokenUI() {
    var input = document.getElementById("api-token");
    var clear = document.getElementById("api-token-clear");
    var hint = document.getElementById("api-token-hint");
    var field = document.getElementById("api_token_field");
    var tok = getToken();
    if (field) field.value = tok;
    if (input && document.activeElement !== input) {
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

  function creditsPreview(mode, complexity) {
    if (mode !== "code") return 1;
    var c = Math.max(1, Math.min(10, parseInt(complexity, 10) || 1));
    return 1 + Math.max(0, c - 1);
  }

  function syncModeUI() {
    var modeEl = document.querySelector('input[name="mode"]:checked');
    var mode = modeEl && modeEl.value === "code" ? "code" : "written";
    var opts = document.getElementById("code-opts");
    var hint = document.getElementById("mode-hint");
    var credits = document.getElementById("credits-preview");
    var complexity = (document.getElementById("complexity") || {}).value || 3;
    if (opts) opts.hidden = mode !== "code";
    if (hint) {
      hint.textContent = mode === "code"
        ? "Plan + code downloads a .zip with PLAYBOOK.md plus an authorized lab scaffold (install/setup/detect stubs). Never weaponized. Server charges credits at job start — UI preview is not the control."
        : "Written plan returns a markdown engagement playbook. Plan + code adds a downloadable .zip with PLAYBOOK.md plus an authorized lab scaffold (setup / detect / report stubs only — never weaponized payloads).";
    }
    if (credits) {
      var n = creditsPreview(mode, complexity);
      credits.textContent = "";
      credits.appendChild(document.createTextNode("Est. credits: "));
      var strong = document.createElement("strong");
      strong.textContent = String(n);
      credits.appendChild(strong);
      credits.appendChild(document.createTextNode(" (written = 1; code base 1, complexity premium only when both plan and scaffold are live LLM)"));
    }
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments;
      var self = this;
      if (t) clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(self, args); }, ms);
    };
  }

  async function fetchJSON(path) {
    var headers = {};
    var tok = getToken();
    if (tok) headers["X-OHQS-Token"] = tok;
    var r = await fetch(path, { headers: headers });
    if (!r.ok) {
      var t = await r.text();
      throw new Error(t || (r.status + " " + r.statusText));
    }
    return r.json();
  }

  // ---- page switcher (Playbook | Catalog | Bounties) via hash ----

  function pageFromHash() {
    if (location.hash === "#catalog") return "catalog";
    if (location.hash === "#bounties") return "bounties";
    return "playbook";
  }

  function showPage(name) {
    document.querySelectorAll(".page[data-page]").forEach(function (s) {
      var on = s.getAttribute("data-page") === name;
      // result-mount is a div: hide only when empty or wrong page; keep visible on playbook
      if (s.id === "result-mount") {
        s.hidden = name !== "playbook";
        return;
      }
      s.hidden = !on;
    });
    document.querySelectorAll("a.nav-link[data-page]").forEach(function (a) {
      a.classList.toggle("active", a.getAttribute("data-page") === name);
    });
  }

  // ---- catalog search (textContent / createElement only — no untrusted HTML) ----

  function appendRecord(box, rec) {
    var li = document.createElement("li");
    var strong = document.createElement("strong");
    strong.textContent = rec.name || "";
    li.appendChild(strong);
    var muted = document.createElement("span");
    muted.className = "muted";
    muted.textContent = " (" + (rec.kind || "") + " · " + (rec.id || "") + ")";
    li.appendChild(muted);
    li.appendChild(document.createTextNode(" — " + (rec.summary || "")));
    var hp = (rec.homepage || "").trim();
    if (hp) {
      var a = document.createElement("a");
      a.href = hp;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = " homepage";
      li.appendChild(a);
    }
    box.appendChild(li);
  }

  async function runSearch() {
    var seq = ++searchSeq;
    var q = ((document.getElementById("search-q") || {}).value || "").trim();
    var box = document.getElementById("search-results");
    var src = document.getElementById("search-source");
    var handoff = document.getElementById("search-to-playbook");
    if (!box || !src) return;
    if (!q) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    src.textContent = "searching…";
    if (handoff) handoff.hidden = true;
    try {
      var r = await fetchJSON("/v1/search?q=" + encodeURIComponent(q));
      if (seq !== searchSeq) return;
      src.textContent = r.source ? ("ranked by " + r.source) : "";
      while (box.firstChild) box.removeChild(box.firstChild);
      (r.records || []).forEach(function (rec) { appendRecord(box, rec); });
      if (!r.records || !r.records.length) {
        var li = document.createElement("li");
        li.textContent = "no matches for “" + q + "”";
        box.appendChild(li);
      }
      if (handoff && r.records && r.records.length) handoff.hidden = false;
    } catch (e) {
      if (seq !== searchSeq) return;
      src.textContent = "search failed: " + (e && e.message ? e.message : String(e)) +
        " — tried /v1/search?q=" + encodeURIComponent(q);
    }
  }

  function goPlaybookWithQuery() {
    var q = ((document.getElementById("search-q") || {}).value || "").trim();
    if (!q) return;
    var sit = document.getElementById("situation");
    if (sit) {
      sit.value = q;
      sit.focus();
    }
    location.hash = "#playbook";
  }

  // ---- bounties ----

  function setBountyClass(cls) {
    bountyClass = cls === "contract" ? "contract" : cls === "program" ? "program" : "marketplace";
    document.querySelectorAll("#bounty-class button[data-class]").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-class") === bountyClass);
    });
    var row = document.getElementById("bounty-search-row");
    if (row) row.hidden = false;
    var nota = document.getElementById("bounty-note");
    if (nota) {
      nota.hidden = true;
      while (nota.firstChild) nota.removeChild(nota.firstChild);
    }
    var box = document.getElementById("bounty-results");
    if (box) while (box.firstChild) box.removeChild(box.firstChild);
    var src = document.getElementById("bounty-source");
    if (src) src.textContent = "";
  }

  function paintContractNote(nota) {
    while (nota.firstChild) nota.removeChild(nota.firstChild);
    nota.hidden = false;
    var h = document.createElement("p");
    h.className = "eyebrow";
    h.textContent = "Help wanted · a contributor with a GPU keeps this fresh";
    nota.appendChild(h);
    var p1 = document.createElement("p");
    p1.textContent = "Listing scraped from free sources (bounty-targets-data, bbscope). Refresh daily or weekly; an LLM pass cleans the scopes via runhug — shoutout @chaseleto and any GPU contributor. Proxies / dummy creds: @adamsiwiec1.";
    nota.appendChild(p1);
    var ul = document.createElement("ul");
    ul.className = "links";
    function row(label, href) {
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = label;
      li.appendChild(a);
      ul.appendChild(li);
    }
    row("runhug — repeatable GPU deploy script →", "https://github.com/adamsiwiec1/runhug");
    row("pipeline (scripts/bounty-ingest) →", "https://github.com/openhat-security/ohqs/tree/main/scripts/bounty-ingest");
    nota.appendChild(ul);
  }

  async function runBountySearch() {
    var seq = ++bountySearchSeq;
    var box = document.getElementById("bounty-results");
    var src = document.getElementById("bounty-source");
    var nota = document.getElementById("bounty-note");
    var q = ((document.getElementById("bounty-q") || {}).value || "").trim();
    if (!box || !src) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    if (nota) {
      nota.hidden = true;
      while (nota.firstChild) nota.removeChild(nota.firstChild);
    }
    src.textContent = "searching…";

    if (bountyClass === "contract" && nota) paintContractNote(nota);

    try {
      var r = await fetchJSON(
        "/v1/bounties?class=" + encodeURIComponent(bountyClass) +
        "&q=" + encodeURIComponent(q)
      );
      if (seq !== bountySearchSeq) return;
      if (r.note && nota && (bountyClass !== "contract" || (r.records && r.records.length))) {
        if (bountyClass !== "contract") {
          while (nota.firstChild) nota.removeChild(nota.firstChild);
        }
        nota.hidden = false;
        nota.appendChild(document.createTextNode(r.note));
        var a = document.createElement("a");
        a.href = "https://github.com/adamsiwiec1/runhug";
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = " runhug script for contributors";
        nota.appendChild(a);
      }
      var label = bountyClass === "program" ? "programs" : (bountyClass === "contract" ? "contracts" : "marketplaces");
      src.textContent = r.note ? "" : ((r.records || []).length + " " + label +
        (r.source ? " · ranked by " + r.source : ""));
      (r.records || []).forEach(function (rec) { appendRecord(box, rec); });
      if (!r.records || !r.records.length) {
        var li = document.createElement("li");
        li.textContent = bountyClass === "contract"
          ? (q ? "no contracts match “" + q + "”" : "no contracts ingested yet.")
          : (q ? "no " + label + " match “" + q + "”" : "no " + label + " listed.");
        box.appendChild(li);
      }
    } catch (e) {
      if (seq !== bountySearchSeq) return;
      src.textContent = "bounties failed: " + (e && e.message ? e.message : String(e)) +
        " — tried /v1/bounties?class=" + encodeURIComponent(bountyClass) + "&q=" + encodeURIComponent(q);
    }
  }

  async function loadModels() {
    var sel = document.getElementById("model");
    if (!sel) return;
    try {
      var r = await fetch("/v1/llm/models");
      if (!r.ok) throw new Error(String(r.status));
      var data = await r.json();
      var opts = Array.isArray(data.models) ? data.models : [];
      while (sel.firstChild) sel.removeChild(sel.firstChild);
      if (!opts.length) {
        var o = document.createElement("option");
        o.value = "";
        o.textContent = "server default (" + (data.active || "?") + ")";
        sel.appendChild(o);
        return;
      }
      opts.forEach(function (m) {
        var o = document.createElement("option");
        o.value = m.id;
        var label = m.name || m.id;
        if (m.router) label += " · router";
        else if (m.free) label += " · free";
        if (m.context) label += " · " + m.context + " ctx";
        o.textContent = label;
        if (m.id === data.active) o.selected = true;
        sel.appendChild(o);
      });
    } catch (_) {
      while (sel.firstChild) sel.removeChild(sel.firstChild);
      var fallback = document.createElement("option");
      fallback.value = "";
      fallback.textContent = "server default";
      sel.appendChild(fallback);
    }
  }

  function readJSON(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    try { return JSON.parse(el.textContent || "null"); } catch (_) { return null; }
  }

  function hydrateFiles() {
    fileMap = Object.create(null);
    var files = readJSON("zip-files-json");
    var b64 = readJSON("zip-b64-json");
    lastZipB64 = typeof b64 === "string" ? b64 : null;
    var zipBtn = document.getElementById("btn-zip");
    if (zipBtn) zipBtn.hidden = !lastZipB64;
    if (!Array.isArray(files)) return;
    files.forEach(function (f) {
      if (f && f.path) fileMap[f.path] = f;
    });
    var prefer = fileMap["PLAYBOOK.md"] ? "PLAYBOOK.md" : (files[0] && files[0].path);
    if (prefer) selectFile(prefer);
  }

  function selectFile(path) {
    var f = fileMap[path];
    var pathEl = document.getElementById("file-path");
    var body = document.getElementById("file-body");
    document.querySelectorAll(".file-node").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-path") === path);
    });
    if (!pathEl || !body) return;
    if (!f) {
      pathEl.textContent = path || "Select a file";
      body.textContent = "";
      body.classList.remove("is-placeholder");
      return;
    }
    pathEl.textContent = f.path;
    // textContent only — never innerHTML / eval / live HTML·SVG render
    body.textContent = f.content || "";
    body.classList.toggle("is-placeholder", !!f.placeholder);
  }

  function activateResultTab(name) {
    document.querySelectorAll(".tab[data-rtab]").forEach(function (t) {
      var on = t.getAttribute("data-rtab") === name;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll("[data-rtab-panel]").forEach(function (p) {
      var on = p.getAttribute("data-rtab-panel") === name;
      p.classList.toggle("active", on);
      p.hidden = !on;
    });
  }

  function downloadZip() {
    if (!lastZipB64) {
      lastZipB64 = readJSON("zip-b64-json");
    }
    if (!lastZipB64 || typeof lastZipB64 !== "string") return;
    try {
      var bin = atob(lastZipB64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
      a.download = "ohqs-lab.zip";
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      console.warn("zip download failed", e);
    }
  }

  document.addEventListener("change", function (e) {
    if (e.target && (e.target.name === "mode" || e.target.id === "complexity")) syncModeUI();
  });

  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-action]");
    if (!t) {
      var tab = e.target.closest(".tab[data-rtab]");
      if (tab && !tab.disabled) activateResultTab(tab.getAttribute("data-rtab"));
      return;
    }
    var act = t.getAttribute("data-action");
    if (act === "download-zip") downloadZip();
    if (act === "select-file") selectFile(t.getAttribute("data-path"));
    if (act === "run-search") runSearch();
    if (act === "run-bounty-search") runBountySearch();
    if (act === "go-playbook") goPlaybookWithQuery();
    if (act === "bounty-class") {
      setBountyClass(t.getAttribute("data-class"));
      runBountySearch();
    }
  });

  document.body.addEventListener("htmx:configRequest", function (evt) {
    syncTokenUI();
    var tok = getToken();
    if (tok) evt.detail.headers["X-OHQS-Token"] = tok;
  });

  document.body.addEventListener("htmx:afterSwap", function (evt) {
    if (evt.target && evt.target.id === "result-mount") {
      hydrateFiles();
      activateResultTab("playbook");
    }
  });

  window.addEventListener("hashchange", function () {
    var page = pageFromHash();
    showPage(page);
    if (page === "bounties" && !bountiesLoaded) {
      bountiesLoaded = true;
      runBountySearch();
    }
  });

  document.addEventListener("DOMContentLoaded", function () {
    syncTokenUI();
    syncModeUI();
    loadModels();

    var startPage = pageFromHash();
    showPage(startPage);
    if (startPage === "bounties") {
      bountiesLoaded = true;
      runBountySearch();
    }

    var sq = document.getElementById("search-q");
    if (sq) {
      sq.addEventListener("keydown", function (ev) { if (ev.key === "Enter") runSearch(); });
      sq.addEventListener("input", debounce(runSearch, 350));
    }
    var bq = document.getElementById("bounty-q");
    if (bq) {
      bq.addEventListener("keydown", function (ev) { if (ev.key === "Enter") runBountySearch(); });
      bq.addEventListener("input", debounce(runBountySearch, 350));
    }

    var pre = new URLSearchParams(location.search).get("q");
    if (pre && sq) {
      sq.value = pre;
      if (startPage === "catalog" || !location.hash) {
        location.hash = "#catalog";
        showPage("catalog");
      }
      runSearch();
    }

    var input = document.getElementById("api-token");
    var clear = document.getElementById("api-token-clear");
    if (input) {
      input.addEventListener("change", function () {
        var v = input.value.trim();
        if (v && v.indexOf("•") === -1) setToken(v);
        syncTokenUI();
      });
      input.addEventListener("focus", function () {
        if (input.dataset.hasToken === "1") input.value = "";
      });
    }
    if (clear) {
      clear.addEventListener("click", function () {
        setToken("");
        syncTokenUI();
      });
    }
  });
})();
