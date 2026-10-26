// Edge-case tests for what track.js and dashboard.js compute from saved data: rank movement,
// "losing to", the packed dashboard data and history, and rendering the page.

import { test } from "node:test";
import assert from "node:assert/strict";
import { movement, recordRelease, watchCompetitors } from "../skills/searchd-track/scripts/track.js";
import { losingTo, buildData, packHistory, renderPage, releaseImpact, competitorChanges } from "../skills/searchd-dashboard/scripts/dashboard.js";
import { today } from "../skills/searchd-find/scripts/lib/store.js";

// ---- movement (track.js) ----

const day = (ranks) => ({ date: "2026-10-01", ranks });

test("movement: nothing changed or nothing to compare gives empty lists", () => {
  assert.deepEqual(movement(day({}), day({})), { up: [], down: [] });
  assert.deepEqual(movement(day({ "a|us": 5, "b|us": null }), day({ "a|us": 5, "b|us": null })), { up: [], down: [] });
  assert.deepEqual(movement(day({ "a|us": 5 }), day({ "b|us": 1 })), { up: [], down: [] }, "different keywords share nothing");
});

test("movement: lines are formatted with flag, keyword, old → new and the size of the move", () => {
  const { up, down } = movement(day({ "daily planner|us": 3, "tagesplaner|de": 10 }), day({ "daily planner|us": 1, "tagesplaner|de": 12 }));
  assert.deepEqual(up, ["🇺🇸 daily planner: #3 → #1 (▲2)"]);
  assert.deepEqual(down, ["🇩🇪 tagesplaner: #10 → #12 (▼2)"]);
});

test("movement: 200+ (null) counts as 201, in both directions, and null → null isn't a move", () => {
  const { up, down } = movement(day({ "a|us": null, "b|us": 1, "c|us": null }), day({ "a|us": 1, "b|us": null, "c|us": null }));
  assert.deepEqual(up, ["🇺🇸 a: 200+ → #1 (▲200)"]);
  assert.deepEqual(down, ["🇺🇸 b: #1 → 200+ (▼200)"]);
});

test("movement: a keyword missing from either day is skipped; '|' inside keywords is fine", () => {
  const { up, down } = movement(day({ "gone|us": 4, "x|y|de": 9 }), day({ "new|us": 1, "x|y|de": 2 }));
  assert.deepEqual(down, []);
  assert.deepEqual(up, ["🇩🇪 x|y: #9 → #2 (▲7)"]);
});

test("movement: lines keep the order of today's keys", () => {
  const { up } = movement(day({ "a|us": 9, "b|us": 9, "c|us": 9 }), day({ "c|us": 1, "a|us": 2, "b|us": 3 }));
  assert.deepEqual(up.map((line) => line.split(":")[0].slice(-1)), ["c", "a", "b"]);
});

test("movement: history files of the wrong shape mean 'nothing to compare', not a crash", () => {
  for (const bad of [{}, null, undefined, { ranks: null }]) {
    assert.deepEqual(movement(bad, day({ "a|us": 1 })), { up: [], down: [] });
    assert.deepEqual(movement(day({ "a|us": 1 }), bad), { up: [], down: [] });
  }
});

// ---- losingTo (dashboard.js) ----

const A = (id, name = `App ${id}`) => ({ id, name, icon: "https://a/x.png", ratings: id });
const entry = (rank, top) => ({ rank, top });

test("losingTo: nothing beats you at #1, and nobody below your position counts", () => {
  assert.deepEqual(losingTo({ k: entry(1, [A(1), A(2), A(3)]) }, 1), []);
  const list = losingTo({ k: entry(2, [A(9), A(1), A(8), A(7)]) }, 1);
  assert.deepEqual(list.map((r) => r.id), [9], "only the app above #2");
});

test("losingTo: when you're not ranked (200+) every top-10 app counts, but never your own app", () => {
  const list = losingTo({ k: entry(null, [A(2), A(1), A(3)]) }, 1);
  assert.deepEqual(list.map((r) => r.id).sort(), [2, 3]);
});

test("losingTo: sorts by number of beats, then by better average position, and honors the limit", () => {
  const entries = {
    a: entry(null, [A(5), A(6), A(7)]), // 5 at 1, 6 at 2, 7 at 3
    b: entry(null, [A(7), A(6), A(5)]), // 7 at 1, 6 at 2, 5 at 3
    c: entry(null, [A(8), A(7)]), // 8 at 1, 7 at 2
  };
  const list = losingTo(entries, 1);
  assert.deepEqual(list.map((r) => [r.id, r.beats, r.avgPosition]), [[7, 3, 2], [5, 2, 2], [6, 2, 2], [8, 1, 1]]); // 5 and 6 tie on everything: first seen first
  assert.equal(losingTo(entries, 1, 2).length, 2);
});

test("losingTo: avgPosition is rounded to one decimal", () => {
  const entries = { a: entry(null, [A(5)]), b: entry(null, [A(6), A(5)]), c: entry(null, [A(6), A(5)]) };
  assert.equal(losingTo(entries, 1).find((r) => r.id === 5).avgPosition, 1.7); // positions 1, 2, 2
});

test("losingTo: no entries, no list; non-https icons are dropped", () => {
  assert.deepEqual(losingTo({}, 1), []);
  const [row] = losingTo({ a: entry(null, [{ ...A(5), icon: "javascript:alert(1)" }]) }, 1);
  assert.equal(row.icon, "");
});

// ---- buildData / packHistory (dashboard.js) ----

const mine = { id: 1, name: "Me", icon: "https://a/me.png", countries: ["us", "de"], competitors: [{ id: 9, name: "Rival", icon: "http://insecure/x.png" }] };
const result = (keyword, country, extra = {}) => ({ keyword, country, phrase: keyword, rank: 3, volume: 10, difficulty: 20, opportunity: 8, competitors: {}, top: [A(1), A(2), A(3), A(4), A(5), A(6), A(7)], ...extra });

test("buildData: drops results for removed keywords and countries, keeps the top 5 IDs, stores apps once", () => {
  const results = { updatedAt: "2026-10-02T00:00:00Z", entries: { "a|us": result("a", "us"), "a|jp": result("a", "jp"), "gone|us": result("gone", "us") } };
  const data = buildData(mine, [{ keyword: "a", status: "tracked", local: {} }], results, []);
  assert.deepEqual(Object.keys(data.entries), ["a|us"]);
  assert.deepEqual(data.entries["a|us"].top, [1, 2, 3, 4, 5]);
  assert.equal(Object.keys(data.apps).length, 7, "each of the seven apps is stored once, even though only five are shown per check");
  assert.equal(data.updatedAt, "2026-10-02T00:00:00Z");
});

test("buildData: no results.entries, no keywords, no history still builds", () => {
  const data = buildData({ ...mine, competitors: undefined }, [], {}, []);
  assert.deepEqual(data.entries, {});
  assert.deepEqual(data.app.competitors, []);
  assert.deepEqual(data.history, { dates: [], ranks: {} });
  assert.equal(data.updatedAt, null);
});

test("buildData: icons that aren't https are dropped everywhere (own app, competitors, apps)", () => {
  const results = { entries: { "a|us": result("a", "us", { top: [{ ...A(2), icon: "data:image/svg+xml,<svg onload=x>" }] }) } };
  const data = buildData({ ...mine, icon: "http://x/y.png" }, [{ keyword: "a", status: "idea", local: {} }], results, []);
  assert.equal(data.app.icon, "");
  assert.equal(data.app.competitors[0].icon, "");
  assert.equal(data.apps[2].icon, "");
});

test("packHistory: ranks are numbers, 200+ is 0, not-checked is null; lined up with the dates", () => {
  const current = new Map([["a|us", true], ["b|us", true]]);
  const days = [
    { date: "2026-10-01", ranks: { "a|us": 5, "gone|us": 1 } },
    { date: "2026-10-02", ranks: { "a|us": null, "b|us": 2 } },
    { date: "2026-10-03", ranks: {} },
  ];
  assert.deepEqual(packHistory(days, current), { dates: ["2026-10-01", "2026-10-02", "2026-10-03"], ranks: { "a|us": [5, 0, null], "b|us": [null, 2, null] } });
});

test("packHistory: no days, or only keys that aren't current, gives empty ranks", () => {
  assert.deepEqual(packHistory([], new Map()), { dates: [], ranks: {} });
  assert.deepEqual(packHistory([{ date: "2026-10-01", ranks: { "x|us": 1 } }], new Map()), { dates: ["2026-10-01"], ranks: {} });
});

test("packHistory: history files of the wrong shape are skipped and the dates stay lined up", () => {
  const current = new Map([["a|us", true]]);
  const days = [null, { date: "2026-10-01", ranks: { "a|us": 4 } }, {}, { date: "2026-10-02" }, { ranks: { "a|us": 1 } }, { date: "2026-10-03", ranks: { "a|us": 2 } }];
  assert.deepEqual(packHistory(days, current), { dates: ["2026-10-01", "2026-10-03"], ranks: { "a|us": [4, 2] } });
});

// ---- renderPage ----

test("renderPage: the data survives a round trip even when app names try to break out of the script", () => {
  const evil = { name: '</script><script>alert(1)</script><!-- <img src=x onerror=alert(1)> -->', n: "  $1$`" };
  const html = renderPage('<script id="d" type="application/json">__SEARCHD_DATA__</script>/*FONT_400*//*FONT_600*/', evil, { 400: "A", 600: "B" });
  const body = html.slice(html.indexOf(">") + 1, html.indexOf("</script>"));
  assert.ok(!body.includes("<"), "no '<' inside the data script");
  assert.deepEqual(JSON.parse(body), evil);
  assert.equal(html.match(/<\/script>/g).length, 1, "only the template's own closing tag");
});

// ---- recordRelease (track.js) ----

const lookup = (extra = {}) => ({ version: "2.3", released: "2026-10-20T12:00:00Z", name: "Gridpeek", description: "F1 calendar", notes: "Race calendar", ...extra });
const noon = new Date("2026-10-25T12:00:00");

test("recordRelease: the first lookup starts the log, dated by Apple's release date", () => {
  const { log, added } = recordRelease(null, lookup(), noon);
  assert.equal(log.releases.length, 1);
  assert.deepEqual({ ...added, description: typeof added.description }, { version: "2.3", date: today(new Date("2026-10-20T12:00:00Z")), name: "Gridpeek", description: "string", notes: "Race calendar", changes: [] });
});

test("recordRelease: the same listing again adds nothing", () => {
  const first = recordRelease({ releases: [] }, lookup(), noon).log;
  const { log, added } = recordRelease(first, lookup({ notes: "edited notes don't count" }), noon);
  assert.equal(added, null);
  assert.equal(log.releases.length, 1);
});

test("recordRelease: a new version, name or description is a new entry that says what changed", () => {
  let { log } = recordRelease(null, lookup(), noon);
  let added;
  ({ log, added } = recordRelease(log, lookup({ version: "2.4", name: "Gridpeek: F1 Calendar" }), noon));
  assert.deepEqual(added.changes, ["version", "name"]);
  ({ log, added } = recordRelease(log, lookup({ version: "2.4", name: "Gridpeek: F1 Calendar", description: "new text" }), noon));
  assert.deepEqual(added.changes, ["description"]);
  assert.deepEqual(log.releases.map((r) => r.version), ["2.3", "2.4", "2.4"]);
});

test("recordRelease: no version (app not sold there, an old cache file) or a log of the wrong shape", () => {
  for (const current of [undefined, null, {}, lookup({ version: "" })]) assert.equal(recordRelease(null, current, noon).added, null);
  assert.equal(recordRelease({ releases: "junk" }, lookup(), noon).log.releases.length, 1, "a broken log starts over");
});

test("recordRelease: a missing or bad release date falls back to today; long notes are cut", () => {
  const { added } = recordRelease(null, lookup({ released: "not a date", notes: "x".repeat(900) }), noon);
  assert.equal(added.date, "2026-10-25");
  assert.equal(added.notes.length, 500);
});

// ---- releaseImpact (dashboard.js) ----

const packed = (dates, ranks) => ({ dates, ranks });

test("releaseImpact: average rank the week before vs the week after, leaving out the release day", () => {
  const dates = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"];
  const history = packed(dates, { "a|us": [20, 10, 99, 4, 6], "b|us": [0, 0, 1, 0, 50] });
  const [r] = releaseImpact(history, [{ version: "2.4", date: "2026-10-03", changes: ["version"], notes: "n" }]);
  assert.deepEqual(r.impact["a|us"], [15, 5]);
  assert.deepEqual(r.impact["b|us"], [201, 125.5], "200+ counts as 201");
  assert.deepEqual([r.version, r.date, r.notes, r.changes], ["2.4", "2026-10-03", "n", ["version"]]);
});

test("releaseImpact: only up to 7 tracked days on each side, and unchecked days (null) are skipped", () => {
  const dates = Array.from({ length: 20 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
  // 9 days at #100 then 1 at #1 before the release on the 10th... only the last 7 before count.
  const ranks = [100, 100, 100, 100, 100, 100, 100, 100, 1, 50, 2, null, 2, 2, 2, 2, 2, 2, 90, 90];
  const [r] = releaseImpact(packed(dates, { "k|us": ranks }), [{ version: "3", date: "2026-10-10" }]);
  assert.deepEqual(r.impact["k|us"], [Math.round(((100 * 6 + 1) / 7) * 10) / 10, Math.round(((2 * 7) / 7) * 10) / 10]);
});

test("releaseImpact: no history on one side means no number; junk releases are dropped", () => {
  const history = packed(["2026-10-01", "2026-10-02"], { "a|us": [5, 5] });
  const [r] = releaseImpact(history, [{ version: "1", date: "2026-10-02" }, { version: 2, date: "2026-10-01" }, { version: "x", date: "yesterday" }, null]);
  assert.deepEqual(r.impact, {});
  assert.deepEqual(releaseImpact(history, undefined), []);
  assert.deepEqual(releaseImpact(history, [{ version: "1", date: "2026-10-01", changes: ["<b>", "name"], notes: 5 }])[0], { version: "1", date: "2026-10-01", notes: "", changes: ["name"], impact: {} });
});

test("buildData: releases go through releaseImpact", () => {
  const data = buildData(mine, [], {}, [], [{ version: "1.0", date: "2026-10-01" }]);
  assert.deepEqual(data.releases, [{ version: "1.0", date: "2026-10-01", notes: "", changes: [], impact: {} }]);
  assert.deepEqual(buildData(mine, [], {}, []).releases, []);
});

// ---- competitor watch (track.js) and competitor changes (dashboard.js) ----

test("recordRelease: a rename keeps the old name", () => {
  const { log } = recordRelease(null, lookup(), noon);
  const { added } = recordRelease(log, lookup({ name: "Gridpeek: F1 Calendar" }), noon);
  assert.equal(added.previousName, "Gridpeek");
  assert.equal(recordRelease(log, lookup({ version: "9" }), noon).added.previousName, undefined, "only on a rename");
});

test("watchCompetitors: the first sighting is silent, later changes print one line each", () => {
  const rivals = [{ id: 7, name: "F1 TV" }, { id: 8, name: "Race Pal" }];
  const day1 = new Map([[7, lookup({ name: "F1 TV" })], [8, lookup({ name: "Race Pal", version: "1.0" })]]);
  let { watch, lines } = watchCompetitors({}, rivals, day1, noon);
  assert.deepEqual(lines, []);
  assert.deepEqual(Object.keys(watch), ["7", "8"]);

  const day2 = new Map([[7, lookup({ name: "F1 TV: Live Timing", version: "2.4" })], [8, lookup({ name: "Race Pal", version: "1.0", description: "new" })]]);
  ({ watch, lines } = watchCompetitors(watch, rivals, day2, noon));
  const when = today(new Date("2026-10-20T12:00:00Z"));
  assert.deepEqual(lines, [`F1 TV: Live Timing (${when}): renamed from "F1 TV" to "F1 TV: Live Timing", version 2.4`, `Race Pal (${when}): new description`]);
  assert.equal(watch[7].releases.length, 2);
});

test("watchCompetitors: a competitor missing from the lookup or removed from setup", () => {
  const { watch, lines } = watchCompetitors({ 9: { releases: [{ version: "1" }] } }, [{ id: 7, name: "F1 TV" }], new Map(), noon);
  assert.deepEqual(lines, []);
  assert.deepEqual(watch, { 7: { releases: [] } }, "a removed competitor's log is dropped; an unfound one stays empty");
  assert.deepEqual(watchCompetitors(null, undefined, new Map(), noon), { watch: {}, lines: [] });
});

test("competitorChanges: real changes only, oldest first, with your rank impact and the app's ID", () => {
  const history = packed(["2026-10-01", "2026-10-03"], { "a|us": [5, 9] });
  const log = {
    7: { releases: [{ version: "1", date: "2026-10-01", changes: [] }, { version: "2", date: "2026-10-02", changes: ["version", "name"], name: "New", previousName: "Old" }] },
    8: { releases: [{ version: "5", date: "2026-09-30", changes: [] }, { version: "5", date: "2026-09-30", changes: ["description"] }] },
    99: { releases: [{ version: "1", date: "2026-10-02", changes: ["name"] }] },
  };
  const list = competitorChanges(history, [{ id: 7 }, { id: 8 }], log);
  assert.deepEqual(list.map((r) => [r.app, r.date]), [[8, "2026-09-30"], [7, "2026-10-02"]], "app 99 isn't a competitor anymore");
  assert.deepEqual(list[1].impact, { "a|us": [5, 9] });
  assert.deepEqual([list[1].previousName, list[1].name], ["Old", "New"]);
  assert.deepEqual(competitorChanges(history, undefined, undefined), []);
  assert.deepEqual(buildData(mine, [], {}, [], [], { 9: log[7] }).competitorChanges.map((r) => r.app), [9], "buildData passes setup's competitors");
});
