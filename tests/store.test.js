// Edge-case tests for lib/store.js: atomic writes, damaged files on disk, the run lock's own
// behavior, and the small helpers. Every test gets its own SEARCHD_DIR temp folder.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  dataDir, path, readJson, writeJson, today, entryKey, flag, isMain, acquireLock, printable,
} from "../skills/searchd-find/scripts/lib/store.js";

beforeEach(() => {
  process.env.SEARCHD_DIR = mkdtempSync(join(tmpdir(), "searchd-test-"));
});

/** Run `fn` with process.exit and console.error replaced, so "print a message and exit" can be tested. */
function expectExit(fn) {
  const realExit = process.exit;
  const realError = console.error;
  const messages = [];
  process.exit = (code) => {
    throw Object.assign(new Error(`exit ${code}`), { exitCode: code });
  };
  console.error = (message) => messages.push(message);
  try {
    assert.throws(fn, { exitCode: 1 });
  } finally {
    process.exit = realExit;
    console.error = realError;
  }
  return messages;
}

// ---- dataDir / path ----

test("dataDir uses SEARCHD_DIR when set, otherwise ./.searchd, and is read on every call", () => {
  const set = process.env.SEARCHD_DIR;
  assert.equal(dataDir(), set);
  assert.equal(path("history", "x.json"), join(set, "history", "x.json"));
  delete process.env.SEARCHD_DIR;
  try {
    assert.equal(dataDir(), join(process.cwd(), ".searchd"));
  } finally {
    process.env.SEARCHD_DIR = set;
  }
});

// ---- writeJson ----

test("writeJson: pretty-prints with a trailing newline, creates folders, and leaves no temp file", () => {
  writeJson("history/2026-10-25.json", { date: "2026-10-25", ranks: { "a|us": null } });
  const file = join(process.env.SEARCHD_DIR, "history", "2026-10-25.json");
  assert.equal(readFileSync(file, "utf8"), '{\n  "date": "2026-10-25",\n  "ranks": {\n    "a|us": null\n  }\n}\n');
  assert.deepEqual(readdirSync(join(process.env.SEARCHD_DIR, "history")), ["2026-10-25.json"]);
});

test("writeJson: overwrites an existing file completely", () => {
  writeJson("a.json", { long: "x".repeat(1000) });
  writeJson("a.json", { short: 1 });
  assert.deepEqual(readJson("a.json"), { short: 1 });
});

test("writeJson: data that can't be serialized throws and leaves the old file and no temp file", () => {
  writeJson("a.json", { keep: true });
  const circular = {};
  circular.self = circular;
  assert.throws(() => writeJson("a.json", circular), TypeError);
  assert.throws(() => writeJson("a.json", { n: 10n }), TypeError);
  assert.deepEqual(readJson("a.json"), { keep: true });
  assert.deepEqual(readdirSync(process.env.SEARCHD_DIR), ["a.json"]);
});

test("writeJson: a failed rename throws and cleans up its temp file", () => {
  mkdirSync(join(process.env.SEARCHD_DIR, "taken.json", "inside"), { recursive: true }); // a folder where the file should go
  assert.throws(() => writeJson("taken.json", { a: 1 }));
  assert.deepEqual(readdirSync(process.env.SEARCHD_DIR), ["taken.json"], "no taken.json.<pid>.tmp left behind");
});

test("writeJson: unusual but valid data round-trips", () => {
  const data = { unicode: "kalorienzähler 🍅 カロリー", nested: [[], {}, null, 0, false, ""], "a|b": 1 };
  writeJson("x.json", data);
  assert.deepEqual(readJson("x.json"), data);
});

// ---- readJson ----

test("readJson: a missing file gives the fallback (null by default)", () => {
  assert.equal(readJson("nope.json"), null);
  assert.deepEqual(readJson("nope.json", { entries: {} }), { entries: {} });
});

test("readJson: damaged files (truncated, empty, hand-edited) exit with a message naming the file", () => {
  for (const [name, content] of [["partial.json", '{"entries": {"a|us": {"rank": 3'], ["empty.json", ""], ["comma.json", '{"a": 1,}']]) {
    writeFileSync(join(process.env.SEARCHD_DIR, name), content);
    const messages = expectExit(() => readJson(name));
    assert.equal(messages.length, 1);
    assert.ok(messages[0].includes(join(process.env.SEARCHD_DIR, name)), "names the file");
    assert.match(messages[0], /isn't valid JSON/);
  }
});

test("readJson: JSON that is valid but not an object comes back as parsed", () => {
  writeFileSync(join(process.env.SEARCHD_DIR, "list.json"), "[1,2]");
  assert.deepEqual(readJson("list.json"), [1, 2]);
});

// ---- small helpers ----

test("today() is the local date as YYYY-MM-DD, including near midnight", () => {
  assert.equal(today(new Date(2026, 0, 5, 23, 59, 59)), "2026-01-05");
  assert.equal(today(new Date(2026, 11, 31, 0, 0, 0)), "2026-12-31");
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
});

test("entryKey and flag", () => {
  assert.equal(entryKey("calorie counter", "de"), "calorie counter|de");
  assert.equal(flag("de"), "🇩🇪");
  assert.equal(flag("US"), "🇺🇸");
  assert.equal(flag(""), "");
});

test("isMain: true when run directly or through a symlink (how skills are installed), false for other URLs", () => {
  const dir = mkdtempSync(join(tmpdir(), "searchd-ismain-"));
  const storeUrl = pathToFileURL(join(process.cwd(), "skills/searchd-find/scripts/lib/store.js")).href;
  const script = join(dir, "probe.mjs");
  writeFileSync(script, `import { isMain } from "${storeUrl}";\nconsole.log(isMain(import.meta.url), isMain("file:///somewhere/else.js"));\n`);
  symlinkSync(script, join(dir, "link.mjs"));
  const run = (file) => execFileSync(process.execPath, [file], { encoding: "utf8" }).trim();
  assert.equal(run(script), "true false");
  assert.equal(run(join(dir, "link.mjs")), "true false", "the symlink path in argv still matches the real path");
});

// ---- acquireLock ----

test("acquireLock: writes our PID, release removes it, releasing twice is harmless, no listener leaks", () => {
  const exitListeners = process.listenerCount("exit");
  const release = acquireLock();
  assert.equal(typeof release, "function");
  assert.equal(readFileSync(join(process.env.SEARCHD_DIR, "run.lock"), "utf8"), String(process.pid));
  release();
  release();
  assert.ok(!existsSync(join(process.env.SEARCHD_DIR, "run.lock")));
  assert.equal(process.listenerCount("exit"), exitListeners);
});

test("acquireLock: a lock held by another live process gives null and is left alone", () => {
  writeFileSync(join(process.env.SEARCHD_DIR, "run.lock"), String(process.ppid));
  assert.equal(acquireLock(), null);
  assert.equal(readFileSync(join(process.env.SEARCHD_DIR, "run.lock"), "utf8"), String(process.ppid));
});

test("acquireLock: creates the data folder when it doesn't exist yet", () => {
  process.env.SEARCHD_DIR = join(process.env.SEARCHD_DIR, "new", "folder");
  const release = acquireLock();
  assert.ok(existsSync(join(process.env.SEARCHD_DIR, "run.lock")));
  release();
});

test("acquireLock: a real problem (read-only folder) is reported as itself, not as a missing lock file", (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("needs a non-root POSIX user");
  chmodSync(process.env.SEARCHD_DIR, 0o555);
  try {
    assert.throws(() => acquireLock(), { code: "EACCES" });
  } finally {
    chmodSync(process.env.SEARCHD_DIR, 0o755);
  }
});

test("printable: removes control codes and bidi overrides, keeps everything else", () => {
  assert.equal(printable("Formula 1®: Live Timing — 日本 🏎️"), "Formula 1®: Live Timing — 日本 🏎️");
  assert.equal(printable("A\u001b[31mB\u0007C\nD\u009bE"), "A[31mBCDE");
  assert.equal(printable("evil\u202eppa\u2066x\u2069"), "evilppax");
  assert.equal(printable(null), "");
  assert.equal(printable(42), "42");
});
