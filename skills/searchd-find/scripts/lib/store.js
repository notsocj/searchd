// store.js — reads and writes searchd's data files.
//
// Everything searchd knows lives in a `.searchd/` folder inside the folder you run it from
// (normally your app's project folder). No accounts, no cloud: just JSON files you can open.
//
//   .searchd/
//   ├── app.json           your app + the countries you track + competitors (written by setup)
//   ├── keywords.json      every keyword, its local phrase per country, tracked or idea
//   ├── results.json       the latest check for each keyword × country (rank, volume, difficulty, top apps)
//   ├── history/           one file per day: { date, ranks: { "keyword|cc": rank } }
//   ├── cache/<date>/      raw search results, so the same search isn't repeated within a day
//   ├── audit.json         the last listing suggestion from /searchd-audit
//   └── dashboard.html     the generated dashboard
//
// Set SEARCHD_DIR to use a different folder (the tests do this).

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

/** The data folder. Read every time (not once at import) so tests can change SEARCHD_DIR. */
export function dataDir() {
  return process.env.SEARCHD_DIR || join(process.cwd(), ".searchd");
}

/** Full path of a file inside the data folder, e.g. path("history", "2026-10-25.json"). */
export function path(...parts) {
  return join(dataDir(), ...parts);
}

/** Read a JSON file from the data folder, or return `fallback` if it doesn't exist yet. */
export function readJson(name, fallback = null) {
  const file = path(name);
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // A half-written or hand-edited file shouldn't crash with a stack trace.
    throw new Error(`searchd: ${file} isn't valid JSON. Fix or delete it, then try again.`);
  }
}

/**
 * Write a JSON file atomically: write to a temp file, then rename it over the real one.
 * A rename is all-or-nothing, so if the process is killed mid-write (e.g. a long check
 * stopped with Ctrl+C) you never end up with a half-written results.json.
 */
export function writeJson(name, data) {
  const file = path(name);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}

/** The app saved by /searchd-setup. Exits with a clear message if setup hasn't run here. */
export function requireApp() {
  const app = readJson("app.json");
  if (!app) {
    console.error(`searchd isn't set up in this folder (no ${path("app.json")}). Run /searchd-setup first.`);
    process.exit(1);
  }
  return app;
}

/** Today's date as YYYY-MM-DD in the user's local time zone (used for history + cache). */
export function today(now = new Date()) {
  // "en-CA" formats dates as YYYY-MM-DD, which saves us from padding months by hand.
  return now.toLocaleDateString("en-CA");
}

/** Key for one keyword in one country, used in results.json and history files. */
export const entryKey = (keyword, country) => `${keyword}|${country}`;

/** Turn a 2-letter country code into its flag emoji: "de" → 🇩🇪. */
export function flag(country) {
  // Flag emojis are two "regional indicator" letters; 🇦 is U+1F1E6, so A→🇦, B→🇧, …
  return [...country.toUpperCase()].map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join("");
}

/** Read all of stdin as JSON (the agent passes data to scripts through a heredoc). */
export async function readStdinJson() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  try {
    return JSON.parse(text);
  } catch {
    console.error("searchd: expected JSON on stdin.");
    process.exit(1);
  }
}

/**
 * True when the file with this import.meta.url was run directly (`node setup.js …`), false when
 * a test imports it. realpath matters: skills are often installed as symlinks, and Node reports
 * the real path in import.meta.url but the symlink path in process.argv.
 */
export function isMain(importMetaUrl) {
  return Boolean(process.argv[1]) && importMetaUrl === pathToFileURL(realpathSync(process.argv[1])).href;
}
