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
      const row = apps.get(app.id) ?? { id: app.id, name: app.name, icon: safeIcon(app.icon), ratings: app.ratings, beats: 0, positions: 0, phrases: [] };
      row.beats++;
      row.positions += position;
      row.phrases.push(`${entry.country}:${entry.phrase}`);
      apps.set(app.id, row);
    });
  }
  return [...apps.values()]
    .map(({ positions, ...row }) => ({ ...row, avgPosition: Math.round((positions / row.beats) * 10) / 10 }))
    .sort((a, b) => b.beats - a.beats || a.avgPosition - b.avgPosition)
    .slice(0, limit);
}

/** Everything the page needs, with descriptions dropped and icon URLs checked. */
export function buildData(app, keywords, results, history) {
  const entries = {};
  for (const [key, e] of Object.entries(results.entries ?? {})) {
    entries[key] = { ...e, top: e.top.map((t) => ({ ...t, icon: safeIcon(t.icon) })) };
  }
  return {
    app: { id: app.id, name: app.name, icon: safeIcon(app.icon), countries: app.countries, competitors: (app.competitors ?? []).map((c) => ({ ...c, icon: safeIcon(c.icon) })) },
    keywords: keywords.map(({ keyword, status, local }) => ({ keyword, status, local })),
    entries,
    history,
    losingTo: losingTo(entries, app.id),
    sweetSpot: SWEET_SPOT,
    updatedAt: results.updatedAt ?? null,
    generatedAt: new Date().toISOString(),
  };
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
    buildData(app, readJson("keywords.json", []), results, loadHistory()),
    { 400: font(400), 600: font(600) }
  );
  const out = path("dashboard.html");
  writeFileSync(out, html);
  console.log(`searchd dashboard: ${out}`);
  if (!process.argv.includes("--no-open")) openInBrowser(out);
}
