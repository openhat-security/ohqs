#!/usr/bin/env node
//
// Incremental D1 seed for bounty contracts. Unlike `ohqs index d1` (which
// DELETEs records, metadata AND vectors — it would wipe the remote semantic
// index), this only INSERT OR REPLACEs the contract rows and rebuilds their
// FTS entries, leaving every existing row + vector untouched.
//
// Usage:
//   node seed-contracts.mjs --in data/contracts-raw.json --out ../../dist/d1/seed_contracts.sql
//   wrangler d1 execute ohqs --remote --file=dist/d1/seed_contracts.sql
//   # then embed the new rows once (maintainer): curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
//     "https://ohqs.ukryty.workers.dev/v1/index/embed"
//
// noteIfEmpty: wrangler timestamps are UTC; idempotent, safe to re-run.

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const m = process.argv[i].split(/=(.*)/s);
  args[m[0]] = m[1] ?? process.argv[++i];
}
const inFile = args["--in"] || "data/contracts-raw.json";
const outFile = args["--out"] || "../../dist/d1/seed_contracts.sql";

const lit = (s) => "'" + String(s).replace(/'/g, "''") + "'";

const raw = JSON.parse(await readFile(inFile, "utf8"));
const rows = (raw.items || []).filter((r) => r.kind === "contract");
if (!rows.length) { console.error("no contract rows found"); process.exit(1); }

let sql = "-- incremental contract seed: " + rows.length + " rows, " + new Date().toISOString() + "\n";
const ids = rows.map((r) => r.id);
sql += "-- reset FTS rows for these ids (records + vectors untouched)\n";
sql += ids.map((id) => `DELETE FROM records_fts WHERE id=${lit(id)};`).join("\n") + "\n";

for (const r of rows) {
  const id = r.id, name = r.name, kind = r.kind, summary = r.summary;
  const tags = (r.tags || []).join(" ");
  const body = [r.summary, r.scope, r.payout, r.allows_disclosure].filter(Boolean).join(" ");
  const data = JSON.stringify(r).replace(/'/g, "''");
  sql += `INSERT OR REPLACE INTO records(id,name,kind,summary,tags,body,data) VALUES (${lit(id)},${lit(name)},${lit(kind)},${lit(summary)},${lit(tags)},${lit(body)},${lit(data)});\n`;
  sql += `INSERT INTO records_fts(id,name,kind,summary,tags,body) VALUES (${lit(id)},${lit(name)},${lit(kind)},${lit(summary)},${lit(tags)},${lit(body)});\n`;
}

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, sql);
console.log(`wrote ${rows.length} contract INSERTs -> ${outFile}`);
console.log(`load: wrangler d1 execute ohqs --remote --file=${outFile}`);
console.log(`embed: curl -X POST -H "Authorization: Bearer \$ADMIN_TOKEN" https://ohqs.ukryty.workers.dev/v1/index/embed`);
console.log(`then: npm run typecheck && npx wrangler deploy  (worker reads kind='contract')`);