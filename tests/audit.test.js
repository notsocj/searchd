// Edge-case tests for audit.js: the rules for one listing, the checks across all listings, and
// the real `audit.js check` command (run as a child process) to prove a bad list saves nothing.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkListing, charCount, validateListings, LIMITS } from "../skills/searchd-audit/scripts/audit.js";
import { readJson } from "../skills/searchd-find/scripts/lib/store.js";

beforeEach(() => {
  process.env.SEARCHD_DIR = mkdtempSync(join(tmpdir(), "searchd-test-"));
});

const COUNTRIES = ["us", "gb", "de"];
const en = { locale: "en-US", countries: ["us"], name: "Brand: Calorie Counter", subtitle: "Macro Tracker", keywords: "nutrition,vitamin,diet" };
const de = { locale: "de-DE", countries: ["de"], name: "Marke: Kalorienzähler", subtitle: "Makro Tracker", keywords: "ernährung,vitamine" };

// ---- charCount / LIMITS ----

test("charCount counts what people see: accents and emoji are one, missing is zero", () => {
  assert.equal(charCount("ä"), 1);
  assert.equal(charCount("🍎"), 1);
  assert.equal(charCount("カロリー計算"), 6);
  assert.equal(charCount(""), 0);
  assert.equal(charCount(undefined), 0);
  assert.equal(charCount(null), 0);
  assert.deepEqual(LIMITS, { name: 30, subtitle: 30, keywords: 100 });
});

// ---- checkListing ----

test("checkListing: exactly at the limit passes, one over fails", () => {
  assert.deepEqual(checkListing({ ...en, name: "x".repeat(30), subtitle: "y".repeat(30), keywords: Array.from({ length: 20 }, (_, i) => `w${String(i).padStart(2, "0")}z`).join(",").slice(0, 100) }), []);
  const over = checkListing({ ...en, name: "x".repeat(31), subtitle: "y".repeat(31), keywords: "z".repeat(101) });
  assert.equal(over.length, 3, "every field over its limit is reported");
});

test("checkListing: not-an-object listings are a problem, not a crash", () => {
  for (const bad of [null, undefined, "text", 5, [], true]) assert.equal(checkListing(bad).length, 1, String(bad));
});

test("checkListing: missing or wrong-typed fields are listed together", () => {
  const problems = checkListing({ locale: "en-US", name: 5, subtitle: null });
  assert.deepEqual(problems, ['en-US: "name" is missing', 'en-US: "subtitle" is missing', 'en-US: "keywords" is missing']);
});

test("checkListing: a word in the name or subtitle can't be repeated in the keyword field", () => {
  assert.ok(checkListing({ ...en, keywords: "calorie,diet" }).some((p) => p.includes('"calorie" is already in the name')));
  assert.ok(checkListing({ ...en, keywords: "MACRO" }).some((p) => p.includes("already in the name or subtitle")), "case doesn't matter");
  assert.deepEqual(checkListing({ ...en, keywords: "calories" }), [], "a different word form is a different word");
});

test("checkListing: keyword field comma rules", () => {
  assert.ok(checkListing({ ...en, keywords: "a,,b" }).some((p) => p.includes("empty item")));
  assert.ok(checkListing({ ...en, keywords: "a,b," }).some((p) => p.includes("empty item")));
  assert.ok(checkListing({ ...en, keywords: "a b" }).some((p) => p.includes("spaces")));
  assert.ok(checkListing({ ...en, keywords: "diet,DIET" }).some((p) => p.includes("twice")));
  assert.ok(checkListing({ ...en, keywords: " diet" }).some((p) => p.includes("spaces")), "a leading space is a space");
});

test("checkListing: Japanese words are matched as substrings (no spaces between words)", () => {
  const ja = { locale: "ja", countries: ["jp"], name: "カロリー計算アプリ", subtitle: "食事記録", keywords: "カロリー,ダイエット" };
  assert.ok(checkListing(ja).some((p) => p.includes('"カロリー" is already in the name')));
  assert.deepEqual(checkListing({ ...ja, keywords: "ダイエット,体重" }), []);
});

test("checkListing: an empty locale is labelled, not 'undefined'", () => {
  assert.ok(checkListing({ ...en, locale: "", name: "x".repeat(31) })[0].startsWith("(no locale):"));
});

// ---- validateListings ----

test("validateListings: a good set passes, including two countries sharing one listing", () => {
  assert.deepEqual(validateListings({ listings: [en, de] }, COUNTRIES), []);
  assert.deepEqual(validateListings({ listings: [{ ...en, countries: ["us", "gb"] }] }, COUNTRIES), []);
});

test("validateListings: input that isn't { listings: [...] } is one clear problem", () => {
  for (const input of [null, undefined, {}, [], { listings: [] }, { listings: "x" }, { listings: {} }]) {
    assert.deepEqual(validateListings(input, COUNTRIES), ['expected { "listings": [ … ] }'], JSON.stringify(input));
  }
});

test("validateListings: a null entry is reported and the others are still checked", () => {
  const problems = validateListings({ listings: [null, { ...en, name: "x".repeat(40) }] }, COUNTRIES);
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => p.includes("must be an object")));
  assert.ok(problems.some((p) => p.includes("name is 40/30")));
});

test("validateListings: locale and countries are required and countries must be the user's own", () => {
  const { locale, ...noLocale } = en;
  assert.ok(validateListings({ listings: [noLocale] }, COUNTRIES).some((p) => p.includes('"locale" is missing')));
  for (const countries of [undefined, [], "us", null, 5]) {
    assert.ok(validateListings({ listings: [{ ...en, countries }] }, COUNTRIES).some((p) => p.includes('"countries" must be a list')), JSON.stringify(countries));
  }
  const unknown = validateListings({ listings: [{ ...en, countries: ["us", "jp"] }] }, COUNTRIES);
  assert.deepEqual(unknown, ['en-US: "jp" isn\'t one of your countries (us, gb, de)']);
});

test("validateListings: one country can't be in two listings, and a locale can't appear twice", () => {
  const clash = validateListings({ listings: [en, { ...de, countries: ["de", "us"] }] }, COUNTRIES);
  assert.deepEqual(clash, ['de-DE: "us" is already in the en-US listing']);
  const twice = validateListings({ listings: [en, { ...en, countries: ["gb"] }] }, COUNTRIES);
  assert.deepEqual(twice, ["en-US: locale appears in two listings (merge them)"]);
});

test("validateListings: reports every problem at once", () => {
  const problems = validateListings({ listings: [null, { ...en, countries: ["zz"], keywords: "a b" }, { ...de, locale: undefined, countries: "de" }] }, COUNTRIES);
  assert.ok(problems.length >= 5, problems.join(" | "));
});

// ---- the real command ----

const script = fileURLToPath(new URL("../skills/searchd-audit/scripts/audit.js", import.meta.url));
function runCheck(input) {
  writeFileSync(join(process.env.SEARCHD_DIR, "app.json"), JSON.stringify({ id: 1, name: "Me", countries: COUNTRIES }));
  return spawnSync(process.execPath, [script, "check"], { input: JSON.stringify(input), encoding: "utf8", env: process.env });
}

test("audit.js check: a valid set is saved to audit.json with counts printed", () => {
  const result = runCheck({ listings: [en, de] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /en-US \(US\)/);
  assert.match(result.stdout, /name\s+✓\s+22\/30/);
  assert.match(result.stdout, /All listings pass/);
  assert.deepEqual(readJson("audit.json").listings, [en, de]);
});

test("audit.js check: any problem means exit 1, every problem listed, and nothing saved", () => {
  const result = runCheck({ listings: [null, { ...en, keywords: "calorie, x" }, { ...de, countries: ["jp"] }] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Not saved\. Fix these:/);
  assert.match(result.stderr, /must be an object/);
  assert.match(result.stderr, /spaces/);
  assert.match(result.stderr, /"jp" isn't one of your countries/);
  assert.ok(!existsSync(join(process.env.SEARCHD_DIR, "audit.json")), "nothing was saved");
  assert.ok(!result.stderr.includes("TypeError"), "no stack trace");
});

test("audit.js check: a failed check leaves the previous audit.json alone", () => {
  assert.equal(runCheck({ listings: [en] }).status, 0);
  const before = readJson("audit.json");
  assert.equal(runCheck({ listings: [{ ...en, name: "x".repeat(31) }] }).status, 1);
  assert.deepEqual(readJson("audit.json"), before);
});
