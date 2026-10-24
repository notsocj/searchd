#!/usr/bin/env node
// audit.js — data for, and rule checks of, a rewritten App Store listing.
//
//   node audit.js data
//       JSON for the agent: per country, your current App Store name there, plus the 20 best
//       keywords with their rank / volume / difficulty / opportunity (best first).
//
//   node audit.js check <<'EOF'
//   { "listings": [{ "locale": "en-US", "countries": ["us"], "name": "…", "subtitle": "…", "keywords": "a,b,c" }] }
//   EOF
//       Checks every listing against Apple's rules, prints character counts, and saves it to
//       .searchd/audit.json when everything passes. Nothing is ever sent to Apple.
//
// The rules (from App Store Connect):
//   name      ≤ 30 characters
//   subtitle  ≤ 30 characters
//   keywords  ≤ 100 characters, comma-separated. searchd also wants no spaces at all, because a
//             space costs a character and Apple already combines separate words into phrases
//             ("calorie,counter" matches searches for "calorie counter").
//   No word from the name or subtitle repeated in the keyword field: Apple indexes all three
//   fields together, so a repeat is a wasted character, not extra weight.

import { loadShared } from "./shared.js";

const { readJson, writeJson, readStdinJson, requireApp, entryKey, isMain } = await loadShared("lib/store.js");
const { createClient } = await loadShared("lib/itunes.js");
const { normalize, hasPhrase } = await loadShared("lib/score.js");

export const LIMITS = { name: 30, subtitle: 30, keywords: 100 };
const TOP_KEYWORDS = 20;

// Count characters the way people do: "ä" or an emoji is 1, even though JavaScript's .length
// would count some of them as 2 (UTF-16 code units).
export const charCount = (text) => [...String(text ?? "")].length;

/** Check one listing. Returns a list of problems (empty = passes). */
export function checkListing(listing) {
  const problems = [];
  const label = listing.locale || "(no locale)";
  for (const field of ["name", "subtitle", "keywords"]) {
    if (typeof listing[field] !== "string") {
      problems.push(`${label}: "${field}" is missing`);
      continue;
    }
    const count = charCount(listing[field]);
    if (count > LIMITS[field]) problems.push(`${label}: ${field} is ${count}/${LIMITS[field]} characters`);
  }
  if (problems.length) return problems;

  if (/\s/.test(listing.keywords)) problems.push(`${label}: keyword field has spaces (use commas only)`);
  const items = listing.keywords.split(",").map((k) => k.trim());
  if (items.some((k) => !k)) problems.push(`${label}: keyword field has an empty item (double or trailing comma)`);

  const seen = new Set();
  const visible = normalize(`${listing.name} ${listing.subtitle}`);
  for (const item of items.filter(Boolean)) {
    const word = normalize(item);
    if (seen.has(word)) problems.push(`${label}: "${item}" is in the keyword field twice`);
    seen.add(word);
    // hasPhrase matches whole words, and substrings for Japanese/Chinese/Korean/Thai.
    if (hasPhrase(visible, word)) problems.push(`${label}: "${item}" is already in the name or subtitle`);
  }
  return problems;
}

async function data(app) {
  const client = createClient();
  const { entries = {} } = readJson("results.json", { entries: {} });
  const keywords = readJson("keywords.json", []);
  const countries = {};
  for (const country of app.countries) {
    // Your name can differ per country (localized listings), so look it up in each one.
    const [current] = await client.lookup(app.id, country);
    countries[country] = {
      currentName: current?.name ?? null, // null: not sold in this country
      keywords: keywords
        .map((k) => entries[entryKey(k.keyword, country)])
        .filter(Boolean)
        .map(({ keyword, phrase, rank, volume, difficulty, opportunity }) => ({ keyword, phrase, rank, volume, difficulty, opportunity }))
        .sort((a, b) => b.opportunity - a.opportunity)
        // The best 20 are plenty for 160 characters of listing, and keep the output small enough
        // for the agent to read in full (all of 60 keywords × 10 countries would be ~130 KB).
        .slice(0, TOP_KEYWORDS),
    };
  }
  console.log(JSON.stringify({ app: { id: app.id, name: app.name }, countries }, null, 2));
}

function check(input) {
  const listings = input?.listings;
  if (!Array.isArray(listings) || !listings.length) {
    console.error('audit.js: expected { "listings": [ … ] }');
    process.exit(1);
  }
  const problems = listings.flatMap(checkListing);
  for (const l of listings) {
    console.log(`\n${l.locale} (${(l.countries ?? []).join(", ").toUpperCase()})`);
    for (const field of ["name", "subtitle", "keywords"]) {
      const count = charCount(l[field]);
      console.log(`  ${field.padEnd(9)} ${count <= LIMITS[field] ? "✓" : "✗"} ${String(count).padStart(3)}/${LIMITS[field]}  ${l[field] ?? ""}`);
    }
  }
  if (problems.length) {
    console.error(`\nNot saved. Fix these:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  writeJson("audit.json", { createdAt: new Date().toISOString(), listings });
  console.log("\nAll listings pass. Saved to .searchd/audit.json.");
}

if (isMain(import.meta.url)) {
  const app = requireApp();
  const command = process.argv[2];
  if (command === "data") await data(app);
  else if (command === "check") check(await readStdinJson());
  else {
    console.error("Usage: audit.js data | audit.js check  (JSON on stdin)");
    process.exit(1);
  }
}
