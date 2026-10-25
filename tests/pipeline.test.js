// The whole pipeline as real child processes, still without the network: find check → summary →
// track → audit data. Every search/lookup the scripts make is answered from a pre-seeded cache
// (see setup-cli.test.js), so a request that is NOT seeded would be a real network call; each
// test seeds everything it runs, and the first assertion of each run is a clean exit.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson, writeJson, today } from "../skills/searchd-find/scripts/lib/store.js";

beforeEach(() => {
  process.env.SEARCHD_DIR = mkdtempSync(join(tmpdir(), "searchd-test-"));
});

// Every child process starts with fetch replaced by one that throws (see helpers/no-network.cjs),
// so a script that tried to leave the machine would fail the test instead of reaching Apple.
process.env.NODE_OPTIONS = `--require ${fileURLToPath(new URL("./helpers/no-network.cjs", import.meta.url))}`;

const script = (skill, file) => fileURLToPath(new URL(`../skills/${skill}/scripts/${file}`, import.meta.url));
const find = script("searchd-find", "find.js");
const track = script("searchd-track", "track.js");
const audit = script("searchd-audit", "audit.js");
const run = (file, args = []) => spawnSync(process.execPath, [file, ...args], { encoding: "utf8", env: process.env, cwd: process.env.SEARCHD_DIR });

function seed(kind, key, country, results) {
  const hash = createHash("sha1").update(`${kind}:${key}`).digest("hex").slice(0, 16);
  writeJson(`cache/${today()}/${country}/${hash}.json`, { kind, key, country, results });
}
const app = (id, name, ratings = 10, description = "") => ({ id, name, icon: "https://img/x.png", ratings, rating: 4, seller: "S", description });

/** App 1 ("Me") with two countries and two keywords: "planner" is tracked, "timer" is an idea. */
function setupWorld() {
  writeJson("app.json", { id: 1, name: "Me", description: "A planner", countries: ["us", "de"], competitors: [{ id: 9, name: "Rival", icon: "" }] });
  writeJson("keywords.json", [
    { keyword: "planner", status: "tracked", local: { us: "planner", de: "planer" } },
    { keyword: "timer", status: "idea", local: { us: "timer", de: "zeitmesser" } },
  ]);
  // planner/us: Rival #1, Me #2.   planner/de: Me #1.   timer/us: Me not in the results.   timer/de: Me #3.
  seed("search", "planner", "us", [app(9, "Planner Pro", 5000), app(1, "Me"), app(3, "Other")]);
  seed("search", "planer", "de", [app(1, "Me"), app(9, "Planer Pro", 50)]);
  seed("search", "timer", "us", [app(9, "Timer Rival", 100), app(3, "Timer")]);
  seed("search", "zeitmesser", "de", [app(9, "A"), app(3, "B"), app(1, "Me")]);
}

test("find check: searches every keyword × country, saves results and history, and summary reads them back", () => {
  setupWorld();
  const result = run(find, ["check"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^4 checks \(0 new today\)\./);
  assert.match(result.stdout, /1\/4 · .* planner → #2 · vol \d+ · diff \d+/);
  assert.match(result.stdout, /Done: 4 checked\./);

  const { entries } = readJson("results.json");
  assert.deepEqual(Object.fromEntries(Object.entries(entries).map(([k, e]) => [k, e.rank])), { "planner|us": 2, "planner|de": 1, "timer|us": null, "timer|de": 3 });
  assert.deepEqual(entries["planner|us"].competitors, { 9: 1 });
  assert.deepEqual(readJson(`history/${today()}.json`).ranks, { "planner|us": 2, "planner|de": 1, "timer|us": null, "timer|de": 3 });
  assert.ok(!existsSync(join(process.env.SEARCHD_DIR, "run.lock")));

  const summary = run(find, ["summary"]).stdout;
  assert.match(summary, /^planner \[tracked\]: .*#2.*\|.*planer #1/m);
  assert.match(summary, /^timer \[idea\]: .*200\+.*#3/m);
  assert.match(run(find, ["summary", "--status", "tracked"]).stdout, /^planner/);
  assert.doesNotMatch(run(find, ["summary", "--status", "tracked"]).stdout, /timer/);
});

test("find check: --keywords and --countries narrow the run; the rest of results.json is untouched", () => {
  setupWorld();
  assert.equal(run(find, ["check"]).status, 0);
  const before = readJson("results.json").entries["timer|de"];
  const result = run(find, ["check", "--keywords", "Planner", "--countries", "us"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^1 checks/);
  assert.deepEqual(readJson("results.json").entries["timer|de"], before);
});

test("track: first day says so; next day reports who moved up and down and the top-3 count", () => {
  setupWorld();
  const first = run(track);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Done: 2 checked\./, "only the tracked keyword, in both countries");
  assert.match(first.stdout, /First day of history/);
  assert.match(first.stdout, /Top 3 in 2 of 2 checks: 🥇 1 · 🥈 1/);
  assert.match(first.stdout, /e\.g\. /);
  assert.deepEqual(Object.keys(readJson(`history/${today()}.json`).ranks).sort(), ["planner|de", "planner|us"], "ideas aren't tracked");

  // An earlier day: planner/us was #5 (now #2: up 3), planner/de was #1 (unchanged), a removed keyword is ignored.
  writeJson("history/2000-01-01.json", { date: "2000-01-01", ranks: { "planner|us": 5, "planner|de": 1, "gone|us": 4 } });
  const second = run(track);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /Since 2000-01-01: 1 up, 0 down\./);
  assert.match(second.stdout, /🇺🇸 planner: #5 → #2 \(▲3\)/);
  assert.doesNotMatch(second.stdout, /gone/);
  assert.doesNotMatch(second.stdout, /First day/);
});

test("track: a drop out of the results shows as 200+ and counts as a fall", () => {
  setupWorld();
  seed("search", "planner", "us", [app(9, "Planner Pro", 5000), app(3, "Other")]); // Me is gone
  writeJson("history/2000-01-01.json", { date: "2000-01-01", ranks: { "planner|us": 2, "planner|de": 1 } });
  const result = run(track, ["--countries", "us"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Since 2000-01-01: 0 up, 1 down\./);
  assert.match(result.stdout, /🇺🇸 planner: #2 → 200\+ \(▼199\)/);
});

test("track: keywords with no local phrase are listed as skipped, and --countries must be the app's own", () => {
  setupWorld();
  writeJson("keywords.json", [{ keyword: "planner", status: "tracked", local: { us: "planner" } }]);
  const result = run(track);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Skipped \(no local phrase yet.*planner \(de\)/);
  assert.equal(run(track, ["--countries", "jp"]).status, 1);
});

test("audit data: per country the current name (null when not sold there) and the best keywords first", () => {
  setupWorld();
  assert.equal(run(find, ["check"]).status, 0);
  seed("lookup", "1", "us", [app(1, "Me: Planner")]);
  seed("lookup", "1", "de", []); // not sold in Germany
  const result = run(audit, ["data"]);
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(data.countries), ["us", "de"]);
  assert.equal(data.countries.us.currentName, "Me: Planner");
  assert.equal(data.countries.de.currentName, null);
  const us = data.countries.us.keywords;
  assert.deepEqual(us.map((k) => k.keyword).sort(), ["planner", "timer"]);
  assert.ok(us[0].opportunity >= us[1].opportunity, "best opportunity first");
  assert.deepEqual(Object.keys(us[0]).sort(), ["difficulty", "keyword", "opportunity", "phrase", "rank", "volume"]);
});

test("a second find check the same day is free: everything comes from the cache and results are identical", () => {
  setupWorld();
  assert.equal(run(find, ["check"]).status, 0);
  const first = readJson("results.json").entries;
  const again = run(find, ["check"]);
  assert.equal(again.status, 0, again.stderr);
  const second = readJson("results.json").entries;
  for (const key of Object.keys(first)) {
    const { checkedAt: a, ...x } = first[key];
    const { checkedAt: b, ...y } = second[key];
    assert.deepEqual(y, x, key);
  }
  assert.equal(readdirSync(join(process.env.SEARCHD_DIR, "cache", today(), "us")).length, 2, "no extra cache files were created");
});

test("the no-network guard works: any fetch in a child process fails loudly instead of reaching Apple", () => {
  // Not through find.js: the real client waits 10 s before retrying a network error.
  const result = spawnSync(process.execPath, ["-e", "fetch('https://itunes.apple.com/search?term=x').catch((e) => console.log(e.message))"], { encoding: "utf8", env: process.env });
  assert.equal(result.stdout.trim(), "network disabled in tests (tried to fetch https://itunes.apple.com/search)");
});
