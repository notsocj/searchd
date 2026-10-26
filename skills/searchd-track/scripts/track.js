#!/usr/bin/env node
// track.js — re-checks every TRACKED keyword in every country, adds today's ranks to the
// history, and prints what moved since the last earlier day in the history. It also looks up
// your app and your competitors (one call) and notes every new version, name or description:
// yours in .searchd/releases.json, theirs in .searchd/competitor-releases.json. The dashboard
// marks both on the rank charts, so you can see which change moved which keyword.
//
//   node track.js [--countries "us,de"]
//
// Run it once a day (or after you change your listing) to see whether the change worked.
// Running it twice on the same day is free: searches are cached for the day.

import { parseArgs } from "node:util";
import { readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadShared } from "./shared.js";

const { readJson, writeJson, requireApp, today, path, entryKey, flag, isMain, printable } = await loadShared("lib/store.js");
const { createClient } = await loadShared("lib/itunes.js");
const { loadKeywords, planChecks, runChecks, pickCountries } = await loadShared("lib/checks.js");

// "200+" is treated as rank 201, so falling out of the results counts as a drop.
const asNumber = (rank) => rank ?? 201;
const show = (rank) => (rank ? `#${rank}` : "200+");

/** Compare two history snapshots. Returns { up, down }: one printable line per keyword that moved. */
export function movement(before, after) {
  const lines = { up: [], down: [] };
  // "?? {}": a history file of the wrong shape ("{}", a hand edit) means "nothing to compare".
  const was = before?.ranks ?? {};
  for (const [key, rank] of Object.entries(after?.ranks ?? {})) {
    if (!(key in was)) continue; // first time we checked it: nothing to compare
    const old = was[key];
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

// Release notes are only shown as a one-line hint in the dashboard; no need to keep a novel.
const MAX_NOTES = 500;

/**
 * Add the app's current listing to the release log when it differs from the last one recorded.
 * `current` is a lookup result ({ version, released, name, description, notes }); `log` is
 * releases.json ({ releases: [...] }, oldest first). Returns { log, added } (added = the new
 * entry, or null). Pure, so it's easy to test.
 *
 * A release is dated by Apple's release date for that version (in your local time zone), not
 * the day we noticed it: if you skip tracking for a week, the marker still lands on the right day.
 * The description is stored as a short fingerprint: we only need to know THAT it changed.
 */
export function recordRelease(log, current, now = new Date()) {
  const releases = Array.isArray(log?.releases) ? log.releases : []; // wrong shape (hand edit): start over
  if (typeof current?.version !== "string" || !current.version) return { log: { releases }, added: null };
  const listing = {
    version: current.version,
    name: String(current.name ?? ""),
    description: createHash("sha1").update(String(current.description ?? "")).digest("hex").slice(0, 12),
  };
  const last = releases.at(-1);
  // What changed since the last entry. The very first entry is the starting point: nothing "changed".
  const changes = last ? Object.keys(listing).filter((field) => last[field] !== listing[field]) : [];
  if (last && !changes.length) return { log: { releases }, added: null };
  const released = new Date(current.released);
  const added = {
    ...listing,
    date: today(Number.isNaN(released.getTime()) ? now : released),
    notes: String(current.notes ?? "").slice(0, MAX_NOTES),
    changes,
    // A rename is the change people care about most: keep the old name to show "renamed from …".
    ...(changes.includes("name") ? { previousName: last.name } : {}),
  };
  return { log: { releases: [...releases, added] }, added };
}

/**
 * The same release log, kept per competitor: `watch` is competitor-releases.json
 * ({ "<app id>": { releases: [...] } }), `found` maps app id → today's lookup result.
 * Returns { watch, lines }: the updated logs (only for competitors still in setup) and one
 * printable line per competitor whose listing changed. The first lookup of a competitor is just
 * its starting point, so it prints nothing.
 */
export function watchCompetitors(watch, competitors, found, now = new Date()) {
  const next = {};
  const lines = [];
  for (const c of competitors ?? []) {
    const { log, added } = recordRelease(watch?.[c.id], found.get(c.id), now);
    next[c.id] = log;
    if (!added?.changes.length) continue;
    const what = [
      added.changes.includes("name") ? `renamed from "${printable(added.previousName)}" to "${printable(added.name)}"` : null,
      added.changes.includes("version") ? `version ${printable(added.version)}` : null,
      added.changes.includes("description") ? "new description" : null,
    ].filter(Boolean);
    lines.push(`${printable(added.name || c.name)} (${added.date}): ${what.join(", ")}`);
  }
  return { watch: next, lines };
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
  const client = createClient();
  const { done, failed, stopped, locked } = await runChecks({ client, app, todo });
  if (locked) process.exit(1);
  if (stopped) process.exit(1); // runChecks already said why; don't report movement on half a run
  console.log(`Done: ${done} checked${failed ? `, ${failed} failed (run again to retry them)` : ""}.`);

  // One lookup in your main country (cached for the day), for your app and every competitor at
  // once, tells us who shipped something new.
  try {
    const competitors = app.competitors ?? [];
    const found = new Map((await client.lookup([app.id, ...competitors.map((c) => c.id)], app.countries[0])).map((a) => [a.id, a]));
    const { log, added } = recordRelease(readJson("releases.json"), found.get(app.id));
    if (added) {
      writeJson("releases.json", log);
      const what = added.changes.filter((c) => c !== "version");
      console.log(log.releases.length === 1
        ? `\nRelease log started at version ${printable(added.version)} (released ${added.date}).`
        : `\nNew release: version ${printable(added.version)} (released ${added.date})${what.length ? `, ${what.join(" and ")} changed` : ""}. The dashboard marks it on the History charts.`);
    }
    if (competitors.length) {
      const { watch, lines } = watchCompetitors(readJson("competitor-releases.json"), competitors, found);
      writeJson("competitor-releases.json", watch);
      if (lines.length) console.log(`\nCompetitor listing changes:\n${lines.map((l) => `  ${l}`).join("\n")}`);
    }
  } catch (error) {
    // Ranks are already saved; a missed release check just waits for tomorrow's run.
    console.log(`\nCouldn't check for new releases (${error.message}).`);
  }

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
