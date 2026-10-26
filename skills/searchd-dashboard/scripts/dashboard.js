#!/usr/bin/env node
// dashboard.js — builds .searchd/dashboard.html and opens it in your browser.
//
//   node dashboard.js [--no-open]
//
// The dashboard is ONE self-contained HTML file: the page (dashboard-page.html), its fonts, and
// all your data are baked into it. That's why it opens straight from file:// with no server,
// and why you re-run this script to refresh it after new checks.

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { loadShared } from "./shared.js";

const { readJson, requireApp, path, isMain } = await loadShared("lib/store.js");
const { SWEET_SPOT } = await loadShared("lib/score.js");

const here = (file) => new URL(file, import.meta.url);

// Only show icons served over https (they come from Apple's CDN). Anything else is dropped.
const safeIcon = (url) => (typeof url === "string" && url.startsWith("https://") ? url : "");

/**
 * "Losing to": the apps that rank above you most often.
 * For every keyword × country, each top-10 app placed above you counts as one "beat".
 * If you're not ranked at all (200+), every top-10 app beat you there.
 */
export function losingTo(entries, myId, limit = 20) {
  const apps = new Map();
  for (const entry of Object.values(entries)) {
    entry.top.forEach((app, i) => {
      const position = i + 1;
      if (app.id === myId || (entry.rank && entry.rank < position)) return;
      const row = apps.get(app.id) ?? { id: app.id, name: app.name, icon: safeIcon(app.icon), ratings: app.ratings, beats: 0, positions: 0 };
      row.beats++;
      row.positions += position;
      apps.set(app.id, row);
    });
  }
  return [...apps.values()]
    .map(({ positions, ...row }) => ({ ...row, avgPosition: Math.round((positions / row.beats) * 10) / 10 }))
    .sort((a, b) => b.beats - a.beats || a.avgPosition - b.avgPosition)
    .slice(0, limit);
}

/**
 * Everything the page needs, kept small:
 * - Only results for keywords and countries you still have. A keyword you removed (or a country
 *   you dropped in setup) keeps old results in results.json; they shouldn't count anymore.
 * - Each app's name, icon and ratings are stored ONCE in `apps`, and each check's top 10 is just
 *   a list of IDs. The same big apps show up in almost every search, so repeating their details
 *   (icon URLs are ~190 characters) made a 1,200-check dashboard about 4.8 MB.
 */
export function buildData(app, keywords, results, history, releases = []) {
  const current = new Map(keywords.flatMap((k) => app.countries.map((c) => [`${k.keyword}|${c}`, true])));
  // Apps have a different name in each country's store. Going through your first (main) country
  // first means each app is named the way it is there, not e.g. by its Brazilian name.
  const order = (key) => app.countries.indexOf(key.slice(key.lastIndexOf("|") + 1));
  const kept = Object.entries(results.entries ?? {})
    .filter(([key]) => current.has(key))
    .sort(([a], [b]) => order(a) - order(b));
  const apps = {};
  const entries = {};
  for (const [key, e] of kept) {
    for (const t of e.top) apps[t.id] ??= { name: t.name, icon: safeIcon(t.icon), ratings: t.ratings };
    const { keyword, country, phrase, rank, volume, difficulty, opportunity, competitors } = e;
    entries[key] = { keyword, country, phrase, rank, volume, difficulty, opportunity, competitors, top: e.top.slice(0, 5).map((t) => t.id) };
  }
  const packedHistory = packHistory(history, current);
  return {
    app: { id: app.id, name: app.name, icon: safeIcon(app.icon), countries: app.countries, competitors: (app.competitors ?? []).map((c) => ({ ...c, icon: safeIcon(c.icon) })) },
    keywords: keywords.map(({ keyword, status, local }) => ({ keyword, status, local })),
    entries,
    apps,
    history: packedHistory,
    releases: releaseImpact(packedHistory, releases),
    losingTo: losingTo(Object.fromEntries(kept), app.id),
    sweetSpot: SWEET_SPOT,
    updatedAt: results.updatedAt ?? null,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Turn the daily files ({ date, ranks: { key: rank } }, which repeat every keyword name every day)
 * into one array per keyword, lined up with `dates`. In each array: a number is the rank,
 * 0 means 200+ (checked, not found), and null means not checked that day.
 */
export function packHistory(days, current) {
  // A history file that parses but isn't { date, ranks } ("null", "{}", a hand edit) is skipped,
  // so one bad day can't stop the whole dashboard from building.
  days = days.filter((day) => typeof day?.date === "string" && day.ranks && typeof day.ranks === "object");
  const ranks = {};
  days.forEach((day, i) => {
    for (const [key, rank] of Object.entries(day.ranks)) {
      if (!current.has(key)) continue;
      ranks[key] ??= Array(days.length).fill(null);
      ranks[key][i] = rank ?? 0;
    }
  });
  return { dates: days.map((d) => d.date), ranks };
}

// How many tracked days on each side of a release we compare. A week evens out the day-to-day
// wobble of ranks without mixing in last month.
const IMPACT_DAYS = 7;

/**
 * Did a release help? For each release in releases.json, and each keyword × country with
 * history on BOTH sides of it: the average rank over the last 7 tracked days before the release
 * day and the first 7 after it, as { "keyword|cc": [before, after] } (200+ counts as 201, like
 * everywhere else). The release day itself is left out: the new version goes live at some point
 * that day, so its ranks are a mix of old and new.
 * `history` is packHistory's output. Releases are untrusted (Apple's text): only plain strings
 * of the expected shape get through.
 */
export function releaseImpact(history, releases) {
  const list = Array.isArray(releases) ? releases : [];
  const average = (ranks) => Math.round((ranks.reduce((sum, r) => sum + (r || 201), 0) / ranks.length) * 10) / 10;
  return list
    .filter((r) => typeof r?.version === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r?.date))
    .map((r) => {
      const impact = {};
      for (const [key, ranks] of Object.entries(history.ranks)) {
        // Dates are YYYY-MM-DD, so plain string comparison puts them in order.
        const checked = (side) => ranks.filter((rank, i) => rank !== null && side(history.dates[i]));
        const before = checked((d) => d < r.date).slice(-IMPACT_DAYS);
        const after = checked((d) => d > r.date).slice(0, IMPACT_DAYS);
        if (before.length && after.length) impact[key] = [average(before), average(after)];
      }
      const changes = Array.isArray(r.changes) ? r.changes.filter((c) => ["version", "name", "description"].includes(c)) : [];
      return { version: r.version, date: r.date, notes: typeof r.notes === "string" ? r.notes : "", changes, impact };
    });
}

/**
 * Put the data into the page. JSON inside a <script> tag must not contain "</script>", or the
 * browser would end the script there; App Store app names are untrusted text, so we escape every
 * "<" as < (still valid JSON, and JSON.parse turns it back into "<").
 */
export function renderPage(template, data, fonts) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  // Function replacers, so "$&" or "$1" inside the data can't be read as a replace() pattern.
  return template
    .replace("/*FONT_400*/", () => fonts[400])
    .replace("/*FONT_600*/", () => fonts[600])
    .replace("__SEARCHD_DATA__", () => json);
}

/** Every history file, oldest first. */
function loadHistory() {
  const dir = path("history");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .map((f) => readJson(`history/${f}`));
}

/** Open a file in the default browser (macOS, Windows, Linux). Failing to open isn't fatal. */
function openInBrowser(file) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [file]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", file]] : ["xdg-open", [file]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

if (isMain(import.meta.url)) {
  const app = requireApp();
  const results = readJson("results.json", { entries: {} });
  if (!Object.keys(results.entries).length) {
    console.log("No results yet. Run /searchd-find first, then build the dashboard.");
    process.exit(0);
  }
  const font = (weight) => readFileSync(here(`fonts/poppins-${weight}.woff2`)).toString("base64");
  const html = renderPage(
    readFileSync(here("dashboard-page.html"), "utf8"),
    buildData(app, readJson("keywords.json", []), results, loadHistory(), readJson("releases.json", {})?.releases),
    { 400: font(400), 600: font(600) }
  );
  const out = path("dashboard.html");
  writeFileSync(out, html);
  console.log(`searchd dashboard: ${out}`);
  if (!process.argv.includes("--no-open")) openInBrowser(out);
}
