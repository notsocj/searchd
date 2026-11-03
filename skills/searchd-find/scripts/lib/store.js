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
//   ├── releases.json      each version of your app /searchd-track has seen (for release markers)
//   ├── competitor-releases.json   the same, per competitor from setup
//   ├── audit.json         the last listing suggestion from /searchd-audit
//   └── dashboard.html     the generated dashboard
//
// Set SEARCHD_DIR to use a different folder (the tests do this).

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, realpathSync, rmSync } from "node:fs";
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
    // A hand-edited file shouldn't end in a stack trace: say which file, and stop.
    console.error(`searchd: ${file} isn't valid JSON. Fix or delete it, then try again.`);
    process.exit(1);
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
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
    renameSync(tmp, file);
  } catch (error) {
    // A full disk would otherwise leave a half-written temp file behind on every attempt.
    // The real file was never touched, so removing the temp file is all the cleanup needed.
    rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * The platforms searchd can research, and the iTunes Search API `entity` for each. "iphone" is the
 * default: app.json files saved before platforms existed have no `platform` field, and they were
 * all iPhone searches (entity=software). These live here, next to requireApp(), because they
 * describe a field of app.json; lib/itunes.js re-exports them for the client.
 */
export const PLATFORMS = { iphone: "software", ipad: "iPadSoftware", mac: "macSoftware" };
export const DEFAULT_PLATFORM = "iphone";

/** Is this one of the platforms above? (Object.hasOwn: "constructor" is not a platform.) */
export const isPlatform = (value) => typeof value === "string" && Object.hasOwn(PLATFORMS, value);

/** The platform an app.json is set up for: its `platform` field, or "iphone" when it has none. */
export const platformOf = (app) => app?.platform ?? DEFAULT_PLATFORM;

/**
 * The app saved by /searchd-setup. Exits with ONE clear line (code 1, no stack trace) if setup
 * hasn't run here, or if app.json's "platform" was hand-edited to something searchd can't search.
 * Every script loads the app through here before making a client, so a bad value is caught
 * before any work starts.
 */
export function requireApp() {
  const app = readJson("app.json");
  if (!app) {
    console.error(`searchd isn't set up in this folder (no ${path("app.json")}). Run /searchd-setup first.`);
    process.exit(1);
  }
  // Missing or null means iPhone (platformOf). Anything else must be a known platform.
  if (app.platform != null && !isPlatform(app.platform)) {
    // JSON.stringify shows exactly what's there ("Mac" vs "mac", 5 vs "5"), cut short and made
    // printable so a strange value can't flood or mess up the terminal.
    const got = printable(String(JSON.stringify(app.platform)).slice(0, 40));
    console.error(`searchd: "platform" in ${path("app.json")} must be ${Object.keys(PLATFORMS).join(", ")} (got ${got}). Fix it, or run /searchd-setup again with the right platform.`);
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

/**
 * App Store text made safe to print in a terminal. App names are untrusted: one could hide
 * terminal control codes (ESC sequences that recolor, move the cursor or rewrite the line) or
 * bidi overrides (which make text display in a different order than it's stored). Both are
 * removed, so what you read is what's there. JSON output doesn't need this: JSON.stringify
 * already escapes control characters.
 */
export function printable(text) {
  return String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "");
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

/**
 * Make sure only one check runs at a time in this folder. Two runs at once would both rewrite
 * results.json from their own copy, so one run's results would be lost, and together they'd
 * break Apple's rate limit anyway. The lock is a file holding the running process's ID; if that
 * process is gone (crashed, killed), the lock is stale and we take it over.
 * Returns a release() function, or null if another live run holds the lock.
 */
export function acquireLock() {
  const file = path("run.lock");
  mkdirSync(dataDir(), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx" }); // "wx" fails if the file exists
      const release = () => rmSync(file, { force: true });
      process.once("exit", release); // also freed if the run crashes
      catchSignalsOnce();
      return () => {
        process.off("exit", release);
        release();
      };
    } catch (error) {
      // Only "the lock file already exists" means someone holds it. Anything else (a read-only
      // folder, a full disk) is a real problem: say so, instead of failing on reading a file
      // that was never created.
      if (error.code !== "EEXIST") throw error;
      const pid = Number(readFileSync(file, "utf8"));
      if (pid && pid !== process.pid && isAlive(pid)) return null;
      rmSync(file, { force: true }); // stale: its process is gone
    }
  }
  return null;
}

// Ctrl+C normally ends Node without running "exit" handlers. Exiting explicitly runs them,
// so the lock file is removed. (130/143 are the usual exit codes for SIGINT/SIGTERM.)
let signalsCaught = false;
function catchSignalsOnce() {
  if (signalsCaught) return;
  signalsCaught = true;
  process.once("SIGINT", () => process.exit(130));
  process.once("SIGTERM", () => process.exit(143));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 checks the process exists without touching it
    return true;
  } catch (error) {
    return error.code === "EPERM"; // exists, but owned by someone else
  }
}
