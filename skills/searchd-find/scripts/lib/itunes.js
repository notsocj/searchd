// itunes.js — talks to Apple's free iTunes Search API (no key needed).
//
//   search: https://itunes.apple.com/search?term=<keyword>&country=<cc>&entity=software&limit=200
//   lookup: https://itunes.apple.com/lookup?id=<appId>&country=<cc>
//
// Three things make it polite and cheap:
//   1. A throttle: Apple allows roughly 20 calls a minute, so we wait ~3.5 s between calls.
//   2. Retries with backoff: when Apple says "slow down" (HTTP 403/429) or has a hiccup (5xx),
//      we wait longer each time (10 s, 30 s, 60 s) before trying again.
//   3. A cache keyed by (term, country, date): the same search is never repeated on the same
//      day. That also makes long runs resumable: re-run after a stop and finished checks are free.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { path, writeJson, today } from "./store.js";

const SEARCH_URL = "https://itunes.apple.com/search";
const LOOKUP_URL = "https://itunes.apple.com/lookup";

// We keep app descriptions only for the top 50 results: that's all the volume score reads,
// and descriptions are most of the response's size.
const KEEP_DESCRIPTIONS = 50;

/** Keep only the fields searchd uses, so cache files stay small. */
function trim(app, keepDescription) {
  return {
    id: app.trackId,
    name: app.trackName ?? "",
    icon: app.artworkUrl100 ?? "",
    ratings: app.userRatingCount ?? 0,
    rating: app.averageUserRating ?? 0,
    seller: app.sellerName ?? "",
    ...(keepDescription ? { description: app.description ?? "" } : {}),
  };
}

/** Cache file for one request: cache/<today>/<country>/<hash>.json. Hashing keeps any
 *  keyword (spaces, umlauts, Japanese…) safe to use as a file name. */
function cacheName(kind, key, country) {
  const hash = createHash("sha1").update(`${kind}:${key}`).digest("hex").slice(0, 16);
  return ["cache", today(), country, `${hash}.json`];
}

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Make a client. Options exist so tests can run instantly with a fake fetch:
 *   fetchImpl   - defaults to Node's built-in fetch
 *   throttleMs  - minimum gap between two network calls (default 3500)
 *   retryDelays - how long to wait before each retry (default 10 s, 30 s, 60 s)
 *   sleep       - how to wait (tests pass a no-op)
 */
export function createClient({
  fetchImpl = fetch,
  throttleMs = 3500,
  retryDelays = [10_000, 30_000, 60_000],
  sleep = sleepFor,
} = {}) {
  let lastCall = 0;
  let calls = 0; // network calls actually made (cache hits don't count)

  /** Wait until at least `throttleMs` has passed since the previous network call. */
  async function throttle() {
    const wait = lastCall + throttleMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
  }

  /** GET a URL as JSON, with throttle + retries. Errors never include the URL, just the status. */
  async function getJson(url) {
    for (let attempt = 0; ; attempt++) {
      await throttle();
      calls++;
      let status;
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
        if (res.ok) return await res.json();
        status = res.status;
      } catch {
        status = "network error"; // offline, DNS failure, timeout…
      }
      // 403 is what Apple actually sends when you go over the rate limit, so it's retryable here.
      const retryable = status === "network error" || status === 403 || status === 429 || status >= 500;
      if (!retryable || attempt >= retryDelays.length) {
        throw new Error(`iTunes API: ${typeof status === "number" ? `HTTP ${status}` : status}`);
      }
      await sleep(retryDelays[attempt]);
    }
  }

  /** Read a cached response for today, or fetch it and cache it. */
  async function cached(kind, key, country, fetcher) {
    const name = cacheName(kind, key, country);
    const file = path(...name);
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).results;
    const results = await fetcher();
    writeJson(name.join("/"), { kind, key, country, results });
    return results;
  }

  return {
    /** Search the App Store in one country. Returns up to 200 apps, in Apple's order. */
    search(term, country) {
      return cached("search", term, country, async () => {
        const url = `${SEARCH_URL}?${new URLSearchParams({ term, country, entity: "software", limit: "200" })}`;
        const data = await getJson(url);
        return (data.results ?? []).map((app, i) => trim(app, i < KEEP_DESCRIPTIONS));
      });
    },

    /**
     * Look up apps by numeric ID in one country. One call handles several IDs ("id=1,2,3").
     * Apps not sold in that country are simply missing from the returned list.
     */
    lookup(ids, country) {
      const id = [].concat(ids).join(",");
      return cached("lookup", id, country, async () => {
        const data = await getJson(`${LOOKUP_URL}?${new URLSearchParams({ id, country })}`);
        return (data.results ?? []).filter((r) => r.trackId).map((app) => trim(app, true));
      });
    },

    /** True if this search/lookup would hit the network (used for the time estimate). */
    isCached(kind, key, country) {
      return existsSync(path(...cacheName(kind, key, country)));
    },

    get calls() {
      return calls;
    },
    throttleMs,
  };
}

/** Delete cache folders from previous days (they're never read again). */
export function pruneCache() {
  const dir = path("cache");
  if (!existsSync(dir)) return;
  for (const day of readdirSync(dir)) {
    if (day !== today()) rmSync(path("cache", day), { recursive: true, force: true });
  }
}
