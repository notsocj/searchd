// Tests the INSTALLED layout, which is not the repo layout: the five skill folders sit side by
// side in someone's skills folder, with no repo-root package.json, no tests, no node_modules.
// That is what `npx skills add` (copy), `install.sh` (copy) and `install.sh --link` (symlinks)
// produce. Each skill must load the shared code from its sibling and run as an ES module using
// only its own package.json. Child processes run with fetch disabled (helpers/no-network.cjs).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, symlinkSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeJson } from "../skills/searchd-find/scripts/lib/store.js";

const repoSkills = fileURLToPath(new URL("../skills", import.meta.url));
const SKILLS = ["searchd-setup", "searchd-find", "searchd-track", "searchd-audit", "searchd-dashboard"];

beforeEach(() => {
  process.env.SEARCHD_DIR = mkdtempSync(join(tmpdir(), "searchd-test-"));
});
process.env.NODE_OPTIONS = `--require ${fileURLToPath(new URL("./helpers/no-network.cjs", import.meta.url))}`;

/** A fresh "skills folder": the five skills copied in, or symlinked like `install.sh --link`. */
function install(mode, skills = SKILLS) {
  const root = mkdtempSync(join(tmpdir(), "searchd-install-"));
  for (const skill of skills) {
    if (mode === "link") symlinkSync(join(repoSkills, skill), join(root, skill));
    else cpSync(join(repoSkills, skill), join(root, skill), { recursive: true });
  }
  return root;
}
const run = (root, skill, file, args = [], input = "") =>
  spawnSync(process.execPath, [join(root, skill, "scripts", file), ...args], { input, encoding: "utf8", env: process.env, cwd: process.env.SEARCHD_DIR });

for (const mode of ["copy", "link"]) {
  test(`${mode}ed install: every skill's script starts, loads the shared code from its sibling, and works`, () => {
    const root = install(mode);
    writeJson("app.json", { id: 1, name: "Me", description: "d", countries: ["us"], competitors: [] });

    // find: status prints JSON (loads store.js, itunes.js, checks.js, score.js directly)
    const find = run(root, "searchd-find", "find.js", ["status"]);
    assert.equal(find.status, 0, find.stderr);
    assert.equal(JSON.parse(find.stdout).app.id, 1);

    // track: no tracked keywords yet (loads store, itunes, checks through shared.js)
    writeJson("keywords.json", []);
    const track = run(root, "searchd-track", "track.js");
    assert.equal(track.status, 0, track.stderr);
    assert.match(track.stdout, /No tracked keywords yet/);

    // audit: an invalid listing set is refused (loads store, itunes, score through shared.js)
    const audit = run(root, "searchd-audit", "audit.js", ["check"], "{}");
    assert.equal(audit.status, 1);
    assert.match(audit.stderr, /Not saved\. Fix these/);

    // setup: invalid input is refused before any network use
    const setup = run(root, "searchd-setup", "setup.js", ["save"], "null");
    assert.equal(setup.status, 1);
    assert.match(setup.stderr, /fix these and try again/);

    // dashboard: builds from the installed copy, which must also contain the page and the fonts
    writeJson("results.json", { entries: { "a|us": { keyword: "a", country: "us", phrase: "a", rank: 1, volume: 1, difficulty: 1, opportunity: 1, competitors: {}, top: [{ id: 1, name: "Me", icon: "", ratings: 1, rating: 1 }] } } });
    writeJson("keywords.json", [{ keyword: "a", status: "tracked", local: { us: "a" } }]);
    const dashboard = run(root, "searchd-dashboard", "dashboard.js", ["--no-open"]);
    assert.equal(dashboard.status, 0, dashboard.stderr);
    const html = readFileSync(join(process.env.SEARCHD_DIR, "dashboard.html"), "utf8");
    assert.ok(html.includes("font/woff2;base64,") && !html.includes("/*FONT_400*/"), "fonts were inlined");
    rmSync(root, { recursive: true, force: true });
  });
}

test("a copied install with a skill missing says to install all five together, for every skill that needs the shared code", () => {
  const root = install("copy", SKILLS.filter((s) => s !== "searchd-find"));
  writeJson("app.json", { id: 1, countries: ["us"] });
  for (const [skill, file, args] of [["searchd-setup", "setup.js", ["save"]], ["searchd-track", "track.js", []], ["searchd-audit", "audit.js", ["check"]], ["searchd-dashboard", "dashboard.js", ["--no-open"]]]) {
    const result = run(root, skill, file, args, "{}");
    assert.equal(result.status, 1, skill);
    assert.match(result.stderr, /install all five skills together/, skill);
    assert.ok(!result.stderr.includes("ERR_MODULE_NOT_FOUND"), `${skill}: no confusing Node error`);
  }
  rmSync(root, { recursive: true, force: true });
});

test("each skill has its own package.json with \"type\": \"module\" (installed skills never get the repo-root one)", () => {
  for (const skill of SKILLS) {
    const file = join(repoSkills, skill, "package.json");
    assert.ok(existsSync(file), `${skill}/package.json`);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).type, "module", skill);
  }
});

test("a copied install works with the repo-root package.json absent", () => {
  // (Newer Node detects ES modules without "type": "module", so this can't prove the field is
  // needed; Node 18 and 20 before 20.19 do need it, which is what the previous test guards.)
  const root = install("copy");
  writeJson("app.json", { id: 1, countries: ["us"] });
  writeJson("keywords.json", []);
  assert.equal(existsSync(join(root, "package.json")), false);
  assert.equal(run(root, "searchd-track", "track.js").status, 0);
  rmSync(root, { recursive: true, force: true });
});
