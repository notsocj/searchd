#!/usr/bin/env node
// find.js — manages keywords and runs the App Store checks for /searchd-find.
//
//   node find.js status
//       JSON for the agent: the app, its countries, and every keyword with the countries that
//       still need a local phrase.
//
//   node find.js keywords <<'EOF'
//   [{ "keyword": "calorie counter", "status": "idea", "local": { "us": "calorie counter", "de": "kalorienzähler" } }]
//   EOF
//       Adds or updates keywords (matched by `keyword`). `local` phrases are merged in, so you can
//       send just the missing countries. `"remove": true` deletes a keyword.
//
//   node find.js check [--status tracked|idea|all] [--keywords "a,b"] [--countries "us,de"]
//       Searches the App Store for each keyword × country and saves the results.
//
//   node find.js summary [--status tracked|idea|all] [--limit 25]
//       A compact table of the latest results, best opportunities first (top 25 by default,
//       so a big keyword list doesn't flood the agent's context).

import { parseArgs } from "node:util";
import { readJson, writeJson, readStdinJson, requireApp, entryKey, flag, isMain } from "./lib/store.js";
import { createClient } from "./lib/itunes.js";
import { loadKeywords, planChecks, runChecks, pickCountries } from "./lib/checks.js";
import { isSweetSpot, normalize } from "./lib/score.js";

const STATUSES = ["tracked", "idea"];

/**
 * Clean a keyword or phrase the same way the scorer reads app names: lowercase, punctuation and
 * symbols (emoji, ™, |…) turned into spaces. Then the phrase we SEARCH is exactly the phrase we
 * SCORE: "🍅 focus" would otherwise be searched with the emoji but scored as just "focus".
 */
const clean = (text) => (typeof text === "string" ? normalize(text) : "");

/**
 * Merge the agent's keyword list into keywords.json. The input comes from the agent (and
 * indirectly from App Store text it read), so it's validated before anything is saved.
 * Returns { keywords, problems }.
 */
export function mergeKeywords(existing, input, countries) {
  const problems = [];
  const keywords = existing.map((k) => ({ ...k, local: { ...k.local } }));
  if (!Array.isArray(input)) return { keywords, problems: ["expected a JSON list of keywords"] };

  for (const [i, item] of input.entries()) {
    const where = `item ${i + 1}`;
    const keyword = clean(item?.keyword);
    if (!keyword || keyword.length > 100) {
      problems.push(`${where}: "keyword" must be words (not only symbols), under 100 characters`);
      continue;
    }
    const index = keywords.findIndex((k) => k.keyword === keyword);
    if (item.remove) {
      if (index !== -1) keywords.splice(index, 1);
      continue;
    }
    if (item.status !== undefined && !STATUSES.includes(item.status)) {
      problems.push(`${where} (${keyword}): status must be "tracked" or "idea"`);
      continue;
    }
    const local = {};
    for (const [country, phrase] of Object.entries(item.local ?? {})) {
      if (!countries.includes(country)) problems.push(`${where} (${keyword}): "${country}" isn't one of your countries (${countries.join(", ")})`);
      else if (!clean(phrase) || phrase.length > 100) problems.push(`${where} (${keyword}): local phrase for ${country} must be words (not only symbols), under 100 characters`);
      else local[country] = clean(phrase);
    }
    if (index === -1) {
      keywords.push({ keyword, local, status: item.status ?? "idea", source: item.status === "tracked" ? "manual" : "brainstorm", addedAt: new Date().toISOString() });
    } else {
      Object.assign(keywords[index].local, local);
      if (item.status) keywords[index].status = item.status;
    }
  }
  return { keywords, problems };
}

/** Keywords matching --status (and --keywords, if given). Unknown values stop with a message. */
function selectKeywords(all, status, names) {
  if (status !== "all" && !STATUSES.includes(status)) {
    console.error(`find.js: --status must be tracked, idea, or all (got "${status}").`);
    process.exit(1);
  }
  const wanted = names ? names.split(",").map(clean) : null;
  const unknown = (wanted ?? []).filter((n) => !all.some((k) => k.keyword === n));
  if (unknown.length) {
    console.error(`find.js: not a saved keyword: ${unknown.join(", ")}. Add it first with \`find.js keywords\`.`);
    process.exit(1);
  }
  return all.filter((k) => (status === "all" || k.status === status) && (!wanted || wanted.includes(k.keyword)));
}

function status(app) {
  const keywords = loadKeywords().map((k) => ({
    keyword: k.keyword,
    status: k.status,
    local: k.local,
    missingCountries: app.countries.filter((c) => !k.local?.[c]),
  }));
  console.log(JSON.stringify({ app: { id: app.id, name: app.name, description: app.description ?? "" }, countries: app.countries, competitors: app.competitors, keywords }, null, 2));
}

/**
 * One line per keyword: each country's rank / volume / difficulty, best opportunity first.
 * The local phrase is only shown where it differs from the keyword, which keeps lines short
 * (English-speaking countries would otherwise repeat the same phrase five times).
 */
export function summary(app, keywords, results, limit = 25) {
  // --limit comes from the command line: "0", "-3" or "2.5" must not slice from the end or print
  // "and 0.5 more". Anything that isn't a whole number of 1 or more falls back to the default.
  limit = Math.floor(limit);
  if (!(limit >= 1)) limit = 25;
  const rows = keywords.map((k) => {
    const cells = app.countries.map((c) => results?.entries?.[entryKey(k.keyword, c)]).filter(Boolean);
    const best = Math.max(0, ...cells.map((e) => e.opportunity));
    return { k, cells, best };
  });
  rows.sort((a, b) => b.best - a.best);
  const lines = [];
  for (const { k, cells } of rows.slice(0, limit)) {
    if (!cells.length) {
      lines.push(`${k.keyword} [${k.status}]: not checked yet`);
      continue;
    }
    const parts = cells.map((e) => {
      const star = isSweetSpot(e.volume, e.difficulty) ? "⭐" : "";
      const phrase = e.phrase === k.keyword ? "" : ` ${e.phrase}`;
      return `${flag(e.country)}${phrase} ${e.rank ? `#${e.rank}` : "200+"} v${e.volume} d${e.difficulty}${star}`;
    });
    lines.push(`${k.keyword} [${k.status}]: ${parts.join(" | ")}`);
  }
  if (rows.length > limit) lines.push(`… and ${rows.length - limit} more (lower opportunity). Use --limit to see more.`);
  return lines.join("\n");
}

if (isMain(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      status: { type: "string", default: "all" },
      keywords: { type: "string" },
      countries: { type: "string" },
      limit: { type: "string", default: "25" },
    },
  });
  const app = requireApp();
  const command = positionals[0];

  if (command === "status") {
    status(app);
  } else if (command === "keywords") {
    const { keywords, problems } = mergeKeywords(loadKeywords(), await readStdinJson(), app.countries);
    if (problems.length) {
      console.error(`find.js: nothing saved. Fix these and send the list again:\n- ${problems.join("\n- ")}`);
      process.exit(1);
    }
    writeJson("keywords.json", keywords);
    console.log(`Saved ${keywords.length} keywords (${keywords.filter((k) => k.status === "tracked").length} tracked, ${keywords.filter((k) => k.status === "idea").length} ideas).`);
  } else if (command === "check") {
    const countries = pickCountries(app, values.countries);
    const { todo, missing } = planChecks(selectKeywords(loadKeywords(), values.status, values.keywords), countries);
    if (missing.length) console.log(`Skipped (no local phrase yet, add one with \`find.js keywords\`): ${missing.join(", ")}`);
    const { done, failed, stopped, locked } = await runChecks({ client: createClient(), app, todo });
    if (locked) process.exit(1);
    if (!stopped) console.log(`Done: ${done} checked${failed ? `, ${failed} failed (run again to retry them; finished ones are cached)` : ""}.`);
    if (stopped) process.exit(1);
  } else if (command === "summary") {
    console.log(summary(app, selectKeywords(loadKeywords(), values.status), readJson("results.json", { entries: {} }), Number(values.limit) || 25));
  } else {
    console.error("Usage: find.js status | keywords (JSON on stdin) | check [--status …] [--keywords …] [--countries …] | summary [--status …]");
    process.exit(1);
  }
}
