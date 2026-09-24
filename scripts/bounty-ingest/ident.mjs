// ensureUniqueIds guarantees every row has a distinct id. Different programs
// on the same marketplace can share a handle (Intigriti groups all DPG Media
// brands under company_handle "dpgm"), so scrape-all.mjs and ingest.mjs both
// route their final items through this so the records PRIMARY KEY stays valid.
// Colliding ids get a deterministic suffix from the company name, with a
// numeric backstop when even that collides.
export function slug(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export function ensureUniqueIds(items) {
  const taken = new Map();
  const out = [];
  for (const r of items) {
    let id = r.id;
    if (taken.has(id)) {
      const base = id.replace(/-\d+$/, "");
      let candidate = `${base}-${slug(r.company || r.name)}`;
      if (!candidate || candidate === base || taken.has(candidate)) candidate = `${base}-2`;
      let n = 2;
      while (taken.has(candidate)) candidate = `${base}-${++n}`;
      id = candidate;
    }
    taken.set(id, true);
    out.push({ ...r, id });
  }
  return out;
}