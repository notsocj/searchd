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
//   node audit.js write
//       For projects that keep their listing in fastlane (fastlane/metadata/<locale>/name.txt,
//       subtitle.txt, keywords.txt): writes the saved suggestion into those files, so it shows up
//       as a diff (git diff) you review and upload yourself. Still nothing is sent to Apple.
//
// The rules (from App Store Connect):
//   name      ≤ 30 characters
//   subtitle  ≤ 30 characters
//   keywords  ≤ 100 characters, comma-separated. searchd also wants no spaces at all, because a
//             space costs a character and Apple already combines separate words into phrases
//             ("calorie,counter" matches searches for "calorie counter").
//   No word from the name or subtitle repeated in the keyword field: Apple indexes all three
//   fields together, so a repeat is a wasted character, not extra weight.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { loadShared } from "./shared.js";

const { readJson, writeJson, readStdinJson, requireApp, entryKey, isMain } = await loadShared("lib/store.js");
const { createClient } = await loadShared("lib/itunes.js");
const { normalize, hasPhrase } = await loadShared("lib/score.js");
const { findMetadataDir, readMetadata, METADATA_FIELDS } = await loadShared("lib/project.js");

export const LIMITS = { name: 30, subtitle: 30, keywords: 100 };
const TOP_KEYWORDS = 20;

// Count characters the way people do: "ä" or an emoji is 1, even though JavaScript's .length
// would count some of them as 2 (UTF-16 code units).
export const charCount = (text) => [...String(text ?? "")].length;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Check one listing. Returns a list of problems (empty = passes). */
export function checkListing(listing) {
  // The listing comes from the agent's JSON: "null" or a bare string must be a problem, not a crash.
  if (!isObject(listing)) return ["a listing must be an object with locale, countries, name, subtitle and keywords"];
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
  // The listing as it is in the repo, when the project uses fastlane: the real keyword field,
  // which the App Store never shows publicly.
  const dir = findMetadataDir();
  const metadata = dir ? { dir: relative(process.cwd(), dir), locales: readMetadata(dir) } : null;
  console.log(JSON.stringify({ app: { id: app.id, name: app.name }, countries, metadata }, null, 2));
}

// "en-US", "ja", "zh-Hans", "es-MX": App Store Connect's locale codes. Anything else (a "/" or
// "..") could point a write outside the metadata folder, so it's refused.
const LOCALE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,4})?$/;

/**
 * Write saved listings into fastlane's metadata folder, one <locale>/<field>.txt per field.
 * Only into locale folders that already exist: a new folder would add a whole new language to
 * the listing the next time fastlane uploads, and that's the user's decision, not a keyword
 * tweak. audit.json can be hand-edited, so everything is checked again first; on any problem
 * nothing is written. Returns { problems, written: ["en-US/name.txt", …], unchanged, skipped: [locales] }.
 */
export function writeMetadata(dir, listings) {
  const result = { problems: [], written: [], unchanged: [], skipped: [] };
  if (!Array.isArray(listings) || !listings.length) {
    result.problems.push("no saved listing: run audit.js check first");
    return result;
  }
  for (const listing of listings) {
    result.problems.push(...checkListing(listing));
    if (isObject(listing) && !LOCALE.test(String(listing.locale))) result.problems.push(`"${listing.locale}" isn't an App Store locale code (like en-US or ja)`);
  }
  if (result.problems.length) return result;

  for (const listing of listings) {
    const folder = join(dir, listing.locale);
    if (!existsSync(folder)) {
      result.skipped.push(listing.locale);
      continue;
    }
    for (const field of METADATA_FIELDS) {
      const file = join(folder, `${field}.txt`);
      const old = existsSync(file) ? readFileSync(file, "utf8") : null;
      const name = `${listing.locale}/${field}.txt`;
      if (old !== null && old.trim() === listing[field]) {
        result.unchanged.push(name);
        continue;
      }
      // Keep the file's own style: a trailing newline only if it had one (new files get one).
      writeFileSync(file, listing[field] + (old === null || old.endsWith("\n") ? "\n" : ""));
      result.written.push(name);
    }
  }
  return result;
}

function write() {
  const dir = findMetadataDir();
  if (!dir) {
    console.error("No fastlane/metadata folder here. Copy the suggestion into App Store Connect yourself (or run this from the project that has fastlane).");
    process.exit(1);
  }
  const { problems, written, unchanged, skipped } = writeMetadata(dir, readJson("audit.json")?.listings);
  if (problems.length) {
    console.error(`Nothing written. Fix these:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  const shown = relative(process.cwd(), dir);
  for (const file of written) console.log(`updated   ${shown}/${file}`);
  if (unchanged.length) console.log(`unchanged ${unchanged.length} file${unchanged.length === 1 ? "" : "s"} (already the same text)`);
  if (skipped.length) console.log(`skipped   ${skipped.join(", ")}: no folder for that language in ${shown} (add the language in App Store Connect first)`);
  console.log(written.length ? `\nReview it with: git diff -- ${shown}\nNothing was sent to Apple: uploading (fastlane deliver) is up to you.` : "\nNothing to change.");
}

/**
 * Check everything the agent sent, all at once: each listing against Apple's rules (checkListing)
 * plus what searchd needs to make sense of the set: a locale, and countries that are the user's
 * own, each in exactly one listing (a country has one App Store language). Returns the problems.
 */
export function validateListings(input, appCountries) {
  const listings = input?.listings;
  if (!Array.isArray(listings) || !listings.length) return ['expected { "listings": [ … ] }'];
  const problems = [];
  const locales = new Set();
  const claimed = new Map(); // country → locale that claimed it first
  for (const listing of listings) {
    problems.push(...checkListing(listing));
    if (!isObject(listing)) continue;
    const label = listing.locale || "(no locale)";
    if (typeof listing.locale !== "string" || !listing.locale.trim()) problems.push(`${label}: "locale" is missing (e.g. "en-US")`);
    else if (locales.has(listing.locale)) problems.push(`${label}: locale appears in two listings (merge them)`);
    else locales.add(listing.locale);

    if (!Array.isArray(listing.countries) || !listing.countries.length) {
      problems.push(`${label}: "countries" must be a list of the countries that use this listing, e.g. ["us"]`);
      continue;
    }
    for (const country of listing.countries) {
      if (!appCountries.includes(country)) problems.push(`${label}: "${country}" isn't one of your countries (${appCountries.join(", ")})`);
      else if (claimed.has(country) && claimed.get(country) !== listing.locale) problems.push(`${label}: "${country}" is already in the ${claimed.get(country)} listing`);
      else claimed.set(country, listing.locale);
    }
  }
  return problems;
}

function check(input, app) {
  const problems = validateListings(input, app.countries);
  // Show the character counts of every listing we can read, even when something fails to validate.
  for (const l of (Array.isArray(input?.listings) ? input.listings : []).filter(isObject)) {
    console.log(`\n${l.locale ?? "(no locale)"} (${(Array.isArray(l.countries) ? l.countries : []).join(", ").toUpperCase()})`);
    for (const field of ["name", "subtitle", "keywords"]) {
      const count = charCount(l[field]);
      console.log(`  ${field.padEnd(9)} ${count <= LIMITS[field] ? "✓" : "✗"} ${String(count).padStart(3)}/${LIMITS[field]}  ${l[field] ?? ""}`);
    }
  }
  if (problems.length) {
    console.error(`\nNot saved. Fix these:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  writeJson("audit.json", { createdAt: new Date().toISOString(), listings: input.listings });
  console.log("\nAll listings pass. Saved to .searchd/audit.json.");
}

if (isMain(import.meta.url)) {
  const app = requireApp();
  const command = process.argv[2];
  if (command === "data") await data(app);
  else if (command === "check") check(await readStdinJson(), app);
  else if (command === "write") write();
  else {
    console.error("Usage: audit.js data | audit.js check  (JSON on stdin) | audit.js write");
    process.exit(1);
  }
}
