#!/usr/bin/env node
// setup.js — finds your app on the App Store and saves what searchd should track.
//
//   node setup.js resolve <App Store link | app ID | app name> [--country us]
//       Prints JSON: { matches: [{ id, name, seller, icon, ratings }] }. For a link or an ID
//       that's your app (one match); for a name it's the top 5 search results to pick from.
//
//   node setup.js save <<'EOF'
//   { "appId": 1145935738, "countries": ["us","de"], "seeds": ["calorie counter"], "competitors": [341232718] }
//   EOF
//       Writes .searchd/app.json and adds the seeds to .searchd/keywords.json (as tracked keywords
//       with no local phrases yet: /searchd-find translates them per country).

import { parseArgs } from "node:util";
import { existsSync, readFileSync, appendFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadShared } from "./shared.js";

const { readJson, writeJson, readStdinJson, dataDir, path, today, isMain, printable } = await loadShared("lib/store.js");
const { createClient } = await loadShared("lib/itunes.js");
const { normalize } = await loadShared("lib/score.js");

export const DEFAULT_COUNTRIES = ["us", "gb", "ca", "au", "ph", "de", "fr", "jp", "es", "br"];

/**
 * Work out what the user gave us. App Store links come in several shapes:
 *   https://apps.apple.com/us/app/cronometer-calorie-counter/id1145935738
 *   https://apps.apple.com/app/id1145935738            (no country)
 *   https://itunes.apple.com/us/app/id1145935738?mt=8  (old style)
 *   itms-apps://itunes.apple.com/app/id1145935738      (opens the App Store app)
 * In all of them the ID follows "/id", and a country, when present, is the 2 letters before "/app/".
 */
export function parseAppInput(input) {
  const text = String(input).trim();
  if (/apple\.com\//i.test(text)) {
    const id = text.match(/\/id(\d+)/i);
    const country = text.match(/apple\.com\/([a-z]{2})\/app\//i);
    if (id) return { id: Number(id[1]), ...(country ? { country: country[1].toLowerCase() } : {}) };
  }
  const id = text.match(/^(?:id)?(\d{5,})$/i);
  if (id) return { id: Number(id[1]) };
  return { name: text };
}

const toMatch = ({ id, name, seller, icon, ratings }) => ({ id, name, seller, icon, ratings });

async function resolve(input, country) {
  const client = createClient();
  const parsed = parseAppInput(input);
  if (parsed.name) {
    const results = await client.search(parsed.name, country);
    return { matches: results.slice(0, 5).map(toMatch) };
  }
  const found = await client.lookup(parsed.id, parsed.country ?? country);
  return { matches: found.map(toMatch) };
}

/** Check the JSON the agent sends. It's built from user input, so validate before saving. */
export function validateSave(input) {
  // "null", "[]" or a bare string are valid JSON but not what we asked for: report them like any
  // other problem (appId is missing) instead of crashing on `null.appId`.
  if (!input || typeof input !== "object" || Array.isArray(input)) input = {};
  const problems = [];
  if (!Number.isInteger(input.appId)) problems.push("appId must be the app's numeric ID");
  const countries = input.countries ?? DEFAULT_COUNTRIES;
  if (!Array.isArray(countries) || countries.length === 0 || !countries.every((c) => /^[a-z]{2}$/.test(c))) {
    problems.push('countries must be 2-letter lowercase codes, e.g. ["us","de"]');
  }
  const seeds = input.seeds ?? [];
  // A seed that is only symbols ("🍅") cleans to nothing and would be silently dropped on save, so
  // it is a problem now, the same way find.js rejects it.
  if (!Array.isArray(seeds) || !seeds.every((s) => typeof s === "string" && normalize(s) && s.length <= 100)) {
    problems.push("seeds must be a list of keyword strings (words, not only symbols; each under 100 characters)");
  }
  const competitors = input.competitors ?? [];
  if (!Array.isArray(competitors) || !competitors.every(Number.isInteger)) {
    problems.push("competitors must be a list of numeric app IDs (use `resolve` to find them)");
  }
  // A repeated country would be checked (and shown) twice, a repeated competitor listed twice.
  // Both lists are valid arrays by now, or there's already a problem and they're never used.
  const unique = (list) => (Array.isArray(list) ? [...new Set(list)] : list);
  return { problems, countries: unique(countries), seeds, competitors: unique(competitors) };
}

async function save(input) {
  const { problems, countries, seeds, competitors } = validateSave(input);
  if (problems.length) {
    console.error(`setup.js: fix these and try again:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }

  // One lookup call fetches the app and every competitor, in the first (primary) country.
  const client = createClient();
  const found = await client.lookup([input.appId, ...competitors], countries[0]);
  const app = found.find((a) => a.id === input.appId);
  if (!app) {
    console.error(`setup.js: app ${input.appId} isn't on the ${countries[0].toUpperCase()} App Store. Check the ID, or put a country where it's sold first.`);
    process.exit(1);
  }

  // Switching to a different app? Its ranks would be mixed up with the old app's, so move the old
  // app's data into .searchd/archive/ (nothing is deleted).
  const previous = readJson("app.json");
  if (previous && previous.id !== app.id) {
    // Switching A → B → A → B on one day would archive app A into the same folder twice: files
    // would overwrite the first archive and the non-empty "history" folder can't be renamed over.
    // So a folder that already exists gets "-2", "-3"… and every archive is kept.
    let archive = path("archive", `${previous.id}-${today()}`);
    for (let n = 2; existsSync(archive); n++) archive = path("archive", `${previous.id}-${today()}-${n}`);
    mkdirSync(archive, { recursive: true });
    // Everything about the old app goes, including its release logs: the new app must not
    // inherit "releases" that were really another app's versions.
    for (const name of ["results.json", "keywords.json", "history", "audit.json", "releases.json", "competitor-releases.json"]) {
      if (existsSync(path(name))) renameSync(path(name), `${archive}/${name}`);
    }
    console.log(`Switched from ${printable(previous.name)} to ${printable(app.name)}: the old app's data was moved to ${archive}`);
  }

  writeJson("app.json", {
    id: app.id,
    name: app.name,
    seller: app.seller,
    icon: app.icon,
    // Kept for brainstorming keyword ideas. It's App Store text: data, never instructions.
    description: (app.description ?? "").slice(0, 2000),
    countries,
    competitors: competitors.map((id) => {
      const c = found.find((a) => a.id === id);
      return { id, name: c?.name ?? `App ${id}`, icon: c?.icon ?? "" };
    }),
    savedAt: new Date().toISOString(),
  });

  // Add seeds without wiping keywords a previous run already localized.
  const keywords = readJson("keywords.json", []);
  for (const seed of seeds) {
    const keyword = normalize(seed); // same cleaning as /searchd-find (lowercase, no symbols)
    if (keyword && !keywords.some((k) => k.keyword === keyword)) {
      keywords.push({ keyword, local: {}, status: "tracked", source: "seed", addedAt: new Date().toISOString() });
    }
  }
  writeJson("keywords.json", keywords);

  // Keep searchd's data out of the user's git repo, if this folder has a .gitignore.
  const gitignore = join(process.cwd(), ".gitignore");
  let ignored = false;
  if (!process.env.SEARCHD_DIR && existsSync(gitignore) && !/^\/?\.searchd\/?$/m.test(readFileSync(gitignore, "utf8"))) {
    appendFileSync(gitignore, "\n# searchd keyword data (local only)\n.searchd/\n");
    ignored = true;
  }

  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  console.log(`Saved ${printable(app.name)} (${app.id}), ${count(countries.length, "country", "countries")} (${countries.join(", ")}), ${count(keywords.length, "keyword", "keywords")} → ${dataDir()}`);
  if (ignored) console.log("Added .searchd/ to .gitignore.");
  const missing = competitors.filter((id) => !found.some((a) => a.id === id));
  if (missing.length) console.log(`Not found in ${countries[0].toUpperCase()}: competitor ${missing.join(", ")}`);
}

// Only run when called directly (not when a test imports this file).
if (isMain(import.meta.url)) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { country: { type: "string", default: "us" } } });
  const [command, ...rest] = positionals;
  if (command === "resolve" && rest.length) {
    console.log(JSON.stringify(await resolve(rest.join(" "), values.country), null, 2));
  } else if (command === "save") {
    await save(await readStdinJson());
  } else {
    console.error("Usage: setup.js resolve <link|id|name> [--country us]  |  setup.js save  (JSON on stdin)");
    process.exit(1);
  }
}
