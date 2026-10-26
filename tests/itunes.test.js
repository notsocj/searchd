// Tests for the iTunes client: retries, the error format, and the daily cache.
// fetch is faked, so these never touch the network.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, pruneCache } from "../skills/searchd-find/scripts/lib/itunes.js";
import { today } from "../skills/searchd-find/scripts/lib/store.js";

beforeEach(() => {
  process.env.SEARCHD_DIR = mkdtempSync(join(tmpdir(), "searchd-test-"));
});

const json = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
const fast = (fetchImpl) => createClient({ fetchImpl, throttleMs: 0, sleep: async () => {} });

test("search trims fields and keeps descriptions only for the top 50", async () => {
  const results = Array.from({ length: 60 }, (_, i) => ({ trackId: i, trackName: `App ${i}`, description: "d", userRatingCount: i, screenshotUrls: ["x"] }));
  const client = fast(async () => json({ results }));
  const apps = await client.search("notes", "us");
  assert.equal(apps.length, 60);
  assert.deepEqual(Object.keys(apps[0]).sort(), ["description", "icon", "id", "name", "rating", "ratings", "seller"]);
  assert.equal(apps[55].description, undefined);
});

test("retries on 403 (Apple's rate-limit answer), then succeeds", async () => {
  const answers = [json({}, 403), json({}, 503), json({ results: [{ trackId: 1, trackName: "A" }] })];
  const client = fast(async () => answers.shift());
  const apps = await client.search("notes", "us");
  assert.equal(apps[0].id, 1);
  assert.equal(client.calls, 3);
});

test("gives up after the retries with a short error (no URL)", async () => {
  const client = fast(async () => json({}, 429));
  await assert.rejects(client.search("notes", "us"), { message: "iTunes API: HTTP 429" });
  assert.equal(client.calls, 4); // first try + 3 retries
});

test("doesn't retry a 400", async () => {
  const client = fast(async () => json({}, 400));
  await assert.rejects(client.search("notes", "us"), { message: "iTunes API: HTTP 400" });
  assert.equal(client.calls, 1);
});

test("the same search on the same day comes from the cache", async () => {
  let calls = 0;
  const fetchImpl = async () => (calls++, json({ results: [{ trackId: 1, trackName: "A" }] }));
  const client = fast(fetchImpl);
  assert.ok(!client.isCached("search", "notes", "us"));
  await client.search("notes", "us");
  assert.ok(client.isCached("search", "notes", "us"));
  await fast(fetchImpl).search("notes", "us"); // a new client (a later run) reads the cache too
  assert.equal(calls, 1);
  await client.search("notes", "de"); // another country is another search
  assert.equal(calls, 2);
});

test("lookup sends several IDs in one call", async () => {
  let url;
  const client = fast(async (u) => ((url = u), json({ results: [{ trackId: 1 }, { trackId: 2 }] })));
  const apps = await client.lookup([1, 2], "us");
  assert.equal(apps.length, 2);
  assert.match(url, /id=1%2C2/);
});

test("a 403 makes the throttle 1.5× slower for the rest of the run", async () => {
  const answers = [json({}, 403), json({ results: [] })];
  const client = createClient({ fetchImpl: async () => answers.shift(), throttleMs: 1000, sleep: async () => {} });
  await client.search("notes", "us");
  assert.equal(client.throttleMs, 1500);
});

test("network errors (offline) get one retry, not three", async () => {
  const client = fast(async () => {
    throw new Error("ENOTFOUND");
  });
  await assert.rejects(client.search("notes", "us"), { message: "iTunes API: network error" });
  assert.equal(client.calls, 2);
});

test("a damaged cache file is fetched again instead of crashing", async () => {
  const client = fast(async () => json({ results: [{ trackId: 1, trackName: "A" }] }));
  await client.search("notes", "us");
  const dir = join(process.env.SEARCHD_DIR, "cache");
  const day = readdirSync(dir)[0];
  const file = join(dir, day, "us", readdirSync(join(dir, day, "us"))[0]);
  writeFileSync(file, "{broken");
  assert.equal((await client.search("notes", "us"))[0].id, 1);
});

test("after a slow-down, 20 clean calls in a row speed the throttle back up (never below the start)", async () => {
  const answers = [json({}, 403), ...Array.from({ length: 60 }, () => json({ results: [] }))];
  const client = createClient({ fetchImpl: async () => answers.shift(), throttleMs: 1000, sleep: async () => {} });
  await client.search("t0", "us"); // 403, then success: gap 1500
  assert.equal(client.throttleMs, 1500);
  assert.equal(client.slowdowns, 1);
  for (let i = 1; i <= 19; i++) await client.search(`t${i}`, "us"); // 20 clean calls
  assert.equal(client.throttleMs, 1200);
  for (let i = 20; i <= 39; i++) await client.search(`t${i}`, "us");
  assert.equal(client.throttleMs, 1000, "back to the start gap, not below");
});

// ---- Edge cases (hardening) ----

/** A client that records every wait, with distinctive retry delays so they can't be confused with throttle waits. */
function recording(fetchImpl, options = {}) {
  const waits = [];
  const client = createClient({ fetchImpl, throttleMs: 0, retryDelays: [111, 222, 333], sleep: async (ms) => void waits.push(ms), ...options });
  return { client, waits };
}

test("backoff waits the 1st, 2nd and 3rd retry delay, in order", async () => {
  const answers = [json({}, 500), json({}, 502), json({}, 503), json({ results: [] })];
  const { client, waits } = recording(async () => answers.shift());
  await client.search("notes", "us");
  assert.deepEqual(waits, [111, 222, 333]);
  assert.equal(client.calls, 4);
});

test("5xx errors are retried and the final error names the last status", async () => {
  const { client } = recording(async () => json({}, 503));
  await assert.rejects(client.search("notes", "us"), { message: "iTunes API: HTTP 503" });
  assert.equal(client.calls, 4);
  assert.equal(client.slowdowns, 0, "a 5xx is not a slow-down request");
});

test("other 4xx errors (400, 404) fail at once with the exact error text", async () => {
  for (const status of [400, 401, 404]) {
    const { client, waits } = recording(async () => json({}, status));
    await assert.rejects(client.search("notes", "us"), { message: `iTunes API: HTTP ${status}` });
    assert.equal(client.calls, 1);
    assert.deepEqual(waits, []);
  }
});

test("a network error waits only the first retry delay, once", async () => {
  const { client, waits } = recording(async () => {
    throw new Error("ENOTFOUND");
  });
  await assert.rejects(client.search("notes", "us"), { message: "iTunes API: network error" });
  assert.deepEqual(waits, [111]);
});

test("a network error followed by success works, and doesn't count as a slow-down", async () => {
  const answers = [() => Promise.reject(new Error("ECONNRESET")), () => json({ results: [{ trackId: 1 }] })];
  const { client } = recording(async () => answers.shift()());
  assert.equal((await client.search("notes", "us"))[0].id, 1);
  assert.equal(client.slowdowns, 0);
});

test("a 200 whose body isn't JSON is treated like a network error (one retry)", async () => {
  const { client } = recording(async () => ({ ok: true, status: 200, json: async () => Promise.reject(new SyntaxError("bad json")) }));
  await assert.rejects(client.search("notes", "us"), { message: "iTunes API: network error" });
  assert.equal(client.calls, 2);
});

test("error text never contains the URL or the search term", async () => {
  const { client } = recording(async () => json({}, 429));
  await assert.rejects(client.search("secret term", "us"), { message: "iTunes API: HTTP 429" }); // exact text: no term, no URL
});

test("each 403/429 grows the throttle 1.5×, capped at 10 s", async () => {
  const answers = [json({}, 429), json({}, 403), json({}, 429), json({ results: [] })];
  const client = createClient({ fetchImpl: async () => answers.shift(), throttleMs: 1000, sleep: async () => {} });
  await client.search("notes", "us");
  assert.equal(client.throttleMs, 3375); // 1000 → 1500 → 2250 → 3375
  assert.equal(client.slowdowns, 3);
  const stuck = createClient({ fetchImpl: async () => json({}, 403), throttleMs: 9000, sleep: async () => {} });
  await assert.rejects(stuck.search("another term", "us")); // not "notes": that one is cached by now
  assert.equal(stuck.throttleMs, 10_000, "never slower than 10 s");
});

test("a 5xx or 400 does not slow the throttle down", async () => {
  const answers = [json({}, 500), json({ results: [] })];
  const client = createClient({ fetchImpl: async () => answers.shift(), throttleMs: 1000, sleep: async () => {} });
  await client.search("notes", "us");
  assert.equal(client.throttleMs, 1000);
});

test("the throttle waits out the rest of the gap between two network calls", async () => {
  const waits = [];
  const client = createClient({ fetchImpl: async () => json({ results: [] }), throttleMs: 5000, sleep: async (ms) => void waits.push(ms) });
  await client.search("a", "us");
  await client.search("b", "us");
  assert.equal(waits.length, 1, "the first call doesn't wait");
  assert.ok(waits[0] > 4000 && waits[0] <= 5000, `waited ${waits[0]} ms`);
});

test("cache hits don't wait, don't count as calls, and don't touch the throttle", async () => {
  const waits = [];
  const client = createClient({ fetchImpl: async () => json({ results: [{ trackId: 1 }] }), throttleMs: 5000, sleep: async (ms) => void waits.push(ms) });
  await client.search("a", "us");
  await client.search("a", "us");
  await client.search("a", "us");
  assert.equal(client.calls, 1);
  assert.deepEqual(waits, []);
});

test("failed searches are not cached", async () => {
  const { client } = recording(async () => json({}, 500));
  await assert.rejects(client.search("notes", "us"));
  assert.ok(!client.isCached("search", "notes", "us"));
  assert.ok(!existsSync(join(process.env.SEARCHD_DIR, "cache")));
});

test("search and lookup with the same text are cached separately", async () => {
  let calls = 0;
  const client = fast(async () => (calls++, json({ results: [{ trackId: 1 }] })));
  await client.search("1", "us");
  await client.lookup(1, "us");
  assert.equal(calls, 2);
});

test("cache files are named by hash, so odd terms (slashes, dots, emoji, Japanese) are safe", async () => {
  const client = fast(async () => json({ results: [] }));
  for (const term of ["../../etc/passwd", "a/b", "🍅", "カロリー計算", "x".repeat(5000)]) await client.search(term, "us");
  const dir = join(process.env.SEARCHD_DIR, "cache", today(), "us");
  const files = readdirSync(dir);
  assert.equal(files.length, 5);
  assert.ok(files.every((f) => /^[0-9a-f]{16}\.json$/.test(f)));
  assert.deepEqual(readdirSync(process.env.SEARCHD_DIR), ["cache"], "nothing escaped the cache folder");
});

test("a cache file that is valid JSON but has the wrong shape is fetched again", async () => {
  const client = fast(async () => json({ results: [{ trackId: 1, trackName: "A" }] }));
  await client.search("notes", "us");
  const dir = join(process.env.SEARCHD_DIR, "cache", today(), "us");
  const file = join(dir, readdirSync(dir)[0]);
  for (const wrong of ["{}", "null", '{"results":"oops"}', "[]"]) {
    writeFileSync(file, wrong);
    const apps = await client.search("notes", "us");
    assert.ok(Array.isArray(apps), `shape ${wrong}`);
    assert.equal(apps[0].id, 1);
  }
});

test("search sends the term, country, entity and limit; odd characters are encoded", async () => {
  let url;
  const client = fast(async (u) => ((url = new URL(u)), json({ results: [] })));
  await client.search("rock & roll ü", "de");
  assert.equal(url.origin + url.pathname, "https://itunes.apple.com/search");
  assert.equal(url.searchParams.get("term"), "rock & roll ü");
  assert.equal(url.searchParams.get("country"), "de");
  assert.equal(url.searchParams.get("entity"), "software");
  assert.equal(url.searchParams.get("limit"), "200");
});

test("a response without a results list gives an empty list", async () => {
  const client = fast(async () => json({}));
  assert.deepEqual(await client.search("notes", "us"), []);
  assert.deepEqual(await client.lookup(5, "us"), []);
});

test("lookup drops entries without an ID and keeps descriptions", async () => {
  const client = fast(async () => json({ results: [{ resultCount: 1 }, { trackId: 3, trackName: "C", description: "d" }] }));
  const apps = await client.lookup("3", "us");
  assert.equal(apps.length, 1);
  assert.equal(apps[0].description, "d");
  assert.deepEqual([apps[0].version, apps[0].released, apps[0].notes], ["", "", ""], "missing version fields are empty strings");
});

test("lookup keeps the current version, its release date and its notes", async () => {
  const client = fast(async () => json({ results: [{ trackId: 3, trackName: "C", version: "2.3", currentVersionReleaseDate: "2026-10-20T07:00:00Z", releaseNotes: "Race calendar" }] }));
  const [app] = await client.lookup(3, "us");
  assert.deepEqual([app.version, app.released, app.notes], ["2.3", "2026-10-20T07:00:00Z", "Race calendar"]);
});

test("pruneCache deletes other days' folders and keeps today's; no cache folder is fine", async () => {
  pruneCache(); // nothing there yet: must not throw
  const client = fast(async () => json({ results: [] }));
  await client.search("notes", "us");
  const cache = join(process.env.SEARCHD_DIR, "cache");
  mkdirSync(join(cache, "2000-01-01", "us"), { recursive: true });
  writeFileSync(join(process.env.SEARCHD_DIR, "results.json"), "{}");
  pruneCache();
  assert.deepEqual(readdirSync(cache), [today()]);
  assert.ok(existsSync(join(process.env.SEARCHD_DIR, "results.json")), "only the cache folder is touched");
  assert.ok(client.isCached("search", "notes", "us"));
});
