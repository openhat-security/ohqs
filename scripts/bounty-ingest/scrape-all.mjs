#!/usr/bin/env node
//
// Free-source aggregator: pulls public bug bounty program listings ("contracts")
// from free/open sources and emits a common row shape for ingest.mjs.
//
// Sources (enable with BOUNTY_SOURCES, comma-separated; all are free):
//   bounty-targets   arkadiyt/bounty-targets-data — no auth, auto-updated,
//                    HackerOne + Bugcrowd + Intigriti + YesWeHack + Federacy.
//                    THE easiest full-catalog pull. (default on)
//   bbscope          json export produced by bbscope-pull.sh (creds + Postgres;
//                    predicts scopes + tracks changes). Expects data/bbscope-dump.json.
//   apify-hacktivity rl1987/filakovsky HackerOne hacktivity feed (disclosed
//                    reports research, ~free tier up to 1k items). Needs APIFY_TOKEN.
//   openbugbounty    public openbugbounty.org listing pages (no creds; pages are
//                    bot-protected so this is best-effort). (default off)
//
// Paid Apify actors (ParseForge, GetAScraper, etc.) that the user's list
// mentioned are deliberately NOT used — they bill per 1k records.
//
// Run: node scrape-all.mjs --out data/contracts-raw.json
//      node scrape-all.mjs --source apify-hacktivity --out data/reports-raw.json

const { writeFile } = await import("node:fs/promises");

async function main() {
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const m = process.argv[i].split(/=(.*)/s);
  args[m[0]] = m[1] ?? process.argv[++i];
}
const out = args["--out"] || "data/contracts-raw.json";
const sourceFlag = args["--source"] || "";
const sources = sourceFlag
  ? sourceFlag.split(",").filter(Boolean)
  : (process.env.BOUNTY_SOURCES || "bounty-targets").split(",")
    .map((s) => s.trim()).filter(Boolean);

const BTD_BASE = "https://raw.githubusercontent.com/arkadiyt/bounty-targets-data/main/data/";

function slug(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 80);
}
function firstUrl(list) {
  const u = (list || []).find((x) => x && typeof x.url === "string");
  return u ? u.url : "";
}
function cap(s, n) {
  const t = (s || "").trim().replace(/\s+/g, " ").replace(/,\s*$/, "");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

let rows = [];

function inScope(r) {
  const t = r.targets;
  if (Array.isArray(t)) return t;
  return t && Array.isArray(t.in_scope) ? t.in_scope : [];
}

async function fetchBTD() {
  const files = {
    hackerone: { file: "hackerone_data.json", sel: (r) => r.submission_state === "open" },
    bugcrowd: { file: "bugcrowd_data.json", sel: () => true },
    intigriti: { file: "intigriti_data.json", sel: (r) => r.status !== "closed" },
    yeswehack: { file: "yeswehack_data.json", sel: (r) => !r.disabled },
    federacy: { file: "federacy_data.json", sel: () => true },
  };
  for (const [platform, { file, sel }] of Object.entries(files)) {
    const res = await fetch(BTD_BASE + file).catch((e) => { throw new Error(`bounty-targets ${file}: ${e.message}`); });
    if (!res.ok) { console.warn(`  skip ${file}: HTTP ${res.status}`); continue; }
    const list = await res.json();
    let n = 0;
    for (const r of list) {
      if (!sel(r)) continue;
      const row = platformRow(platform, r);
      if (row) { rows.push(row); n++; }
    }
    console.log(`  bounty-targets: ${platform} -> ${n} contracts`);
  }
}

function platformRow(platform, r) {
  const targets = [];
  const types = new Set();
  let bounty = "";
  let allowedDisclosure = null, safeHarbor = "";
  let handle = "";

  if (platform === "hackerone") {
    handle = r.handle || slug(r.name);
    (r.targets?.in_scope || []).forEach((t) => { targets.push(t.asset_identifier); if (t.asset_type) types.add(t.asset_type); });
    bounty = [(r.offers_bounties ? "bounty" : null), (r.offers_swag ? "swag" : null)].filter(Boolean).join(" + ");
    allowedDisclosure = r.response_efficiency_percentage != null ? `${r.response_efficiency_percentage}% response` : null;
  } else if (platform === "bugcrowd") {
    handle = (r.url || "").split("/").pop();
    (r.targets?.in_scope || []).forEach((t) => { targets.push(t.target || t.url); if (t.type || t.category) types.add(t.type || t.category); });
    bounty = r.max_payout ? `max $${r.max_payout}` : "";
    safeHarbor = r.safe_harbor || "";
    allowedDisclosure = r.allows_disclosure != null ? (r.allows_disclosure ? "public disclosure" : "invite/vetted only") : null;
  } else if (platform === "intigriti") {
    handle = r.company_handle || r.handle;
    inScope(r).forEach((t) => { targets.push(t.endpoint || t.asset); if (t.type) types.add(t.type); });
    bounty = [r.min_bounty ? `$${r.min_bounty}+` : null, r.max_bounty ? `up to $${r.max_bounty}` : null].filter(Boolean).join(" · ");
    allowedDisclosure = r.confidentiality_level;
  } else if (platform === "yeswehack") {
    handle = slug(r.name);
    inScope(r).forEach((t) => { targets.push(t.endpoint || t.asset || t.scope); if (t.type) types.add(t.type); });
    bounty = [r.min_bounty ? `$${r.min_bounty}+` : null, r.max_bounty ? `up to $${r.max_bounty}` : null].filter(Boolean).join(" · ");
  } else if (platform === "federacy") {
    handle = slug(r.name);
    inScope(r).forEach((t) => { targets.push(t.url || t.asset); if (t.type) types.add(t.type); });
    bounty = r.offers_awards ? "awards" : "";
  } else {
    return null;
  }

  const name = r.name || handle;
  const base = platform === "hackerone" ? "https://hackerone.com/" : platform;
  const homepage = r.url || (platform === "yeswehack"
    ? `https://yeswehack.com/programs/${handle}`
    : (platform === "intigriti" ? `https://app.intigriti.com/programs/${r.company_handle || handle}` : `${base}/${handle}`));

  const summaryBits = [
    `Bug bounty program on ${platform}${r.managed_program ? " (platform-managed)" : ""}.`,
    targets.length ? `${targets.length} in-scope asset${targets.length === 1 ? "" : "s"}${types.size ? ` (${[...types].join(", ")})` : ""}.` : "",
    bounty ? `Rewards: ${bounty}.` : "",
    allowedDisclosure ? `Disclosure: ${allowedDisclosure}.` : "",
  ].filter(Boolean);
  void safeHarbor;

  return {
    id: `contract-${platform}-${slug(handle || name)}`,
    kind: "contract",
    platform,
    company: name.split(/\(/)[0].trim() || name,
    name: `${name} (${platform})`,
    summary: cap(summaryBits.join(" "), 240),
    tags: ["bounty", "contract", platform],
    homepage: homepage || "",
    scope: cap(targets.join(", "), 600),
    scope_types: [...types].sort(),
    target_count: targets.length,
    payout: bounty,
    allows_disclosure: allowedDisclosure || "",
    scraped_from: "bounty-targets-data",
  };
}

async function fetchApifyHacktivity() {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error("apify-hacktivity needs APIFY_TOKEN (free Apify account: apify.com → Settings → Integrations)");
  const actor = "filakovsky/hackerone-scraper";
  const start = await fetch(`https://api.apify.com/v2/acts/${actor}/runs?token=${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxItems: parseInt(process.env.APIFY_MAX_ITEMS || "1000", 10) }),
  });
  if (!start.ok) throw new Error(`apify start HTTP ${start.status}`);
  const run = await start.json();
  const runId = run.data.id;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const st = await (await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${token}`)).json();
    if (st.data.status === "SUCCEEDED") break;
    if (st.data.status === "FAILED") throw new Error("apify run failed");
  }
  const ds = await (await fetch(`https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${token}&&format=json`)).json();
  const mapped = (ds.data || ds).map((x) => ({
    id: `disclosure-hackerone-${x.reportId || x.id}`,
    kind: "disclosure",
    platform: "hackerone",
    summary: cap(x.title || "", 200),
    homepage: x.url || "",
    severity: x.severityRating || "",
    substate: x.substate || "",
    disclosed: x.disclosedDate || "",
  }));
  return { rows: mapped, kind: "disclosures" };
}

async function fetchOpenBugBounty() {
  // Best-effort: openbugbounty.org program pages are bot-protected; don't
  // hard-fail the whole run if this source errors.
  const res = await fetch("https://www.openbugbounty.org/");
  if (!res.ok) { console.warn("  openbugbounty: HTTP " + res.status); return; }
  const html = await res.text();
  const links = [...html.matchAll(/href="(\/bounties\/[\w.-]+)"/g)].map((m) => "https://www.openbugbounty.org" + m[1]);
  [...new Set(links)].slice(0, 200).forEach((homepage) => {
    const handle = (homepage.split("/").pop() || "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (!handle) return;
    rows.push({
      id: `contract-openbugbounty-${handle}`,
      kind: "contract",
      platform: "openbugbounty",
      company: "",
      name: `${handle} (OpenBugBounty)`,
      summary: "OpenBugBounty non-profit disclosure program.",
      tags: ["bounty", "contract", "vdp"],
      homepage,
      scope: "",
      payout: "",
      allows_disclosure: "",
      scraped_from: "openbugbounty",
    });
  });
  console.log(`  openbugbounty: page links -> ${rows.length} (cumulative)`);
}

async function addBBScopeDump() {
  const { readFile } = await import("node:fs/promises");
  try {
    const dump = JSON.parse(await readFile("data/bbscope-dump.json", "utf8"));
    let n = 0;
    for (const r of dump) {
      rows.push({
        id: `contract-${slug(r.platform)}-${slug(r.program || r.name)}`,
        kind: "contract",
        platform: r.platform,
        company: r.company || (r.program || r.name || "").split(/[–-]/)[0].trim(),
        name: `${r.program || r.name} (${r.platform})`,
        summary: cap(r.description || `Bug bounty program on ${r.platform}.`, 200),
        tags: ["bounty", "contract", slug(r.platform)],
        homepage: r.url || "",
        scope: cap((r.scope || []).join(", "), 600),
        scope_types: r.scope_types || [],
        target_count: (r.scope || []).length,
        payout: r.max_bounty || "",
        allows_disclosure: "",
        scraped_from: "bbscope",
      });
      n++;
    }
    console.log(`  bbscope dump -> ${n} contracts`);
  } catch (e) {
    console.warn("  bbscope dump read failed (run bbscope-pull.sh first):", e.message);
  }
}

for (const src of sources) {
  console.log(`== source: ${src}`);
  try {
    if (src === "bounty-targets") await fetchBTD();
    else if (src === "apify-hacktivity") {
      const r = await fetchApifyHacktivity();
      const o = args["--out"] || "data/reports-raw.json";
      await writeFile(o, JSON.stringify({ scraped_at: new Date().toISOString(), kind: r.kind, items: r.rows }, null, 2));
      console.log(`  apify hacktivity -> wrote ${r.rows.length} -> ${o}`);
      return;
    } else if (src === "openbugbounty") await fetchOpenBugBounty();
    else if (src === "bbscope") await addBBScopeDump();
    else console.warn(`  unknown source '${src}'; run with BOUNTY_SOURCES=bounty-targets,bbscope,apify-hacktivity,openbugbounty`);
  } catch (e) {
    console.error(`  ERROR ${src}: ${e.message}`);
  }
}

const uniq = new Map();
for (const r of rows) if (!uniq.has(r.homepage || r.id)) uniq.set(r.homepage || r.id, r);
const deduped = [...uniq.values()];
await writeFile(out, JSON.stringify({ scraped_at: new Date().toISOString(), sources, items: deduped }, null, 2));
console.log(`wrote ${deduped.length} contracts -> ${out}`);
}

await main();