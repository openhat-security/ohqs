#!/usr/bin/env node
//
// LLM ingest pass: normalize scraped contract rows into catalog/contracts.yaml
// in the same schema the ohqs indexer consumes. Uses the model endpoint that
// runhug-deploy.sh started (a GPU — locally or on RunPod). If no model is
// reachable it falls back to a deterministic normalizer so the pipeline still
// completes.
//
// Run:  node ingest.mjs --base http://127.0.0.1:8001/v1 --model meta-llama/Llama-3.3-70B-Instruct \
//                       --in data/contracts-raw.json --out ../../catalog/contracts.yaml

const { readFile, writeFile } = await import("node:fs/promises");

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const m = process.argv[i].split(/=(.*)/s);
  args[m[0]] = m[1] ?? process.argv[++i];
}
const from = args["--in"] || "data/contracts-raw.json";
const to = args["--out"] || "../../catalog/contracts.yaml";
const base = args["--base"] || "";
const model = args["--model"] || "";

const raw = JSON.parse(await readFile(from, "utf8"));
const rows = raw.items || [];

if (!rows.length) {
  console.log("no rows to ingest — skipped (keep running, this is normal until scrapers land)");
  process.exit(0);
}

function fallbackNorm(r) {
  return {
    id: r.id || `contract-${r.platform}-${(r.company || "program").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name: r.name || r.company,
    kind: "contract",
    summary: r.summary || `Bug bounty program on ${r.platform}.`,
    tags: ["bounty", "contract"],
    homepage: r.homepage || "",
    platform: r.platform || "",
    company: r.company || "",
    scope: (r.scope || "").slice(0, 300),
    payout: (r.payout || "").slice(0, 120),
  };
}

let items;
if (base && model) {
  try {
    // Batch-normalize with the runhug GPU model: one compact prompt per chunk.
    const chunkSize = 8;
    const out = [];
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const res = await fetch(base + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content:
                "You normalize scraped bug-bounty program rows into the exact schema " +
                '{id,name,kind:"contract",summary,tags,homepage,platform,company,scope,payout}. ' +
                "Respond with a JSON array only.",
            },
            { role: "user", content: JSON.stringify(chunk) },
          ],
          temperature: 0,
        }),
      });
      if (!res.ok) throw new Error(`model HTTP ${res.status}`);
      const text = (await res.json()).choices?.[0]?.message?.content || "";
      const arr = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] || "[]");
      out.push(...arr.map((x) => x && typeof x === "object" ? { ...fallbackNorm(x), ...x } : fallbackNorm(x)));
    }
    items = out;
    console.log(`ingested ${items.length} rows via model ${model}`);
  } catch (e) {
    console.warn(`model pass failed (${e.message}) — falling back to deterministic normalizer`);
    items = rows.map(fallbackNorm);
  }
} else {
  console.warn("no --base/--model — deterministic fallback only (round-trips scraped data)");
  items = rows.map(fallbackNorm);
}

const yaml =
  "items:\n" +
  items
    .map((r) => {
      const kv = (k, v) => (v == null || v === "" ? null : `    ${k}: ${String(v).trim()}`);
      return [
        "  - id: " + r.id,
        "    name: " + String(r.name || "").trim(),
        '    kind: contract',
        "    summary: " + JSON.stringify((r.summary || "").trim()),
        "    tags: " + JSON.stringify(r.tags || ["bounty", "contract"]),
        kv("homepage", r.homepage),
        kv("platform", r.platform),
        kv("company", r.company),
        kv("scope", r.scope && (r.scope + "").slice(0, 300)),
        kv("payout", r.payout && (r.payout + "").slice(0, 120)),
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n") + "\n";

await writeFile(to, yaml);
console.log(`wrote ${items.length} records -> ${to}`);