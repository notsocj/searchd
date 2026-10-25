// Edge-case tests for what track.js and dashboard.js compute from saved data: rank movement,
// "losing to", the packed dashboard data and history, and rendering the page.

import { test } from "node:test";
import assert from "node:assert/strict";
import { movement } from "../skills/searchd-track/scripts/track.js";
import { losingTo, buildData, packHistory, renderPage } from "../skills/searchd-dashboard/scripts/dashboard.js";

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
