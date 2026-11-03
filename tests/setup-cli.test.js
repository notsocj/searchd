// End-to-end tests of `setup.js resolve` and `setup.js save` as real child processes, WITHOUT the
// network: the client reads today's cache before it ever fetches, so each test seeds the exact
// cache file the script will ask for. If a script tried a real request, the lookup key wouldn't
// match and the test would fail instead of reaching Apple.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
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

const setup = fileURLToPath(new URL("../skills/searchd-setup/scripts/setup.js", import.meta.url));
const run = (args, input = "") => spawnSync(process.execPath, [setup, ...args], { input, encoding: "utf8", env: process.env, cwd: process.env.SEARCHD_DIR });
const save = (body) => run(["save"], JSON.stringify(body));
const dir = (...parts) => join(process.env.SEARCHD_DIR, ...parts);

/** Put an answer where the iTunes client looks for it (same name scheme as lib/itunes.js). */
function seed(kind, key, country, results, platform = "iphone") {
  // iPhone keeps the original key; other platforms put their name first (see cacheName in lib/itunes.js).
  const id = platform === "iphone" ? `${kind}:${key}` : `${platform}/${kind}:${key}`;
  const hash = createHash("sha1").update(id).digest("hex").slice(0, 16);
  writeJson(`cache/${today()}/${country}/${hash}.json`, { kind, key, country, results });
}
const store = (id, name, extra = {}) => ({ id, name, icon: `https://img/${id}.png`, ratings: id, rating: 4.5, seller: `Seller ${id}`, description: `About ${name}`, ...extra });

// ---- resolve ----

test("resolve: a link or ID is looked up (one match); a name gives the top 5 search results", () => {
  seed("lookup", "1145935738", "de", [store(1145935738, "Cronometer")]);
  const byLink = JSON.parse(run(["resolve", "https://apps.apple.com/de/app/cronometer/id1145935738"]).stdout);
  assert.deepEqual(byLink.matches.map((m) => [m.id, m.name, m.seller]), [[1145935738, "Cronometer", "Seller 1145935738"]]);
  assert.deepEqual(Object.keys(byLink.matches[0]).sort(), ["icon", "id", "name", "ratings", "seller"], "no descriptions are handed to the agent");

  seed("search", "daily planner", "us", Array.from({ length: 9 }, (_, i) => store(100 + i, `Planner ${i}`)));
  const byName = JSON.parse(run(["resolve", "daily", "planner"]).stdout);
  assert.deepEqual(byName.matches.map((m) => m.id), [100, 101, 102, 103, 104]);
});

test("resolve: an app that isn't sold in that country gives an empty match list, not an error", () => {
  seed("lookup", "1145935738", "us", []);
  const result = run(["resolve", "id1145935738"]);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { matches: [] });
});

test("resolve without anything to resolve prints usage and exits 1", () => {
  assert.equal(run(["resolve"]).status, 1);
  assert.match(run(["resolve"]).stderr, /Usage: setup\.js/);
});

// ---- save ----

test("save: writes app.json (with competitor names) and the seeds as tracked keywords", () => {
  seed("lookup", "1,9", "us", [store(1, "Me", { description: "d".repeat(3000) }), store(9, "Rival")]);
  const result = save({ appId: 1, countries: ["us", "de"], seeds: ["Daily Planner!", "daily   planner", "🍅 Focus"], competitors: [9] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Saved Me \(1\), 2 countries \(us, de\), 2 keywords/);
  const app = readJson("app.json");
  assert.deepEqual([app.id, app.name, app.seller, app.countries], [1, "Me", "Seller 1", ["us", "de"]]);
  assert.equal(app.description.length, 2000, "the description is capped");
  assert.deepEqual(app.competitors, [{ id: 9, name: "Rival", icon: "https://img/9.png" }]);
  assert.deepEqual(readJson("keywords.json").map((k) => [k.keyword, k.status, k.source]), [["daily planner", "tracked", "seed"], ["focus", "tracked", "seed"]]);
});

test("save: a competitor that isn't found gets a placeholder name and a note", () => {
  seed("lookup", "1,9", "us", [store(1, "Me")]);
  const result = save({ appId: 1, countries: ["us"], competitors: [9] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Not found in US: competitor 9/);
  assert.deepEqual(readJson("app.json").competitors, [{ id: 9, name: "App 9", icon: "" }]);
});

test("save: an app that isn't on the first country's store exits 1 and saves nothing", () => {
  seed("lookup", "1", "us", [store(2, "Someone else")]);
  const result = save({ appId: 1, countries: ["us"] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /app 1 isn't on the US App Store/);
  assert.deepEqual(readdirSync(dir()), ["cache"], "only the cache exists");
});

test("save again: keeps localized keywords and their status, adds only new seeds, updates the countries", () => {
  seed("lookup", "1", "us", [store(1, "Me")]);
  save({ appId: 1, countries: ["us", "de"], seeds: ["planner"] });
  const keywords = readJson("keywords.json");
  keywords[0].local = { us: "planner", de: "planer" };
  keywords.push({ keyword: "habit", status: "idea", local: { us: "habit" } });
  writeJson("keywords.json", keywords);

  const result = save({ appId: 1, countries: ["us"], seeds: ["Planner", "habit", "timer"] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readJson("app.json").countries, ["us"]);
  assert.deepEqual(readJson("keywords.json").map((k) => [k.keyword, k.status]), [["planner", "tracked"], ["habit", "idea"], ["timer", "tracked"]]);
  assert.deepEqual(readJson("keywords.json")[0].local, { us: "planner", de: "planer" }, "local phrases are kept");
  assert.ok(!existsSync(dir("archive")), "same app: nothing archived");
});

test("save with a different app: the old app's data moves to archive/<id>-<date>/ and nothing mixes", () => {
  seed("lookup", "1", "us", [store(1, "Old App")]);
  seed("lookup", "2", "us", [store(2, "New App")]);
  save({ appId: 1, countries: ["us"], seeds: ["planner"] });
  writeJson("results.json", { entries: { "planner|us": { rank: 1 } } });
  writeJson(`history/${today()}.json`, { date: today(), ranks: { "planner|us": 1 } });
  writeJson("audit.json", { listings: [] });
  writeJson("releases.json", { releases: [{ version: "1.0" }] });
  writeJson("competitor-releases.json", { 9: { releases: [] } });

  const result = save({ appId: 2, countries: ["us"], seeds: ["timer"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Switched from Old App to New App/);
  const archive = dir("archive", `1-${today()}`);
  assert.deepEqual(readdirSync(archive).sort(), ["audit.json", "competitor-releases.json", "history", "keywords.json", "releases.json", "results.json"]);
  assert.equal(readJson("app.json").id, 2);
  assert.deepEqual(readJson("keywords.json").map((k) => k.keyword), ["timer"], "the new app starts with only its own seeds");
  assert.ok(!existsSync(dir("results.json")) && !existsSync(dir("history")) && !existsSync(dir("audit.json")));
  assert.ok(!existsSync(dir("releases.json")) && !existsSync(dir("competitor-releases.json")), "the new app doesn't inherit the old app's releases");
});

test("save prints app names without terminal control codes or bidi overrides", () => {
  seed("lookup", "3", "us", [store(3, "Evil\u001b[2J\u202eppA")]);
  const result = save({ appId: 3, countries: ["us"], seeds: ["timer"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Saved Evil\[2JppA \(3\)/m);
  assert.ok(!/[\u001b\u202e]/.test(result.stdout));
});

test("switching apps twice on the same day keeps BOTH archives (nothing is overwritten or half-moved)", () => {
  for (const id of [1, 2]) seed("lookup", String(id), "us", [store(id, `App ${id}`)]);
  save({ appId: 1, countries: ["us"], seeds: ["one"] });
  writeJson("results.json", { entries: { first: { rank: 1 } } });
  writeJson(`history/${today()}.json`, { date: today(), ranks: { first: 1 } });
  save({ appId: 2, countries: ["us"], seeds: ["two"] }); // archives app 1
  writeJson("results.json", { entries: { second: { rank: 2 } } });
  writeJson(`history/${today()}.json`, { date: today(), ranks: { second: 2 } });
  save({ appId: 1, countries: ["us"], seeds: ["one"] }); // archives app 2
  writeJson("results.json", { entries: { third: { rank: 3 } } });
  writeJson(`history/${today()}.json`, { date: today(), ranks: { third: 3 } });

  const result = save({ appId: 2, countries: ["us"], seeds: ["two"] }); // archives app 1 AGAIN
  assert.equal(result.status, 0, result.stderr);
  const archives = readdirSync(dir("archive")).sort();
  assert.equal(archives.length, 3, `three archives, got ${archives}`);
  const allResults = archives.flatMap((a) => (existsSync(dir("archive", a, "results.json")) ? [Object.keys(readJson(`archive/${a}/results.json`).entries)[0]] : []));
  assert.deepEqual(allResults.sort(), ["first", "second", "third"], "every earlier run's results survived");
});

// ---- platform (iPhone, iPad, Mac) ----

test("save: platform defaults to iphone, and is saved in app.json", () => {
  seed("lookup", "1", "us", [store(1, "Me")]);
  const result = save({ appId: 1, countries: ["us"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Saved Me \(1\), 1 country/m, "iPhone isn't named: it's the default");
  assert.equal(readJson("app.json").platform, "iphone");
});

test("save: an iPad or Mac platform is saved, named in the output, and looked up in its own cache", () => {
  // Seeded ONLY under the ipad key: if save used the iPhone cache it would miss and try the network.
  seed("lookup", "1", "us", [store(1, "Me")], "ipad");
  const result = save({ appId: 1, platform: "ipad", countries: ["us"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Saved Me \(1\) for iPad, 1 country/m);
  assert.equal(readJson("app.json").platform, "ipad");
});

test("save again without a platform keeps the saved one (adding a country doesn't switch back to iPhone)", () => {
  seed("lookup", "1", "us", [store(1, "Me")], "mac");
  save({ appId: 1, platform: "mac", countries: ["us"], seeds: ["planner"] });
  const result = save({ appId: 1, countries: ["us"], seeds: ["timer"] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readJson("app.json").platform, "mac");
  assert.ok(!existsSync(dir("archive")), "same app, same platform: nothing archived");
});

test("save: an app.json from before platforms existed counts as iPhone, and gains the field", () => {
  seed("lookup", "1", "us", [store(1, "Me")]);
  writeJson("app.json", { id: 1, name: "Me", countries: ["us"], competitors: [] }); // no "platform"
  writeJson("results.json", { entries: { "planner|us": { rank: 1 } } });
  const result = save({ appId: 1, countries: ["us"] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readJson("app.json").platform, "iphone");
  assert.ok(!existsSync(dir("archive")), "no platform field = iphone = not a switch");
  assert.ok(existsSync(dir("results.json")));
});

test("save: the same app on another platform archives the old ranks (iPad ranks aren't iPhone ranks)", () => {
  seed("lookup", "1", "us", [store(1, "Me")]);
  seed("lookup", "1", "us", [store(1, "Me")], "ipad");
  save({ appId: 1, countries: ["us"], seeds: ["planner"] });
  writeJson("results.json", { entries: { "planner|us": { rank: 4 } } });
  writeJson(`history/${today()}.json`, { date: today(), ranks: { "planner|us": 4 } });

  const result = save({ appId: 1, platform: "ipad", countries: ["us"], seeds: ["planner"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Switched from iPhone to iPad: the old platform's data was moved to/);
  assert.deepEqual(readdirSync(dir("archive", `1-${today()}`)).sort(), ["history", "keywords.json", "results.json"]);
  assert.ok(!existsSync(dir("results.json")) && !existsSync(dir("history")));
  assert.equal(readJson("app.json").platform, "ipad");
});

test("save: an unknown platform is a problem and nothing is saved", () => {
  for (const platform of ["android", "iPad", "", null, 1, "constructor"]) {
    const result = save({ appId: 1, platform, countries: ["us"] });
    assert.equal(result.status, 1, JSON.stringify(platform));
    assert.match(result.stderr, /platform must be one of "iphone", "ipad", "mac"/);
  }
  assert.ok(!existsSync(dir("app.json")));
});

test("save: a Mac app set up for iPhone gets a note (it would never show up in iPhone searches)", () => {
  seed("lookup", "1", "us", [store(1, "Desk Tool", { kind: "mac-software" })]);
  const result = save({ appId: 1, countries: ["us"] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Note: Desk Tool is a Mac app, but the platform is iPhone/);
  seed("lookup", "1", "us", [store(1, "Desk Tool", { kind: "mac-software" })], "mac");
  assert.doesNotMatch(save({ appId: 1, platform: "mac", countries: ["us"] }).stdout, /Note:/);
});

test("resolve --platform searches that platform's store (its own cache key); a bad value exits 1", () => {
  seed("search", "daily planner", "us", [store(7, "Mac Planner")], "mac");
  const byName = JSON.parse(run(["resolve", "daily planner", "--platform", "mac"]).stdout);
  assert.deepEqual(byName.matches.map((m) => m.id), [7]);
  const bad = run(["resolve", "daily planner", "--platform", "watch"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--platform must be iphone, ipad, mac/);
});
