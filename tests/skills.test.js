// Tests for the five SKILL.md files: the pieces an agent actually reads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const SKILLS = ["searchd-setup", "searchd-find", "searchd-track", "searchd-audit", "searchd-dashboard"];
const read = (skill) => readFileSync(join(repo, "skills", skill, "SKILL.md"), "utf8");

/** Split "---\nkey: value\n---\nbody" into { meta, body }. */
function parse(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, "SKILL.md must start with --- frontmatter ---");
  const meta = Object.fromEntries(match[1].split("\n").map((line) => [line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim()]));
  return { meta, body: match[2] };
}

for (const skill of SKILLS) {
  test(`${skill}: frontmatter follows the Agent Skills format`, () => {
    const { meta } = parse(read(skill));
    assert.equal(meta.name, skill, "name must match the folder name");
    assert.ok(meta.description && meta.description.length <= 1024, "description required, ≤ 1024 chars");
    assert.ok(existsSync(join(repo, "skills", skill, "package.json")), "each skill needs its own package.json (type: module)");
  });

  test(`${skill}: every script it mentions exists`, () => {
    for (const [, file] of read(skill).matchAll(/\$\{CLAUDE_SKILL_DIR\}\/(scripts\/[\w./-]+\.js)/g)) {
      assert.ok(existsSync(join(repo, "skills", skill, file)), `${skill}/${file}`);
    }
  });
}

test("the shared.js copies are identical", () => {
  const copies = SKILLS.filter((s) => s !== "searchd-find").map((s) => readFileSync(join(repo, "skills", s, "scripts", "shared.js"), "utf8"));
  for (const copy of copies) assert.equal(copy, copies[0]);
});

// ---- Repo rules (CLAUDE.md hard rule 4 and the shared-code loading rule) ----

/** Every .js file under a folder (a plain walk: the `recursive` option of readdirSync needs Node 18.17+). */
function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

/** The module specifiers a file imports statically: `import x from "a"`, `import "a"`, `export … from "a"`. */
function staticImports(source) {
  const specifiers = [];
  for (const match of source.matchAll(/^\s*(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']/gm)) specifiers.push(match[1]);
  for (const match of source.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) specifiers.push(match[1]);
  return specifiers;
}

test("only searchd-find imports shared code statically; every other skill loads it through shared.js", () => {
  for (const skill of SKILLS.filter((s) => s !== "searchd-find")) {
    for (const file of jsFiles(join(repo, "skills", skill))) {
      for (const specifier of staticImports(readFileSync(file, "utf8"))) {
        assert.ok(specifier.startsWith("node:") || specifier === "./shared.js", `${file}: static import of "${specifier}" (use loadShared from ./shared.js)`);
      }
    }
  }
});

test("zero npm dependencies: scripts import only node: built-ins or their own relative files", () => {
  for (const file of jsFiles(join(repo, "skills"))) {
    for (const specifier of staticImports(readFileSync(file, "utf8"))) {
      assert.ok(specifier.startsWith("node:") || specifier.startsWith("./"), `${file}: imports "${specifier}"`);
    }
  }
  for (const manifest of ["package.json", ...SKILLS.map((s) => join("skills", s, "package.json"))]) {
    const pkg = JSON.parse(readFileSync(join(repo, manifest), "utf8"));
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) assert.equal(pkg[field], undefined, `${manifest} has ${field}`);
  }
});

test("scripts avoid APIs that need newer than Node 18", () => {
  // Not a full audit, just the usual suspects. Each of these needs Node 19 or later.
  const newer = /import\.meta\.(?:dirname|filename|resolve)|\.(?:toSorted|toReversed|toSpliced)\(|Object\.groupBy|Map\.groupBy|Array\.fromAsync|Promise\.withResolvers|\.isWellFormed\(|AbortSignal\.any|loadEnvFile|styleText|globSync|getBuiltinModule|URL\.canParse|crypto\.hash\(|readdirSync\([^)]*recursive|\.(?:union|intersection|difference|symmetricDifference)\(/;
  for (const file of jsFiles(join(repo, "skills"))) {
    // Comments may name these APIs (e.g. "don't use import.meta.dirname"), code may not.
    const code = readFileSync(file, "utf8").split("\n").filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line)).join("\n");
    assert.ok(!newer.test(code), `${file} uses an API newer than Node 18: ${code.match(newer)?.[0]}`);
  }
});

test("the static-import scanner itself understands multi-line and side-effect imports", () => {
  const source = 'import {\n  a,\n  b,\n} from "node:fs";\nimport "x";\nexport { y } from "./y.js";\n// import z from "commented";\nconst s = "import q from nope";\n';
  assert.deepEqual(staticImports(source).sort(), ["./y.js", "node:fs", "x"]);
});
