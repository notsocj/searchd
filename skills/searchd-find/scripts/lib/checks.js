// checks.js — runs the keyword × country checks and saves the results.
//
// One "check" = one App Store search for one keyword's local phrase in one country. From that
// single search we get everything: your rank, the volume and difficulty estimates, the top apps,
// and your competitors' ranks. /searchd-find and /searchd-track both use this file.

import { readJson, writeJson, today, entryKey, flag, acquireLock } from "./store.js";
import { rankOf, volumeScore, difficultyScore, opportunityScore } from "./score.js";
import { pruneCache } from "./itunes.js";

/**
 * Read a --countries flag ("us,de"). Every code must be one of the app's countries, so a typo
 * can't silently check nothing. No flag = all the app's countries.
 */
export function pickCountries(app, flag) {
  if (!flag) return app.countries;
  const countries = flag.split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
  const unknown = countries.filter((c) => !app.countries.includes(c));
  if (unknown.length || !countries.length) {
    console.error(`searchd: --countries must be from your countries (${app.countries.join(", ")}); got "${flag}". Add countries with /searchd-setup.`);
    process.exit(1);
  }
  return countries;
}

/** The keywords.json list (always an array). */
export const loadKeywords = () => readJson("keywords.json", []);

/**
 * Build the list of checks to run: every keyword × every country that has a local phrase.
 * Keywords without a local phrase for a country are reported, not guessed: the agent
 * translates them (see /searchd-find), and a wrong phrase would give misleading numbers.
 */
export function planChecks(keywords, countries) {
  const todo = [];
  const missing = [];
  for (const kw of keywords) {
    for (const country of countries) {
      const phrase = kw.local?.[country]?.trim();
      if (phrase) todo.push({ keyword: kw.keyword, country, phrase });
      else missing.push(`${kw.keyword} (${country})`);
    }
  }
  return { todo, missing };
}

/** Turn one search result list into the entry saved in results.json. */
export function buildEntry({ keyword, country, phrase }, results, app) {
  const volume = volumeScore(results, phrase);
  const difficulty = difficultyScore(results);
  // Competitors you added in setup: where do THEY rank for this phrase?
  const competitors = Object.fromEntries((app.competitors ?? []).map((c) => [c.id, rankOf(results, c.id)]));
  return {
    keyword,
    country,
    phrase,
    rank: rankOf(results, app.id),
    volume,
    difficulty,
    opportunity: opportunityScore(volume, difficulty),
    resultCount: results.length,
    // The top 10 (without descriptions): the dashboard shows 5; "losing to" counts all 10.
    top: results.slice(0, 10).map(({ id, name, icon, ratings, rating }) => ({ id, name, icon, ratings, rating })),
    competitors,
    checkedAt: new Date().toISOString(),
  };
}

// Stop the run after this many checks fail in a row: we're offline or Apple is blocking us,
// and every further check would just fail slowly too.
export const MAX_FAILS_IN_A_ROW = 3;

/**
 * Run the checks one by one, saving after each, so a stopped run keeps its progress.
 * Prints progress lines like "12/40 · 🇩🇪 kalorienzähler → #17".
 * Returns { done, failed, stopped, locked }.
 */
export async function runChecks({ client, app, todo, log = console.log }) {
  const release = acquireLock();
  if (!release) {
    log("Another searchd check is already running in this folder. Wait for it to finish, then run this again.");
    return { done: 0, failed: 0, stopped: false, locked: true };
  }
  try {
    return await checkAll({ client, app, todo, log });
  } finally {
    release();
  }
}

async function checkAll({ client, app, todo, log }) {
  pruneCache();
  // readJson only catches invalid JSON. A file that parses but has the wrong shape ("null", "{}",
  // a hand edit) would make every check below throw, so each one would count as a failed search.
  const results = readJson("results.json") ?? {};
  results.entries ??= {};
  const historyFile = `history/${today()}.json`;
  const history = readJson(historyFile) ?? {};
  history.date ??= today();
  history.ranks ??= {};

  // Time estimate: only searches that aren't cached yet cost a throttle wait.
  const uncached = todo.filter((c) => !client.isCached("search", c.phrase, c.country)).length;
  const minutes = Math.ceil((uncached * client.throttleMs) / 60_000);
  log(`${todo.length} checks (${uncached} new today${uncached ? `, about ${minutes} min` : ""}).`);

  let done = 0;
  let failed = 0;
  let failsInARow = 0;
  for (const [i, check] of todo.entries()) {
    const label = `${i + 1}/${todo.length} · ${flag(check.country)} ${check.phrase}`;
    try {
      const entry = buildEntry(check, await client.search(check.phrase, check.country), app);
      const key = entryKey(check.keyword, check.country);
      results.entries[key] = entry;
      history.ranks[key] = entry.rank;
      results.updatedAt = entry.checkedAt;
      writeJson("results.json", results);
      writeJson(historyFile, history);
      done++;
      failsInARow = 0;
      log(`${label} → ${entry.rank ? `#${entry.rank}` : "200+"} · vol ${entry.volume} · diff ${entry.difficulty}`);
    } catch (error) {
      // One failed search (after retries) shouldn't throw away the rest of the run.
      failed++;
      failsInARow++;
      log(`${label} → failed (${error.message})`);
      if (failsInARow >= MAX_FAILS_IN_A_ROW) {
        log(`Stopped: the last ${MAX_FAILS_IN_A_ROW} searches failed (offline, or Apple is rate-limiting this network). ${done} finished checks are saved; run again in a few minutes to continue.`);
        return { done, failed, stopped: true, locked: false };
      }
    }
  }
  // Tell the user why a run took longer than estimated.
  if (client.slowdowns) log(`Apple asked searchd to slow down ${client.slowdowns}× (normal on busy networks); searches ended ${(client.throttleMs / 1000).toFixed(1)} s apart.`);
  return { done, failed, stopped: false, locked: false };
}
