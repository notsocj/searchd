// Edge-case tests for lib/checks.js: planning, entries, the run loop, the lock, and what a run
// writes. The client is a fake (no network) and every test gets its own SEARCHD_DIR temp folder.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pickCountries, planChecks, buildEntry, runChecks, MAX_FAILS_IN_A_ROW,
} from "../skills/searchd-find/scripts/lib/checks.js";
import { readJson, writeJson, today } from "../skills/searchd-find/scripts/lib/store.js";

beforeEach(() => {
  process.env.SEARCHD_DIR = mkdtempSync(join(tmpdir(), "searchd-test-"));
});

const me = { id: 1, name: "Me", ratings: 5 };
const big = { id: 9, name: "Big", ratings: 1000 };
/** A fake client. `script` maps a phrase to an Error (fails) or a result list; anything else finds `me` at #1. */
const fakeClient = (script = {}, extra = {}) => ({
  throttleMs: 0,
  slowdowns: 0,
  isCached: () => false,
  async search(phrase) {
    const answer = script[phrase];
    if (answer instanceof Error) throw answer;
    return answer ?? [me];
  },
  ...extra,
});
const checkOf = (phrase, country = "us") => ({ keyword: phrase, country, phrase });
const run = (todo, { client = fakeClient(), app = { id: 1 } } = {}) => {
  const lines = [];
  return runChecks({ client, app, todo, log: (line) => lines.push(line) }).then((result) => ({ ...result, lines }));
};
const fail = new Error("iTunes API: HTTP 500");

// ---- planChecks / pickCountries ----

test("planChecks: blank, whitespace-only and missing phrases are reported, others are trimmed", () => {
  const keywords = [
    { keyword: "a", local: { us: "  a  ", de: "   ", fr: "" } },
    { keyword: "b" }, // no local at all
  ];
  const { todo, missing } = planChecks(keywords, ["us", "de", "fr"]);
  assert.deepEqual(todo, [{ keyword: "a", country: "us", phrase: "a" }]);
  assert.deepEqual(missing, ["a (de)", "a (fr)", "b (us)", "b (de)", "b (fr)"]);
});

test("planChecks: no keywords or no countries means nothing to do", () => {
  assert.deepEqual(planChecks([], ["us"]), { todo: [], missing: [] });
  assert.deepEqual(planChecks([{ keyword: "a", local: { us: "a" } }], []), { todo: [], missing: [] });
});

test("pickCountries: no flag means all the app's countries; codes are trimmed and lowercased", () => {
  const app = { countries: ["us", "de", "jp"] };
  assert.deepEqual(pickCountries(app, undefined), ["us", "de", "jp"]);
  assert.deepEqual(pickCountries(app, " US , de ,"), ["us", "de"]);
});

test("pickCountries: an unknown or empty list exits with a message instead of checking nothing", () => {
  const app = { countries: ["us"] };
  const realExit = process.exit;
  const realError = console.error;
  const messages = [];
  process.exit = (code) => {
    throw new Error(`exit ${code}`);
  };
  console.error = (message) => messages.push(message);
  try {
    assert.throws(() => pickCountries(app, "us,xx"), /exit 1/);
    assert.throws(() => pickCountries(app, " , "), /exit 1/);
  } finally {
    process.exit = realExit;
    console.error = realError;
  }
  assert.equal(messages.length, 2);
  assert.match(messages[0], /--countries must be from your countries \(us\); got "us,xx"/);
});

// ---- buildEntry ----

test("buildEntry: rank, competitors, top 10 without descriptions, and counts", () => {
  const results = Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, name: `App ${i}`, icon: "i", ratings: 10, rating: 4, description: "secret" }));
  results[3] = { ...results[3], id: 1 }; // me at #4
  const entry = buildEntry(checkOf("notes"), results, { id: 1, competitors: [{ id: 100 }, { id: 555 }] });
  assert.equal(entry.rank, 4);
  assert.deepEqual(entry.competitors, { 100: 1, 555: null });
  assert.equal(entry.top.length, 10);
  assert.ok(entry.top.every((app) => !("description" in app)));
  assert.equal(entry.resultCount, 12);
  assert.equal(entry.opportunity, Math.round((entry.volume * (100 - entry.difficulty)) / 100));
  assert.ok(!Number.isNaN(Date.parse(entry.checkedAt)));
});

test("buildEntry: no results and no competitors list still works", () => {
  const entry = buildEntry(checkOf("notes"), [], { id: 1 });
  assert.equal(entry.rank, null);
  assert.deepEqual(entry.competitors, {});
  assert.deepEqual(entry.top, []);
  assert.deepEqual([entry.volume, entry.difficulty, entry.opportunity, entry.resultCount], [0, 0, 0, 0]);
});

// ---- the run loop ----

test("runChecks: a run writes only results.json and today's history, and leaves no lock behind", async () => {
  const { done, lines } = await run([checkOf("a"), checkOf("b", "de")]);
  assert.equal(done, 2);
  assert.deepEqual(readdirSync(process.env.SEARCHD_DIR).sort(), ["history", "results.json"]);
  assert.deepEqual(readdirSync(join(process.env.SEARCHD_DIR, "history")), [`${today()}.json`]);
  assert.match(lines[0], /^2 checks \(2 new today, about 0 min\)\.$/);
  assert.match(lines[1], /^1\/2 · .* a → #1 · vol \d+ · diff \d+$/);
});

test("runChecks: the log says 200+ when the app isn't in the results", async () => {
  const { lines } = await run([checkOf("a")], { client: fakeClient({ a: [big] }) });
  assert.match(lines[1], /→ 200\+ · vol/);
  assert.equal(readJson("results.json").entries["a|us"].rank, null);
  assert.equal(readJson(`history/${today()}.json`).ranks["a|us"], null);
});

test("runChecks: the time estimate only counts searches that aren't cached", async () => {
  const client = fakeClient({}, { throttleMs: 3500, isCached: (kind, phrase) => phrase === "a" });
  const { lines } = await run([checkOf("a"), checkOf("b")], { client });
  assert.equal(lines[0], "2 checks (1 new today, about 1 min).");
  const allCached = await run([checkOf("a")], { client });
  assert.equal(allCached.lines[0], "1 checks (0 new today).");
});

test("runChecks: an empty todo list finishes cleanly", async () => {
  const result = await run([]);
  assert.deepEqual({ done: result.done, failed: result.failed, stopped: result.stopped, locked: result.locked }, { done: 0, failed: 0, stopped: false, locked: false });
});

test("runChecks: a failed search keeps that keyword's older result and the rest still run", async () => {
  const old = { keyword: "a", country: "us", phrase: "a", rank: 7, volume: 1, difficulty: 1, opportunity: 1, top: [], competitors: {}, checkedAt: "2026-01-01T00:00:00.000Z" };
  writeJson("results.json", { entries: { "a|us": old, "z|us": { ...old, keyword: "z" } } });
  const { done, failed, lines } = await run([checkOf("a"), checkOf("b")], { client: fakeClient({ a: fail }) });
  assert.deepEqual({ done, failed }, { done: 1, failed: 1 });
  const { entries } = readJson("results.json");
  assert.deepEqual(entries["a|us"], old, "the failed check didn't overwrite the old entry");
  assert.ok(entries["z|us"], "entries for keywords not in this run are kept");
  assert.equal(entries["b|us"].rank, 1);
  assert.ok(lines.some((line) => line.endsWith("failed (iTunes API: HTTP 500)")));
});

test("runChecks: stops after exactly MAX_FAILS_IN_A_ROW failures and keeps what finished", async () => {
  const script = { ok1: undefined, f1: fail, f2: fail, f3: fail, never: undefined };
  const todo = ["ok1", "f1", "f2", "f3", "never"].map((p) => checkOf(p));
  const { done, failed, stopped, lines } = await run(todo, { client: fakeClient(script) });
  assert.equal(MAX_FAILS_IN_A_ROW, 3);
  assert.deepEqual({ done, failed, stopped }, { done: 1, failed: 3, stopped: true });
  assert.ok(readJson("results.json").entries["ok1|us"], "finished work is saved");
  assert.ok(!readJson("results.json").entries["never|us"], "the check after the stop never ran");
  assert.match(lines.at(-1), /^Stopped: the last 3 searches failed .* 1 finished checks are saved/);
  assert.ok(!existsSync(join(process.env.SEARCHD_DIR, "run.lock")), "the lock is released after a stop");
});

test("runChecks: a success in between resets the failure count", async () => {
  const todo = ["f1", "f2", "ok", "f3", "f4", "ok2"].map((p) => checkOf(p));
  const script = { f1: fail, f2: fail, f3: fail, f4: fail };
  const { done, failed, stopped } = await run(todo, { client: fakeClient(script) });
  assert.deepEqual({ done, failed, stopped }, { done: 2, failed: 4, stopped: false });
});

test("runChecks: tells the user when Apple asked it to slow down", async () => {
  const { lines } = await run([checkOf("a")], { client: fakeClient({}, { slowdowns: 2, throttleMs: 5250 }) });
  assert.equal(lines.at(-1), "Apple asked searchd to slow down 2× (normal on busy networks); searches ended 5.3 s apart.");
  const quiet = await run([checkOf("a")]);
  assert.ok(!quiet.lines.some((line) => line.includes("slow down")));
});

test("runChecks: results.json or history that is valid JSON of the wrong shape doesn't crash the run", async () => {
  writeFileSync(join(process.env.SEARCHD_DIR, "results.json"), "null");
  mkdirSync(join(process.env.SEARCHD_DIR, "history"));
  writeFileSync(join(process.env.SEARCHD_DIR, "history", `${today()}.json`), "{}");
  const { done } = await run([checkOf("a")]);
  assert.equal(done, 1);
  assert.equal(readJson("results.json").entries["a|us"].rank, 1);
  const history = readJson(`history/${today()}.json`);
  assert.equal(history.date, today());
  assert.equal(history.ranks["a|us"], 1);
});

test("runChecks: an existing history for today is added to, not replaced", async () => {
  writeJson(`history/${today()}.json`, { date: today(), ranks: { "old|us": 3 } });
  await run([checkOf("a")]);
  assert.deepEqual(readJson(`history/${today()}.json`).ranks, { "old|us": 3, "a|us": 1 });
});

// ---- the lock ----

test("runChecks: a refused run leaves the other run's lock and data untouched", async () => {
  writeJson("run.lock", process.ppid); // a live process that isn't us
  writeJson("results.json", { entries: { keep: { rank: 1 } } });
  const client = fakeClient({}, { search: async () => assert.fail("must not search while locked") });
  const result = await run([checkOf("a")], { client });
  assert.equal(result.locked, true);
  assert.deepEqual([result.done, result.failed, result.stopped], [0, 0, false]);
  assert.match(result.lines[0], /^Another searchd check is already running/);
  assert.equal(readJson("run.lock"), process.ppid, "the lock still belongs to the other run");
  assert.deepEqual(readJson("results.json"), { entries: { keep: { rank: 1 } } });
});

test("runChecks: locks that name no live process are taken over (dead PID, garbage, empty, own PID)", async () => {
  for (const content of [String(2 ** 22 + 777), "not a pid", "", String(process.pid)]) {
    writeFileSync(join(process.env.SEARCHD_DIR, "run.lock"), content);
    const result = await run([checkOf("a")]);
    assert.equal(result.done, 1, `lock content ${JSON.stringify(content)}`);
    assert.ok(!existsSync(join(process.env.SEARCHD_DIR, "run.lock")), "released afterwards");
  }
});

test("runChecks: the lock is released even when the run throws", async () => {
  const client = fakeClient({}, { isCached: () => { throw new Error("boom"); } });
  await assert.rejects(run([checkOf("a")], { client }), /boom/);
  assert.ok(!existsSync(join(process.env.SEARCHD_DIR, "run.lock")));
  const again = await run([checkOf("a")]);
  assert.equal(again.done, 1, "the next run isn't blocked");
});

test("runChecks: creates the data folder if it doesn't exist yet", async () => {
  process.env.SEARCHD_DIR = join(process.env.SEARCHD_DIR, "not", "yet", "there");
  const { done } = await run([checkOf("a")]);
  assert.equal(done, 1);
});
