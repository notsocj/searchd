// Tests for reading the app's own project (lib/project.js) and writing an audit suggestion into
// fastlane's metadata files (audit.js write). Everything runs in temp folders, no network.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { screenName, uiText, scanProject, readMetadata, findMetadataDir } from "../skills/searchd-find/scripts/lib/project.js";
import { writeMetadata } from "../skills/searchd-audit/scripts/audit.js";
import { writeJson } from "../skills/searchd-find/scripts/lib/store.js";

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "searchd-project-"));
  process.env.SEARCHD_DIR = join(root, ".searchd");
});

/** Write a file under the temp project, creating folders. */
function put(file, text) {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), text);
}

const listing = (extra = {}) => ({ locale: "en-US", countries: ["us"], name: "Gridpeek: F1 Calendar", subtitle: "Race weekend planner", keywords: "grand,prix,schedule,tickets", ...extra });

// ---- screenName / uiText ----

test("screenName: screen files in Swift, Kotlin, Flutter and React Native become plain words", () => {
  assert.equal(screenName("App/RaceCalendarView.swift"), "race calendar");
  assert.equal(screenName("TicketWalletViewController.swift"), "ticket wallet");
  assert.equal(screenName("lib/race_schedule_screen.dart"), "race schedule");
  assert.equal(screenName("src/TripPlannerPage.tsx"), "trip planner");
  assert.equal(screenName("PDFExportView.swift"), "pdf export");
});

test("screenName: non-screens and generic names are ignored", () => {
  for (const file of ["RaceCalendar.swift", "ContentView.swift", "MainScreen.kt", "SettingsView.swift", "SignInScreen.tsx", "View.swift", "notes.txt", "CalendarView.png"]) {
    assert.equal(screenName(file), null, file);
  }
});

test("uiText: keeps words people see, drops identifiers and format codes", () => {
  assert.equal(uiText("Race Calendar"), "Race Calendar");
  assert.equal(uiText("%lld races this season"), "races this season");
  assert.equal(uiText("Tickets"), "Tickets");
  for (const bad of ["onboarding.title", "settingsButton", "%@", "42", "", "a", "x".repeat(61), null]) assert.equal(uiText(bad), null, String(bad));
});

// ---- scanProject ----

test("scanProject: finds screens, English UI strings and fastlane metadata; skips dependencies", () => {
  put("App/Views/RaceCalendarView.swift", "");
  put("App/Views/TicketWalletView.swift", "");
  put("Pods/Some/AdBannerView.swift", "");
  put("node_modules/x/CheckoutScreen.tsx", "");
  put(".build/GeneratedView.swift", "");
  put("App/Localizable.xcstrings", JSON.stringify({ sourceLanguage: "en", strings: { "Race Calendar": {}, "onboarding.title": {}, "Add to calendar": {} } }));
  // Old-style .strings in UTF-16 with a BOM, like Xcode used to write them; German is skipped.
  put("App/en.lproj/Localizable.strings", "");
  writeFileSync(join(root, "App/en.lproj/Localizable.strings"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('"live" = "Live timing";\n', "utf16le")]));
  put("App/de.lproj/Localizable.strings", '"live" = "Live-Zeiten";\n');
  put("fastlane/metadata/en-US/keywords.txt", "f1,race\n");
  put("fastlane/metadata/en-US/name.txt", "Gridpeek\n");
  put("fastlane/metadata/review_information/notes.txt", "x");

  const scan = scanProject(root);
  assert.deepEqual(scan.screens.sort(), ["race calendar", "ticket wallet"]);
  assert.deepEqual(scan.strings, ["Live timing", "Race Calendar", "Add to calendar"], "shortest first; identifiers and German dropped");
  assert.deepEqual(scan.metadata, { dir: join("fastlane", "metadata"), locales: { "en-US": { name: "Gridpeek", keywords: "f1,race" } } });
});

test("scanProject: SwiftUI text written inline counts as UI text; interpolations are dropped", () => {
  put("App/RaceView.swift", 'Text("Race Calendar")\nButton("Add to wallet") { }\n.navigationTitle("Hi \\(name), ready?")\nText(verbatim: x)\nlet id = "race.calendar"');
  assert.deepEqual(scanProject(root).strings, ["Hi , ready?", "Race Calendar", "Add to wallet"]);
});

test("scanProject: Expo Router screens and React Native <Text> count too", () => {
  put("apps/mobile/app/(tabs)/race-weekends.tsx", '<Text style={s.title}>Race weekends</Text>\n<Text>{count} sessions</Text>\n<Text>\n  Plan your trip\n</Text>');
  for (const plumbing of ["_layout", "index", "[id]", "+not-found", "settings"]) put(`apps/mobile/app/${plumbing}.tsx`, "");
  put("apps/mobile/components/Badge.tsx", "");
  const scan = scanProject(root);
  assert.deepEqual(scan.screens, ["race weekends"]);
  assert.deepEqual(scan.strings, ["Race weekends", "Plan your trip"]);
});

test("scanProject: an empty folder or a broken string catalog is fine", () => {
  assert.deepEqual(scanProject(root), { metadata: null, screens: [], strings: [], scanned: 0 });
  put("Broken.xcstrings", "{ not json");
  assert.deepEqual(scanProject(root).strings, []);
});

test("scanProject: lists are de-duplicated ignoring case", () => {
  put("A/RaceCalendarView.swift", "");
  put("B/RaceCalendarScreen.kt", "");
  put("C.xcstrings", JSON.stringify({ strings: { Tickets: {}, tickets: {} } }));
  const scan = scanProject(root);
  assert.deepEqual(scan.screens, ["race calendar"]);
  assert.deepEqual(scan.strings, ["Tickets"]);
});

// ---- writeMetadata (audit.js) ----

test("writeMetadata: writes the three files into existing locale folders and reports the rest", () => {
  put("fastlane/metadata/en-US/name.txt", "Gridpeek\n");
  put("fastlane/metadata/en-US/keywords.txt", "f1,race"); // no trailing newline: keep it that way
  put("fastlane/metadata/en-US/subtitle.txt", "Race weekend planner\n");
  const dir = findMetadataDir(root);
  const result = writeMetadata(dir, [listing(), listing({ locale: "de-DE", countries: ["de"] })]);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.written, ["en-US/name.txt", "en-US/keywords.txt"]);
  assert.deepEqual(result.unchanged, ["en-US/subtitle.txt"]);
  assert.deepEqual(result.skipped, ["de-DE"], "no folder: a new language is the user's call");
  assert.equal(readFileSync(join(dir, "en-US/name.txt"), "utf8"), "Gridpeek: F1 Calendar\n");
  assert.equal(readFileSync(join(dir, "en-US/keywords.txt"), "utf8"), "grand,prix,schedule,tickets");
  assert.ok(!existsSync(join(dir, "de-DE")));
});

test("writeMetadata: a missing field file is created; running it twice changes nothing", () => {
  put("fastlane/metadata/ja/name.txt", "x\n");
  const dir = findMetadataDir(root);
  const ja = listing({ locale: "ja", countries: ["jp"] });
  assert.deepEqual(writeMetadata(dir, [ja]).written, ["ja/name.txt", "ja/subtitle.txt", "ja/keywords.txt"]);
  assert.equal(readFileSync(join(dir, "ja/subtitle.txt"), "utf8"), "Race weekend planner\n");
  assert.deepEqual(writeMetadata(dir, [ja]).written, []);
});

test("writeMetadata: a bad or hand-edited listing writes nothing at all", () => {
  put("fastlane/metadata/en-US/name.txt", "Gridpeek\n");
  const dir = findMetadataDir(root);
  for (const listings of [undefined, [], [listing({ locale: "../../evil" })], [listing(), listing({ name: "x".repeat(31) })]]) {
    const result = writeMetadata(dir, listings);
    assert.ok(result.problems.length, JSON.stringify(listings));
    assert.deepEqual(result.written, []);
  }
  assert.equal(readFileSync(join(dir, "en-US/name.txt"), "utf8"), "Gridpeek\n");
  assert.ok(!existsSync(join(root, "evil")));
});

test("readMetadata: folders without our three files are left out", () => {
  put("fastlane/metadata/review_information/first_name.txt", "Ada");
  put("fastlane/metadata/fr-FR/subtitle.txt", "  Calendrier F1  \n");
  assert.deepEqual(readMetadata(findMetadataDir(root)), { "fr-FR": { subtitle: "Calendrier F1" } });
});

// ---- the commands, as an agent runs them ----

const script = (skill, file) => fileURLToPath(new URL(`../skills/${skill}/scripts/${file}`, import.meta.url));
const run = (file, args) =>
  spawnSync(process.execPath, [file, ...args], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: `--require ${fileURLToPath(new URL("./helpers/no-network.cjs", import.meta.url))}` },
  });

test("audit.js write: needs a fastlane folder, then writes the saved listing and points at git diff", () => {
  writeJson("app.json", { id: 1, name: "Gridpeek", countries: ["us"], competitors: [] });
  writeJson("audit.json", { createdAt: "x", listings: [listing()] });
  const audit = script("searchd-audit", "audit.js");

  let result = run(audit, ["write"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No fastlane\/metadata folder/);

  put("fastlane/metadata/en-US/name.txt", "Gridpeek\n");
  result = run(audit, ["write"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /updated {3}fastlane\/metadata\/en-US\/name\.txt/);
  assert.match(result.stdout, /git diff -- fastlane\/metadata/);
  assert.equal(readFileSync(join(root, "fastlane/metadata/en-US/name.txt"), "utf8"), "Gridpeek: F1 Calendar\n");
});

test("find.js project: prints the scan of the current folder as JSON", () => {
  writeJson("app.json", { id: 1, name: "Gridpeek", countries: ["us"], competitors: [] });
  put("App/RaceCalendarView.swift", "");
  const result = run(script("searchd-find", "find.js"), ["project"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).screens, ["race calendar"]);
});
