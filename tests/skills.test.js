// Tests for the five SKILL.md files: the pieces an agent actually reads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
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
