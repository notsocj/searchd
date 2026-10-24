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
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { loadShared } from "./shared.js";

const { readJson, writeJson, readStdinJson, dataDir, isMain } = await loadShared("lib/store.js");
const { createClient } = await loadShared("lib/itunes.js");

export const DEFAULT_COUNTRIES = ["us", "gb", "ca", "au", "ph", "de", "fr", "jp", "es", "br"];

/**
 * Work out what the user gave us. App Store links look like
 *   https://apps.apple.com/us/app/cronometer-calorie-counter/id1145935738
 * so the country is the first path part and the ID follows "id".
 */
export function parseAppInput(input) {
  const text = String(input).trim();
  const link = text.match(/apps\.apple\.com\/([a-z]{2})\/.*?id(\d+)/i);
  if (link) return { id: Number(link[2]), country: link[1].toLowerCase() };
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
  const problems = [];
  if (!Number.isInteger(input.appId)) problems.push("appId must be the app's numeric ID");
  const countries = input.countries ?? DEFAULT_COUNTRIES;
  if (!Array.isArray(countries) || countries.length === 0 || !countries.every((c) => /^[a-z]{2}$/.test(c))) {
    problems.push('countries must be 2-letter lowercase codes, e.g. ["us","de"]');
  }
  const seeds = input.seeds ?? [];
  if (!Array.isArray(seeds) || !seeds.every((s) => typeof s === "string" && s.trim() && s.length <= 100)) {
    problems.push("seeds must be a list of keyword strings (each under 100 characters)");
  }
  const competitors = input.competitors ?? [];
  if (!Array.isArray(competitors) || !competitors.every(Number.isInteger)) {
    problems.push("competitors must be a list of numeric app IDs (use `resolve` to find them)");
  }
  return { problems, countries, seeds, competitors };
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
    const keyword = seed.trim().toLowerCase();
    if (!keywords.some((k) => k.keyword === keyword)) {
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

  console.log(`Saved ${app.name} (${app.id}), ${countries.length} countries, ${keywords.length} keywords → ${dataDir()}`);
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
