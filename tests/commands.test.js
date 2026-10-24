// Tests for the command scripts' logic: keyword merging, checks, rank movement, the listing
// rules, the dashboard data, and setup's input parsing. No network: checks use a fake client.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

beforeEach(() => {
  process.env.SEARCHD_DIR = mkdtempSync(join(tmpdir(), "searchd-test-"));
});

const { mergeKeywords } = await import("../skills/searchd-find/scripts/find.js");
const { planChecks, runChecks } = await import("../skills/searchd-find/scripts/lib/checks.js");
const { readJson, today } = await import("../skills/searchd-find/scripts/lib/store.js");
const { movement } = await import("../skills/searchd-track/scripts/track.js");
const { checkListing, charCount } = await import("../skills/searchd-audit/scripts/audit.js");
const { losingTo, renderPage } = await import("../skills/searchd-dashboard/scripts/dashboard.js");
const { parseAppInput, validateSave } = await import("../skills/searchd-setup/scripts/setup.js");

test("mergeKeywords adds, merges local phrases, removes, and validates", () => {
  let { keywords, problems } = mergeKeywords([], [{ keyword: "Calorie Counter", local: { us: "Calorie Counter" } }], ["us", "de"]);
  assert.deepEqual(problems, []);
  assert.equal(keywords[0].keyword, "calorie counter");
  assert.equal(keywords[0].status, "idea");
  ({ keywords } = mergeKeywords(keywords, [{ keyword: "calorie counter", status: "tracked", local: { de: "kalorienzähler" } }], ["us", "de"]));
  assert.deepEqual(keywords[0].local, { us: "calorie counter", de: "kalorienzähler" });
  assert.equal(keywords[0].status, "tracked");
  ({ problems } = mergeKeywords(keywords, [{ keyword: "x", local: { jp: "x" } }, { keyword: "y", status: "maybe" }], ["us"]));
  assert.equal(problems.length, 2);
  ({ keywords } = mergeKeywords(keywords, [{ keyword: "calorie counter", remove: true }], ["us"]));
  assert.equal(keywords.length, 0);
});

test("planChecks skips countries without a local phrase", () => {
  const { todo, missing } = planChecks([{ keyword: "a", local: { us: "a" } }], ["us", "de"]);
  assert.equal(todo.length, 1);
  assert.deepEqual(missing, ["a (de)"]);
});

test("runChecks saves results and today's history, and survives a failed search", async () => {
  const client = {
    throttleMs: 0,
    isCached: () => false,
    async search(term) {
      if (term === "broken") throw new Error("iTunes API: HTTP 500");
      return [{ id: 9, name: "Big", ratings: 100 }, { id: 1, name: "Mine", ratings: 5 }];
    },
  };
  const app = { id: 1, competitors: [{ id: 9 }] };
  const todo = [{ keyword: "notes", country: "us", phrase: "notes" }, { keyword: "broken", country: "us", phrase: "broken" }];
  const { done, failed } = await runChecks({ client, app, todo, log: () => {} });
  assert.deepEqual({ done, failed }, { done: 1, failed: 1 });
  const entry = readJson("results.json").entries["notes|us"];
  assert.equal(entry.rank, 2);
  assert.deepEqual(entry.competitors, { 9: 1 });
  assert.equal(readJson(`history/${today()}.json`).ranks["notes|us"], 2);
});

test("movement: 200+ counts as 201, new keywords are ignored", () => {
  const { up, down } = movement({ ranks: { "a|us": 9, "b|us": 5, "c|de": null } }, { ranks: { "a|us": 6, "b|us": null, "c|de": 40, "d|us": 1 } });
  assert.equal(up.length, 2);
  assert.match(up[0], /#9 → #6 \(▲3\)/);
  assert.match(down[0], /#5 → 200\+ \(▼196\)/);
});

test("checkListing enforces Apple's limits and searchd's keyword rules", () => {
  const ok = { locale: "en-US", name: "Cronometer: Calorie Counter", subtitle: "Macro Tracker", keywords: "nutrition,vitamin,diet" };
  assert.deepEqual(checkListing(ok), []);
  const bad = checkListing({ ...ok, keywords: "nutrition, vitamin,macro,diet,diet," });
  assert.ok(bad.some((p) => p.includes("spaces")));
  assert.ok(bad.some((p) => p.includes('"macro" is already in the name')));
  assert.ok(bad.some((p) => p.includes("twice")));
  assert.ok(bad.some((p) => p.includes("empty item")));
  assert.ok(checkListing({ ...ok, name: "x".repeat(31) })[0].includes("31/30"));
  assert.equal(charCount("kalorienzähler🍎"), 15); // the emoji counts as one character
});

test("losingTo counts top-10 apps above you; everyone counts when you're 200+", () => {
  const entries = {
    a: { country: "us", phrase: "a", rank: 2, top: [{ id: 9, name: "Big" }, { id: 1, name: "Me" }, { id: 8, name: "Small" }] },
    b: { country: "us", phrase: "b", rank: null, top: [{ id: 8, name: "Small" }, { id: 9, name: "Big" }] },
  };
  const list = losingTo(entries, 1);
  assert.deepEqual(list.map((r) => [r.id, r.beats]), [[9, 2], [8, 1]]);
  assert.equal(list[0].avgPosition, 1.5);
});

test("renderPage escapes '<' so app names can't close the data script", () => {
  const html = renderPage("<script>__SEARCHD_DATA__</script>/*FONT_400*//*FONT_600*/", { name: "</script><img src=x>$&" }, { 400: "A", 600: "B" });
  assert.ok(!html.includes("</script><img"));
  assert.ok(html.includes("$&"), "replace() patterns in data are left alone");
  assert.ok(html.endsWith("AB"));
});

test("parseAppInput understands links, IDs and names", () => {
  assert.deepEqual(parseAppInput("https://apps.apple.com/de/app/yazio/id946099227?l=en"), { id: 946099227, country: "de" });
  assert.deepEqual(parseAppInput("id1145935738"), { id: 1145935738 });
  assert.deepEqual(parseAppInput("Lose It"), { name: "Lose It" });
});

test("validateSave rejects bad countries, seeds and competitor IDs", () => {
  assert.deepEqual(validateSave({ appId: 1, seeds: ["a"] }).problems, []);
  assert.equal(validateSave({ appId: 1 }).countries.length, 10, "default countries");
  assert.equal(validateSave({ appId: "1", countries: ["USA"], seeds: [""], competitors: ["x"] }).problems.length, 4);
});

test("the dashboard page has every placeholder dashboard.js fills in", () => {
  const page = readFileSync(new URL("../skills/searchd-dashboard/scripts/dashboard-page.html", import.meta.url), "utf8");
  for (const placeholder of ["__SEARCHD_DATA__", "/*FONT_400*/", "/*FONT_600*/"]) assert.ok(page.includes(placeholder), placeholder);
  assert.ok(!/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML/.test(page), "untrusted text must go in with textContent");
});
