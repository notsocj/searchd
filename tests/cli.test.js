// End-to-end tests of the command scripts as real child processes (the way an agent runs them):
// exit codes, what they print, and that a failed command saves nothing. Only commands that never
// reach the network are run here (no `resolve`, no real `check`, no `audit.js data`).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson, writeJson, today } from "../skills/searchd-find/scripts/lib/store.js";
import { summary } from "../skills/searchd-find/scripts/find.js";

beforeEach(() => {
  process.env.SEARCHD_DIR = mkdtempSync(join(tmpdir(), "searchd-test-"));
});

const script = (skill, file) => fileURLToPath(new URL(`../skills/${skill}/scripts/${file}`, import.meta.url));
const find = script("searchd-find", "find.js");
const run = (file, args = [], input = "") => spawnSync(process.execPath, [file, ...args], { input, encoding: "utf8", env: process.env, cwd: process.env.SEARCHD_DIR });
const setupApp = (extra = {}) => writeJson("app.json", { id: 1, name: "Me", description: "A planner", countries: ["us", "de"], competitors: [], ...extra });
const files = () => readdirSync(process.env.SEARCHD_DIR).sort();

// ---- every command needs setup first ----

test("find, track, audit and dashboard say 'not set up' and exit 1 when there is no app.json", () => {
  for (const [file, args] of [[find, ["status"]], [script("searchd-track", "track.js"), []], [script("searchd-audit", "audit.js"), ["check"]], [script("searchd-dashboard", "dashboard.js"), ["--no-open"]]]) {
    const result = run(file, args);
    assert.equal(result.status, 1, file);
    assert.match(result.stderr, /isn't set up in this folder/);
  }
  assert.deepEqual(files(), [], "nothing was created");
});

test("a damaged data file stops the command with a message naming the file", () => {
  writeFileSync(join(process.env.SEARCHD_DIR, "app.json"), "{not json");
  const result = run(find, ["status"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /app\.json isn't valid JSON/);
});

// ---- find.js ----

test("find.js status: lists keywords with the countries that still need a local phrase", () => {
  setupApp();
  writeJson("keywords.json", [{ keyword: "planner", status: "tracked", local: { us: "planner" } }]);
  const out = JSON.parse(run(find, ["status"]).stdout);
  assert.deepEqual(out.countries, ["us", "de"]);
  assert.deepEqual(out.keywords, [{ keyword: "planner", status: "tracked", local: { us: "planner" }, missingCountries: ["de"] }]);
  assert.equal(out.app.description, "A planner");
});

test("find.js keywords: valid input is saved and counted", () => {
  setupApp();
  const input = JSON.stringify([{ keyword: "Daily Planner", status: "tracked", local: { us: "daily planner", de: "tagesplaner" } }, { keyword: "to do", local: { us: "to do" } }]);
  const result = run(find, ["keywords"], input);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Saved 2 keywords \(1 tracked, 1 ideas\)\./);
  assert.deepEqual(readJson("keywords.json").map((k) => k.keyword), ["daily planner", "to do"]);
});

test("find.js keywords: any problem means exit 1, all problems listed, keywords.json untouched", () => {
  setupApp();
  writeJson("keywords.json", [{ keyword: "keep", status: "idea", local: {} }]);
  const before = readFileSync(join(process.env.SEARCHD_DIR, "keywords.json"), "utf8");
  const result = run(find, ["keywords"], JSON.stringify([{ keyword: "ok" }, { keyword: "🍅" }, { keyword: "x", status: "maybe" }, { keyword: "y", local: { jp: "y" } }]));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /nothing saved/);
  assert.equal((result.stderr.match(/^- item/gm) ?? []).length, 3);
  assert.equal(readFileSync(join(process.env.SEARCHD_DIR, "keywords.json"), "utf8"), before);
});

test("find.js keywords: input that isn't JSON exits 1 without a stack trace", () => {
  setupApp();
  for (const input of ["", "not json", "{"]) {
    const result = run(find, ["keywords"], input);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /expected JSON on stdin/);
    assert.ok(!result.stderr.includes("at "), "no stack trace");
  }
});

test("find.js check: bad flags exit 1 before anything runs (and before any network use)", () => {
  setupApp();
  writeJson("keywords.json", [{ keyword: "planner", status: "tracked", local: { us: "planner" } }]);
  assert.match(run(find, ["check", "--status", "maybe"]).stderr, /--status must be tracked, idea, or all/);
  assert.match(run(find, ["check", "--keywords", "ghost"]).stderr, /not a saved keyword: ghost/);
  assert.match(run(find, ["check", "--countries", "us,xx"]).stderr, /--countries must be from your countries \(us, de\)/);
  for (const args of [["--status", "maybe"], ["--keywords", "ghost"], ["--countries", "xx"]]) assert.equal(run(find, ["check", ...args]).status, 1);
  assert.ok(!existsSync(join(process.env.SEARCHD_DIR, "results.json")));
});

test("find.js check: keywords without a local phrase are skipped, not guessed, and nothing is searched", () => {
  setupApp();
  writeJson("keywords.json", [{ keyword: "planner", status: "tracked", local: {} }]);
  const result = run(find, ["check"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Skipped \(no local phrase yet.*planner \(us\), planner \(de\)/);
  assert.match(result.stdout, /Done: 0 checked\./);
  assert.ok(!existsSync(join(process.env.SEARCHD_DIR, "cache")), "no search was made");
});

test("find.js: an unknown command prints usage and exits 1", () => {
  setupApp();
  for (const args of [[], ["bogus"]]) {
    const result = run(find, args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: find\.js/);
  }
});

test("find.js summary: prints the table; unusable --limit values fall back to the default", () => {
  setupApp();
  writeJson("keywords.json", [{ keyword: "planner", status: "tracked", local: { us: "planner" } }, { keyword: "todo", status: "idea", local: {} }]);
  writeJson("results.json", { entries: { "planner|us": { country: "us", phrase: "planner", rank: 2, volume: 40, difficulty: 30, opportunity: 28 } } });
  // "--limit=-3": with a space, Node's parseArgs itself rejects "-3" as an ambiguous value.
  for (const limit of ["abc", "0", "-3", "2.5", ""]) {
    const result = run(find, ["summary", ...(limit === "" ? [] : [`--limit=${limit}`])]);
    assert.equal(result.status, 0, `limit ${limit}: ${result.stderr}`);
    assert.match(result.stdout, /^planner \[tracked\]: .* #2 v40 d30⭐/m);
    assert.match(result.stdout, /^todo \[idea\]: not checked yet$/m);
    assert.doesNotMatch(result.stdout, /more \(lower opportunity\)/, `limit ${limit}`);
  }
  const one = run(find, ["summary", "--limit", "1"]).stdout;
  assert.match(one, /… and 1 more/);
  assert.equal(run(find, ["summary", "--status", "idea"]).stdout.trim(), "todo [idea]: not checked yet");
});

// ---- summary() as a function ----

test("summary(): a limit of 0, negative or fractional never slices from the end or prints decimals", () => {
  const app = { countries: ["us"] };
  const keywords = ["a", "b", "c", "d"].map((k) => ({ keyword: k, status: "idea" }));
  const entries = Object.fromEntries(keywords.map((k, i) => [`${k.keyword}|us`, { country: "us", phrase: k.keyword, rank: null, volume: i, difficulty: 0, opportunity: i }]));
  for (const limit of [0, -2, NaN, undefined, 2.9]) {
    const lines = summary(app, keywords, { entries }, limit).split("\n");
    assert.ok(lines.every((line) => !/\d\.\d/.test(line)), `limit ${limit}: ${lines.at(-1)}`);
  }
  assert.equal(summary(app, keywords, { entries }, 2.9).split("\n").length, 3, "2.9 means 2 keywords plus the 'more' line");
  assert.equal(summary(app, keywords, { entries }, 0).split("\n").length, 4, "0 falls back to the default (all four fit)");
  assert.match(summary(app, keywords, null), /not checked yet/, "no results file at all");
});

// ---- setup.js (only the part that never reaches the network) ----

test("setup.js save: invalid input exits 1 with every problem listed and saves nothing", () => {
  const setup = script("searchd-setup", "setup.js");
  const result = run(setup, ["save"], JSON.stringify({ appId: "nope", countries: ["USA"], seeds: ["🍅"] }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fix these and try again/);
  assert.equal((result.stderr.match(/^- /gm) ?? []).length, 3);
  assert.deepEqual(files(), [], "no app.json, no keywords.json");
  assert.equal(run(setup, ["save"], "null").status, 1);
  assert.ok(!run(setup, ["save"], "null").stderr.includes("TypeError"));
  assert.match(run(setup, []).stderr, /Usage: setup\.js/);
});

// ---- track.js and dashboard.js ----

test("track.js: with no tracked keywords it says so and exits 0", () => {
  setupApp();
  writeJson("keywords.json", [{ keyword: "idea", status: "idea", local: { us: "idea" } }]);
  const result = run(script("searchd-track", "track.js"));
  assert.equal(result.status, 0);
  assert.match(result.stdout, /No tracked keywords yet/);
});

test("dashboard.js: no results yet is a friendly message, exit 0, and no file", () => {
  setupApp();
  writeJson("results.json", { entries: {} });
  const result = run(script("searchd-dashboard", "dashboard.js"), ["--no-open"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /No results yet/);
  assert.ok(!existsSync(join(process.env.SEARCHD_DIR, "dashboard.html")));
});

test("dashboard.js --no-open: builds one self-contained page whose data parses back, even with hostile text", () => {
  const evil = "</script><img src=x onerror=alert(1)>";
  setupApp({ name: evil });
  writeJson("keywords.json", [{ keyword: "planner", status: "tracked", local: { us: "planner" } }]);
  writeJson("results.json", {
    updatedAt: "2026-10-02T00:00:00Z",
    entries: { "planner|us": { keyword: "planner", country: "us", phrase: "planner", rank: 2, volume: 40, difficulty: 30, opportunity: 28, competitors: {}, top: [{ id: 9, name: evil, icon: "https://a/x.png", ratings: 5, rating: 4 }] } },
  });
  mkdirSync(join(process.env.SEARCHD_DIR, "history"));
  writeFileSync(join(process.env.SEARCHD_DIR, "history", "garbage-name.json"), "this is ignored");
  writeJson(`history/${today()}.json`, { date: today(), ranks: { "planner|us": 2 } });
  writeFileSync(join(process.env.SEARCHD_DIR, "history", "2000-01-01.json"), "null"); // wrong shape: skipped

  const result = run(script("searchd-dashboard", "dashboard.js"), ["--no-open"]);
  assert.equal(result.status, 0, result.stderr);
  const html = readFileSync(join(process.env.SEARCHD_DIR, "dashboard.html"), "utf8");
  for (const placeholder of ["__SEARCHD_DATA__", "/*FONT_400*/", "/*FONT_600*/"]) assert.ok(!html.includes(placeholder), `${placeholder} was replaced`);
  const body = html.match(/<script id="searchd-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
  const data = JSON.parse(body);
  assert.equal(data.app.name, evil, "hostile text round-trips as text");
  assert.equal(data.apps[9].name, evil);
  assert.deepEqual(data.history, { dates: [today()], ranks: { "planner|us": [2] } });
  assert.ok(!/<img src=x/.test(html), "the tag never appears raw");
});
