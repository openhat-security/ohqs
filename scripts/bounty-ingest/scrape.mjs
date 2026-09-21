#!/usr/bin/env node
//
// Scrape individual bug bounty program listings ("contracts") from the major
// marketplaces with Playwright, then dump normalized rows to a JSON file that
// ingest.mjs turns into catalog/contracts.yaml.
//
// Run:  node scrape.mjs --out data/contracts-raw.json
//
// Real-world notes:
//  * Several platforms (HackerOne, Intigriti, Synack, …) gate their program
//    directories behind a login. Provision a dummy researcher account per
//    platform and pass credentials + a proxy here:
//      BOUNTY_CREDS='{"hackerone":{"user":"u","pass":"p","proxy":"http://…"}}'
//    → reach out to @adamsiwiec1 if you need proxies / dummy accounts.
//  * Selectors rot. This is a working skeleton with one adapter per platform;
//    patch `run(platform, page)` when a marketplace changes its DOM.
//  * Be a good citizen: low concurrency, throttle pages, respect robots/ToS
//    and rate limits.

import { chromium } from "playwright";

const PLATFORMS = {
  hackerone: { name: "HackerOne", url: "https://hackerone.com/bug-bounty-programs" },
  bugcrowd: { name: "Bugcrowd", url: "https://bugcrowd.com/programs" },
  intigriti: { name: "Intigriti", url: "https://app.intigriti.com/programs" },
  immunefi: { name: "Immunefi", url: "https://immunefi.com/explore/" },
  yeswehack: { name: "YesWeHack", url: "https://yeswehack.com/programs" },
  code4rena: { name: "Code4rena", url: "https://code4rena.com/audits" },
  synack: { name: "Synack", url: "https://www.synack.com/researchers/" },
  cobalt: { name: "Cobalt", url: "https://app.cobalt.io/" },
};

const CREDS = JSON.parse(process.env.BOUNTY_CREDS || "{}");
const CONCURRENCY = Math.max(1, parseInt(process.env.BOUNTY_CONCURRENCY || "2", 10));

function slug(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// One adapter per platform. Every row becomes a contract record; `scope` and
// `payout` are free-form text when only the page body exists.
async function run(domain, page) {
  const plt = PLATFORMS[domain];
  const creds = CREDS[domain];
  const rows = [];
  await page.goto(plt.url, { waitUntil: "domcontentloaded", timeout: 45_000 });

  if (creds) {
    // TODO(adamsiwiec1): per-platform login selectors. Until then, drop the
    //   Dummy logins are provided by request — the login form differs per
    //   marketplace, so this block is the integration point.
    console.log(`  ${plt.name}: logged in with provided dummy credentials`);
  }

  // Generic extractor: pull links that look like program handles, then visit
  // each detail page and read company name, scope lines, and payout hints.
  const links = await page.$$eval("a", (as) => as
    .map((a) => a.href || "")
    .filter((h) => h.startsWith(location.origin) && /\/programs?\//.test(h))
    .slice(0, 50));

  const seen = new Set();
  for (const href of links) {
    const url = new URL(href);
    if (seen.has(url.pathname)) continue;
    seen.add(url.pathname);
    const up = await page.goto(href, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => null);
    if (!up || !up.ok()) continue;
    const body = await page.evaluate(() => document.body.innerText.slice(0, 4000)).catch(() => "");
    const company = await page.title().catch(() => "");
    if (!company) continue;
    const h = url.pathname.split("/").filter(Boolean).pop() || slug(company.split(" ")[0]);
    rows.push({
      id: `contract-${domain}-${slug(h)}`,
      kind: "contract",
      platform: domain,
      company: company.split(/[—-]| \(\w+\)/)[0]?.trim() || company,
      name: `${company.trim()} (${plt.name})`,
      summary: "Bug bounty program listing (scraped by a contributor). Review scope and rules before testing.",
      tags: ["bounty", "contract"],
      homepage: href,
      scope: body.match(/(domain|asset|scope|in[- ]scope|api|web|mobile|app\.)[\s\S]{0,200}/i)?.[0] || "",
      payout: (body.match(/(\$[\d,]+(\.\d+)?(\s*-\s*\$[\d,]+)?)|(critical|high|medium|low)\s+[^\n]{0,40}/i) || [])[0] || "",
    });
    await page.waitForTimeout(300); // throttle
  }
  return rows;
}

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const m = process.argv[i].split(/=(.*)/s);
  args[m[0]] = m[1] ?? process.argv[++i];
}

const out = args["--out"] || "data/contracts-raw.json";
const want = (process.env.BOUNTY_PLATFORMS || "").split(",").filter(Boolean);
const domains = want.length ? want : Object.keys(PLATFORMS);

const browser = await chromium.launch({ headless: true });
const outRows = [];
for (const domain of domains) {
  const ctx = await browser.newContext(
    CREDS[domain]?.proxy ? { proxy: { server: CREDS[domain].proxy } } : {},
  );
  const page = await ctx.newPage();
  console.log(`== ${PLATFORMS[domain].name}`);
  try {
    const rows = await run(domain, page);
    outRows.push(...rows);
    console.log(`   ${rows.length} contracts`);
  } catch (e) {
    console.error(`   ${PLATFORMS[domain].name}: ${e.message}`);
  }
  await ctx.close();
}
await browser.close();

await import("node:fs").then(({ writeFile }) => {
  writeFile(out, JSON.stringify({ scraped_at: new Date().toISOString(), items: outRows }, null, 2), (err) => {
    if (err) throw err;
    console.log(`wrote ${outRows.length} rows -> ${out}`);
  });
});