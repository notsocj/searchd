// Tests for the iTunes client: retries, the error format, and the daily cache.
// fetch is faked, so these never touch the network.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "../skills/searchd-find/scripts/lib/itunes.js";

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
