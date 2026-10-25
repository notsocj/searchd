// Edge-case tests for the validation the scripts do on data the agent sends (find.js keywords,
// setup.js save) and for setup's input parsing. The rule: list ALL problems at once, save nothing.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeKeywords } from "../skills/searchd-find/scripts/find.js";
import { parseAppInput, validateSave, DEFAULT_COUNTRIES } from "../skills/searchd-setup/scripts/setup.js";
import { readJson } from "../skills/searchd-find/scripts/lib/store.js";

beforeEach(() => {
  process.env.SEARCHD_DIR = mkdtempSync(join(tmpdir(), "searchd-test-"));
});

const COUNTRIES = ["us", "de"];
const existing = () => [{ keyword: "notes", status: "tracked", local: { us: "notes" }, source: "seed", addedAt: "2026-01-01T00:00:00.000Z" }];

// ---- mergeKeywords ----

test("mergeKeywords: reports every problem in one go, not just the first", () => {
  const { problems } = mergeKeywords([], [
    { keyword: "🍅🍅" }, // only symbols
    { keyword: "x".repeat(101) }, // too long
    { keyword: "ok", status: "maybe" }, // bad status
    { keyword: "fine", local: { fr: "x", us: "🍅", de: "ok" } }, // unknown country + symbol-only phrase
    null,
    "just a string",
  ], COUNTRIES);
  assert.equal(problems.length, 7);
  assert.ok(problems.every((p) => /^item \d+/.test(p)), "each problem says which item");
});

test("mergeKeywords: input that isn't a list is one clear problem and changes nothing", () => {
  for (const input of [null, {}, "x", 5, undefined]) {
    const { keywords, problems } = mergeKeywords(existing(), input, COUNTRIES);
    assert.deepEqual(problems, ["expected a JSON list of keywords"]);
    assert.deepEqual(keywords, existing());
  }
});

test("mergeKeywords: an empty list is fine and keeps everything", () => {
  const { keywords, problems } = mergeKeywords(existing(), [], COUNTRIES);
  assert.deepEqual(problems, []);
  assert.deepEqual(keywords, existing());
});

test("mergeKeywords: never mutates the list it was given (the caller saves only when there are no problems)", () => {
  const before = existing();
  const { keywords } = mergeKeywords(before, [{ keyword: "notes", status: "idea", local: { de: "notizen" } }, { keyword: "new", local: { us: "new" } }], COUNTRIES);
  assert.deepEqual(before, existing(), "the original is untouched");
  assert.equal(keywords.length, 2);
  assert.deepEqual(keywords[0].local, { us: "notes", de: "notizen" });
});

test("mergeKeywords: a keyword is cleaned, and the same keyword twice in one list merges", () => {
  const { keywords, problems } = mergeKeywords([], [
    { keyword: "  Daily   PLANNER! ", local: { us: "Daily Planner" } },
    { keyword: "daily planner", local: { de: "Tagesplaner" }, status: "tracked" },
  ], COUNTRIES);
  assert.deepEqual(problems, []);
  assert.equal(keywords.length, 1);
  assert.equal(keywords[0].keyword, "daily planner");
  assert.deepEqual(keywords[0].local, { us: "daily planner", de: "tagesplaner" });
  assert.equal(keywords[0].status, "tracked");
});

test("mergeKeywords: new keywords default to idea/brainstorm; tracked ones are manual", () => {
  const { keywords } = mergeKeywords([], [{ keyword: "a" }, { keyword: "b", status: "tracked" }], COUNTRIES);
  assert.deepEqual(keywords.map((k) => [k.status, k.source]), [["idea", "brainstorm"], ["tracked", "manual"]]);
  assert.ok(keywords.every((k) => !Number.isNaN(Date.parse(k.addedAt))));
});

test("mergeKeywords: updating an existing keyword keeps its other fields; only given parts change", () => {
  const { keywords } = mergeKeywords(existing(), [{ keyword: "Notes" }], COUNTRIES);
  assert.deepEqual(keywords, existing());
  const [changed] = mergeKeywords(existing(), [{ keyword: "notes", status: "idea" }], COUNTRIES).keywords;
  assert.equal(changed.status, "idea");
  assert.equal(changed.source, "seed");
  assert.equal(changed.addedAt, "2026-01-01T00:00:00.000Z");
});

test("mergeKeywords: removing a keyword that isn't there is not an error", () => {
  const { keywords, problems } = mergeKeywords(existing(), [{ keyword: "ghost", remove: true }], COUNTRIES);
  assert.deepEqual(problems, []);
  assert.equal(keywords.length, 1);
});

test("mergeKeywords: a bad item doesn't stop the good ones from being checked, but the caller must not save", () => {
  const { keywords, problems } = mergeKeywords([], [{ keyword: "good", local: { us: "good" } }, { keyword: "bad", local: { zz: "x" } }], COUNTRIES);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /item 2 \(bad\): "zz" isn't one of your countries \(us, de\)/);
  assert.equal(keywords.length, 2, "the merge result exists, saving it is the caller's decision");
});

test("mergeKeywords: local phrases of the wrong type are problems, not crashes", () => {
  const { problems } = mergeKeywords([], [{ keyword: "a", local: { us: 123, de: ["x"] } }, { keyword: "b", local: "abc" }, { keyword: "c", local: null }], COUNTRIES);
  assert.equal(problems.filter((p) => p.startsWith("item 1")).length, 2);
  assert.ok(problems.some((p) => p.startsWith("item 2")));
  assert.ok(!problems.some((p) => p.startsWith("item 3")), "local: null means no phrases");
});

test("mergeKeywords: odd country names can't pollute the object (__proto__, constructor)", () => {
  const { keywords, problems } = mergeKeywords([], [{ keyword: "a", local: { ["__proto__"]: "x", constructor: "y" } }], COUNTRIES);
  assert.equal(problems.length, 2);
  assert.deepEqual(Object.keys(keywords[0].local), []);
  assert.equal({}.polluted, undefined);
});

test("mergeKeywords: '|' in a keyword or phrase never survives (it separates keyword|country keys)", () => {
  const { keywords } = mergeKeywords([], [{ keyword: "a|b", local: { us: "a|b|us" } }], COUNTRIES);
  assert.equal(keywords[0].keyword, "a b");
  assert.equal(keywords[0].local.us, "a b us");
});

test("mergeKeywords: keywords that clean to the same text are the same keyword", () => {
  const { keywords } = mergeKeywords([], [{ keyword: "Café" }, { keyword: "CAFÉ" }, { keyword: "café!" }], COUNTRIES);
  assert.equal(keywords.length, 1);
});

// ---- validateSave ----

test("validateSave: JSON that isn't an object is a normal problem, not a crash", () => {
  for (const input of [null, [], "x", 5, true]) {
    const { problems } = validateSave(input);
    assert.deepEqual(problems, ["appId must be the app's numeric ID"], JSON.stringify(input));
  }
});

test("validateSave: defaults to the ten countries and no seeds or competitors", () => {
  const result = validateSave({ appId: 1 });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.countries, DEFAULT_COUNTRIES);
  assert.deepEqual([result.seeds, result.competitors], [[], []]);
});

test("validateSave: lists every problem at once", () => {
  const { problems } = validateSave({ appId: 1.5, countries: [], seeds: "x", competitors: "y" });
  assert.equal(problems.length, 4);
});

test("validateSave: a seed made only of symbols is a problem (it would be silently dropped on save)", () => {
  assert.equal(validateSave({ appId: 1, seeds: ["daily planner", "🍅"] }).problems.length, 1);
  assert.equal(validateSave({ appId: 1, seeds: ["❤️", "  "] }).problems.length, 1, "one problem for the whole list");
  assert.equal(validateSave({ appId: 1, seeds: ["x".repeat(101)] }).problems.length, 1);
  assert.equal(validateSave({ appId: 1, seeds: [5] }).problems.length, 1);
  assert.deepEqual(validateSave({ appId: 1, seeds: ["Pomodoro™ Timer"] }).problems, []);
});

test("validateSave: repeated countries and competitors are collapsed, order kept", () => {
  const { countries, competitors, problems } = validateSave({ appId: 1, countries: ["de", "us", "de"], competitors: [5, 6, 5] });
  assert.deepEqual(problems, []);
  assert.deepEqual(countries, ["de", "us"]);
  assert.deepEqual(competitors, [5, 6]);
});

test("validateSave: a country code must be two lowercase letters", () => {
  for (const bad of ["USA", "u", "U1", "us ", "ß"]) assert.equal(validateSave({ appId: 1, countries: [bad] }).problems.length, 1, bad);
});

// ---- parseAppInput ----

test("parseAppInput: whitespace, upper case and numbers are handled", () => {
  assert.deepEqual(parseAppInput("  1145935738  "), { id: 1145935738 });
  assert.deepEqual(parseAppInput("ID1145935738"), { id: 1145935738 });
  assert.deepEqual(parseAppInput(1145935738), { id: 1145935738 });
  assert.deepEqual(parseAppInput("https://apps.apple.com/DE/app/x/id1145935738"), { id: 1145935738, country: "de" });
});

test("parseAppInput: short numbers and words are names, not IDs", () => {
  assert.deepEqual(parseAppInput("1234"), { name: "1234" }, "app IDs have at least 5 digits");
  assert.deepEqual(parseAppInput("id123"), { name: "id123" });
  assert.deepEqual(parseAppInput("2048"), { name: "2048" }, "the game");
  assert.deepEqual(parseAppInput("Lose It! 1145935738"), { name: "Lose It! 1145935738" });
});

test("parseAppInput: an Apple link without an app ID falls back to a name search", () => {
  assert.deepEqual(parseAppInput("https://www.apple.com/iphone/"), { name: "https://www.apple.com/iphone/" });
});

test("nothing is saved by the validators themselves", () => {
  mergeKeywords([], [{ keyword: "a" }], COUNTRIES);
  validateSave({ appId: 1, seeds: ["a"] });
  assert.equal(readJson("keywords.json"), null);
  assert.equal(readJson("app.json"), null);
});
