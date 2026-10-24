// checks.js — runs the keyword × country checks and saves the results.
//
// One "check" = one App Store search for one keyword's local phrase in one country. From that
// single search we get everything: your rank, the volume and difficulty estimates, the top apps,
// and your competitors' ranks. /searchd-find and /searchd-track both use this file.

import { readJson, writeJson, today, entryKey, flag } from "./store.js";
import { rankOf, volumeScore, difficultyScore, opportunityScore } from "./score.js";
import { pruneCache } from "./itunes.js";

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

/**
 * Run the checks one by one, saving after each, so a stopped run keeps its progress.
 * Prints progress lines like "12/40 · 🇩🇪 kalorienzähler → #17".
 * Returns { done, failed } counts.
 */
export async function runChecks({ client, app, todo, log = console.log }) {
  pruneCache();
  const results = readJson("results.json", { entries: {} });
  const historyFile = `history/${today()}.json`;
  const history = readJson(historyFile, { date: today(), ranks: {} });

  // Time estimate: only searches that aren't cached yet cost a throttle wait.
  const uncached = todo.filter((c) => !client.isCached("search", c.phrase, c.country)).length;
  const minutes = Math.ceil((uncached * client.throttleMs) / 60_000);
  log(`${todo.length} checks (${uncached} new today${uncached ? `, about ${minutes} min` : ""}).`);

  let done = 0;
  let failed = 0;
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
      log(`${label} → ${entry.rank ? `#${entry.rank}` : "200+"} · vol ${entry.volume} · diff ${entry.difficulty}`);
    } catch (error) {
      // One failed search (after retries) shouldn't throw away the rest of the run.
      failed++;
      log(`${label} → failed (${error.message})`);
    }
  }
  return { done, failed };
}
