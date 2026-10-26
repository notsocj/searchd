// project.js — reads the app's own project folder (the folder searchd runs in). Two uses:
//
//   1. scanProject(): what the app actually DOES, from its code: screen names (RaceCalendarView →
//      "race calendar") and the text its UI shows. /searchd-find brainstorms keywords from these,
//      so it can find features the App Store description never mentions.
//   2. findMetadataDir() + readMetadata(): the listing files fastlane keeps in the repo
//      (fastlane/metadata/<locale>/name.txt, subtitle.txt, keywords.txt). That's your REAL keyword
//      field, which the App Store never shows publicly; /searchd-audit starts from it and can
//      write its suggestion back there as a diff you review.
//
// Only reads files. Nothing here talks to Apple. (The one writer is writeMetadata in audit.js.)

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, basename, dirname } from "node:path";

// Folders that are never the app's own code: dependencies, build output, and searchd's data.
// Every folder whose name starts with "." (.git, .build, .searchd…) is skipped too.
const SKIP_DIRS = new Set(["node_modules", "Pods", "Carthage", "DerivedData", "build", "dist", "vendor", "fastlane"]);
// A huge monorepo shouldn't make /searchd-find hang: stop looking after this many entries.
const MAX_ENTRIES = 20_000;
const MAX_FILE_BYTES = 5_000_000;
const MAX_SCREENS = 100;
const MAX_STRINGS = 200;

// Screen files in Swift, Kotlin, Flutter and React Native, by the usual naming habits.
const SOURCE = /\.(swift|kt|dart|tsx|jsx|ts|js)$/;
const SCREEN_SUFFIX = /\s(?:view controller|view|screen|page)$/;
// Names that say nothing about what the app does: plumbing, and screens every app has.
const GENERIC = new Set([
  "content", "main", "root", "base", "app", "custom", "detail", "details", "list", "web", "empty", "loading", "splash", "launch", "error",
  "home", "settings", "onboarding", "acknowledgements", "about", "login", "sign in", "sign up", "paywall", "profile", "account", "dev", "debug",
]);
// Apps without a string catalog write their UI text inline: SwiftUI's Text("Race Calendar"),
// React Native's <Text>Race Calendar</Text>.
const SWIFTUI_TEXT = /\b(?:Text|Label|Button|Toggle|Section|Tab|navigationTitle)\(\s*"((?:[^"\\]|\\.)*)"/g;
const JSX_TEXT = /<Text\b[^>]*>([^<{}]+)<\/Text>/g;

/** Every file under `root` (paths), skipping SKIP_DIRS and dot folders, up to MAX_ENTRIES. */
function listFiles(root) {
  const files = [];
  const stack = [root];
  let seen = 0;
  // A plain loop with a stack: readdirSync's `recursive` option needs Node 18.17+, and this way
  // whole skipped folders are never even opened.
  while (stack.length && seen < MAX_ENTRIES) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable folder (permissions): not our business
    }
    for (const entry of entries) {
      if (++seen > MAX_ENTRIES) break;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) stack.push(full);
      } else if (entry.isFile()) files.push(full);
    }
  }
  return files;
}

/**
 * "RaceCalendarView.swift", "race_calendar_screen.dart" or Expo Router's "app/race-calendar.tsx"
 * → "race calendar" (null if it isn't a screen).
 */
export function screenName(file) {
  if (!SOURCE.test(file)) return null;
  const base = basename(file).replace(SOURCE, "");
  // Expo Router: every file under app/ is a screen, named by its file. "_layout", "[id]",
  // "+not-found" and "index" are routing plumbing, not features.
  const route = /\.(tsx|jsx)$/.test(file) && /(?:^|[/\\])app[/\\]/.test(file) && !/^[_[+]|^index$/.test(base);
  const words = base
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase → camel Case
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // "URLList" → "URL List"
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase();
  if (!route && !SCREEN_SUFFIX.test(words)) return null;
  const name = words.replace(SCREEN_SUFFIX, "").trim();
  return name && !GENERIC.has(name) ? name : null;
}

/**
 * Text a person would see in the UI, or null. Drops format codes (%@, %d, %1$@), and keys that
 * are identifiers rather than words ("onboarding.title", "settingsButton").
 */
export function uiText(text) {
  if (typeof text !== "string") return null;
  const clean = text.replace(/%(?:\d+\$)?(?:l{0,2}[duxX]|[@fFeEgGcCsSp])/g, "").replace(/\s+/g, " ").trim();
  if (clean.length < 2 || clean.length > 60 || !/\p{L}/u.test(clean)) return null;
  if (!/\s/.test(clean) && (/[._]/.test(clean) || /[a-z][A-Z]/.test(clean))) return null;
  return clean;
}

/** Read a .strings file: often UTF-16 (Xcode's old default), sometimes UTF-8. */
function readStrings(file) {
  const buffer = readFileSync(file);
  const utf16 = buffer[0] === 0xff && buffer[1] === 0xfe;
  return buffer.toString(utf16 ? "utf16le" : "utf8");
}

/** UI strings from one Swift file or localization file (the source/English values only). */
function stringsFrom(file) {
  if (statSync(file).size > MAX_FILE_BYTES) return [];
  if (file.endsWith(".swift")) {
    // "\(name)" interpolations are code, not words: drop them and keep the text around them.
    return [...readFileSync(file, "utf8").matchAll(SWIFTUI_TEXT)].map((m) => m[1].replace(/\\\(.*?\)/g, " "));
  }
  if (/\.(tsx|jsx)$/.test(file)) return [...readFileSync(file, "utf8").matchAll(JSX_TEXT)].map((m) => m[1]);
  if (file.endsWith(".xcstrings")) {
    // String catalogs: the keys ARE the source-language text when the code uses Text("…").
    try {
      return Object.keys(JSON.parse(readFileSync(file, "utf8")).strings ?? {});
    } catch {
      return []; // damaged catalog: skip it, don't stop the scan
    }
  }
  // Localizable.strings: "key" = "value"; — only English or Base, the language we brainstorm in.
  const folder = basename(dirname(file));
  if (!/^(?:en|en-[A-Za-z]+|Base)\.lproj$/.test(folder)) return [];
  return [...readStrings(file).matchAll(/"(?:[^"\\]|\\.)*"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/g)].map((m) => m[1].replace(/\\n/g, " "));
}

/** fastlane's metadata folder in this project, or null. */
export function findMetadataDir(root = process.cwd()) {
  const dir = join(root, "fastlane", "metadata");
  return existsSync(dir) && statSync(dir).isDirectory() ? dir : null;
}

export const METADATA_FIELDS = ["name", "subtitle", "keywords"];

/** { "en-US": { name, subtitle, keywords }, … } from fastlane's metadata folder (missing files are left out). */
export function readMetadata(dir) {
  const locales = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue; // review_information/ etc. have none of our three files
    const fields = {};
    for (const field of METADATA_FIELDS) {
      const file = join(dir, entry.name, `${field}.txt`);
      if (existsSync(file)) fields[field] = readFileSync(file, "utf8").trim();
    }
    if (Object.keys(fields).length) locales[entry.name] = fields;
  }
  return locales;
}

/**
 * What the agent reads before brainstorming: { metadata, screens, strings, scanned }.
 * Lists are de-duplicated (ignoring case) and capped so the output stays small.
 */
export function scanProject(root = process.cwd()) {
  const files = listFiles(root);
  const unique = (list, max) => {
    const seen = new Set();
    return list.filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase())).slice(0, max);
  };
  const metadataDir = findMetadataDir(root);
  return {
    metadata: metadataDir ? { dir: relative(root, metadataDir), locales: readMetadata(metadataDir) } : null,
    screens: unique(files.map(screenName), MAX_SCREENS),
    // Shortest first: short strings are button and screen titles ("Race Calendar"), the long
    // ones are sentences that rarely contain a new keyword.
    strings: unique(files.filter((f) => /\.(xcstrings|strings|swift|tsx|jsx)$/.test(f)).flatMap(stringsFrom).map(uiText), Infinity)
      .sort((a, b) => a.length - b.length)
      .slice(0, MAX_STRINGS),
    scanned: files.length,
  };
}
