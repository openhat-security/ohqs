// Bounty classification. The catalog marks every bounty/VDP listing as
// kind "platform"; this module splits those into:
//   - marketplace: aggregators you join, then pick a program (HackerOne,
//     Bugcrowd, Intigriti, Synack, Immunefi, Code4rena, …)
//   - program: a single organization's own bounty/VDP (Microsoft MSRC, Apple,
//     Google Bug Hunters, Ethereum, national CERTs/NCSCs, …)
//   - contract: the individual program listings hosted inside marketplaces
//     (e.g. "Stripe" on HackerOne). We do NOT have these yet — scraping is a
//     contributor task (see scripts/bounty-ingest) — so /v1/bounties returns
//     an empty list plus this note until they land.
//
// Mirror of the bounty-marketplace / bounty-program tags in
// catalog/platforms.yaml. Keep the set below in sync when editing that file.
// (An id NOT listed here is treated as a marketplace.)

export type BountyClass = "marketplace" | "program" | "contract";

export const CONTRACT_NOTE =
  "Contracts (individual programs inside marketplaces) aren't scraped yet — " +
  "we're out of compute budget and burned through the AI credits. We're " +
  "recruiting a contributor with a proper GPU (e.g. @chaseleto) to scrape and " +
  "ingest these on a schedule using the reusable Playwright scripts in " +
  "scripts/bounty-ingest, powered by runhug (github.com/adamsiwiec1/runhug) " +
  "to deploy the model. If you need proxies or dummy credentials per platform, " +
  "reach out to @adamsiwiec1.";

// Single-org / government-run programs. Everything else with kind "platform"
// is a marketplace.
export const PROGRAM_IDS: ReadonlySet<string> = new Set([
  "platform-007-www-homeaffairs-gov-au",
  "platform-009-cert-pl",
  "platform-010-www-cert-in-org-in",
  "platform-011-www-cisa-gov",
  "platform-012-www-divd-nl",
  "platform-014-jvn-jp",
  "platform-015-knvd-krcert-or-kr",
  "platform-016-nciipc-gov-in",
  "platform-017-hub-ncsa-gov-mv",
  "platform-018-www-kyberturvallisuuskeskus-fi",
  "platform-019-www-ncsc-nl",
  "platform-020-www-nksc-lt",
  "platform-023-www-tech-gov-sg",
  "platform-024-www-ncsc-admin-ch",
  "platform-025-www-twcert-org-tw",
  "platform-027-www-ncsc-gov-uk",
  "platform-051-www-wordfence-com",
  "platform-052-src-360-net",
  "platform-125-ethereum-org",
  "platform-128-bughunters-google-com",
  "platform-129-www-microsoft-com",
  "platform-130-security-apple-com",
]);

export function bountyClassOf(id: string): BountyClass {
  return PROGRAM_IDS.has(id) ? "program" : "marketplace";
}

export function isPlatform(r: { kind?: unknown; [k: string]: unknown }): boolean {
  return r.kind === "platform";
}

export function isContract(r: { kind?: unknown; [k: string]: unknown }): boolean {
  return r.kind === "contract";
}

export function matchesClass(
  r: { id: string; kind?: unknown; [k: string]: unknown },
  cls: BountyClass,
): boolean {
  if (cls === "contract") return false;
  return isPlatform(r) && bountyClassOf(r.id) === cls;
}