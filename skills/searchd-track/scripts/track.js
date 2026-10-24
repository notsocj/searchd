#!/usr/bin/env node
// track.js — re-checks every TRACKED keyword in every country, adds today's ranks to the
// history, and prints what moved since the last earlier day in the history.
//
//   node track.js [--countries "us,de"]
//
// Run it once a day (or after you change your listing) to see whether the change worked.
// Running it twice on the same day is free: searches are cached for the day.

import { parseArgs } from "node:util";
import { readdirSync, existsSync } from "node:fs";
import { loadShared } from "./shared.js";

const { readJson, requireApp, today, path, entryKey, flag, isMain } = await loadShared("lib/store.js");
const { createClient } = await loadShared("lib/itunes.js");
const { loadKeywords, planChecks, runChecks, pickCountries } = await loadShared("lib/checks.js");

// "200+" is treated as rank 201, so falling out of the results counts as a drop.
const asNumber = (rank) => rank ?? 201;
const show = (rank) => (rank ? `#${rank}` : "200+");

/** Compare two history snapshots. Returns { up, down }: one printable line per keyword that moved. */
export function movement(before, after) {
  const lines = { up: [], down: [] };
  for (const [key, rank] of Object.entries(after.ranks)) {
    if (!(key in before.ranks)) continue; // first time we checked it: nothing to compare
    const old = before.ranks[key];
    const delta = asNumber(old) - asNumber(rank); // positive = moved up (smaller number)
    if (delta === 0) continue;
    // Split at the LAST "|": country codes never contain one, so this is always right.
    const cut = key.lastIndexOf("|");
    const keyword = key.slice(0, cut);
    const country = key.slice(cut + 1);
    const line = `${flag(country)} ${keyword}: ${show(old)} → ${show(rank)} (${delta > 0 ? "▲" : "▼"}${Math.abs(delta)})`;
    (delta > 0 ? lines.up : lines.down).push(line);
  }
  return lines;
}

/** The newest history day before today, or null on the first run. */
function previousDay() {
  const dir = path("history");
  if (!existsSync(dir)) return null;
  const days = readdirSync(dir).filter((f) => f.endsWith(".json") && f < `${today()}.json`).sort();
  return days.length ? readJson(`history/${days.at(-1)}`) : null;
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { countries: { type: "string" } } });
  const app = requireApp();
  const countries = pickCountries(app, values.countries);
  const tracked = loadKeywords().filter((k) => k.status === "tracked");
  if (!tracked.length) {
    console.log("No tracked keywords yet. Run /searchd-find first, then pick the keywords to track.");
    process.exit(0);
  }

  const { todo, missing } = planChecks(tracked, countries);
  if (missing.length) console.log(`Skipped (no local phrase yet, run /searchd-find to translate): ${missing.join(", ")}`);
  const { done, failed, stopped, locked } = await runChecks({ client: createClient(), app, todo });
  if (locked) process.exit(1);
  if (stopped) process.exit(1); // runChecks already said why; don't report movement on half a run
  console.log(`Done: ${done} checked${failed ? `, ${failed} failed (run again to retry them)` : ""}.`);

  const before = previousDay();
  const after = readJson(`history/${today()}.json`, { ranks: {} });
  if (!before) {
    console.log("First day of history: tomorrow's run will show what moved.");
  } else {
    const { up, down } = movement(before, after);
    console.log(`\nSince ${before.date}: ${up.length} up, ${down.length} down.`);
    for (const line of [...up, ...down]) console.log(line);
  }
  // Best ranks right now, so the agent can mention wins.
  const { entries } = readJson("results.json", { entries: {} });
  // Counts plus a few examples: an app that's #1 everywhere would otherwise print dozens of medals.
  const top3 = todo.map((c) => entries[entryKey(c.keyword, c.country)]).filter((e) => e?.rank && e.rank <= 3);
  if (top3.length) {
    const counts = [1, 2, 3].map((r) => [r, top3.filter((e) => e.rank === r).length]).filter(([, n]) => n);
    const examples = top3.slice(0, 5).map((e) => `${["🥇", "🥈", "🥉"][e.rank - 1]} ${flag(e.country)} ${e.phrase}`);
    console.log(`\nTop 3 in ${top3.length} of ${todo.length} checks: ${counts.map(([r, n]) => `${["🥇", "🥈", "🥉"][r - 1]} ${n}`).join(" · ")}`);
    console.log(`  e.g. ${examples.join(" · ")}${top3.length > 5 ? " …" : ""}`);
  }
}
