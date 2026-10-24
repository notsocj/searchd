// shared.js — loads searchd's shared code from the sibling searchd-find folder.
//
// searchd ships as five skills installed side by side:
//
//   skills/
//   ├── searchd-setup/
//   ├── searchd-find/    ← holds the shared lib/ (API client, scoring, storage)
//   ├── searchd-track/
//   ├── searchd-audit/
//   └── searchd-dashboard/
//
// The other skills reuse searchd-find's code instead of keeping their own copy. If someone
// installed only one folder, the import would fail with a confusing Node error, so we check
// first and print a clear message instead.
//
// Why a function instead of a normal `import` at the top of the file? Normal imports run
// BEFORE any of our code, so we'd never get the chance to check. `await import()` runs only
// when we call it, after the check.
//
// (searchd-track, searchd-audit and searchd-dashboard have identical copies of this file.
// It can't itself be shared, for the same reason it exists.)

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SIBLING_MESSAGE =
  "searchd: install all five skills together (searchd-setup, searchd-find, searchd-track, searchd-audit, searchd-dashboard): npx skills add https://github.com/notsocj/searchd --skill  (see README).";

// ../../searchd-find/scripts/ relative to THIS file (not to wherever the user ran node from).
const SHARED_ROOT = new URL("../../searchd-find/scripts/", import.meta.url);

/** Import a shared module, e.g. await loadShared("lib/store.js"). Exits if searchd-find is missing. */
export async function loadShared(relativePath) {
  if (!existsSync(fileURLToPath(new URL("lib/store.js", SHARED_ROOT)))) {
    console.error(SIBLING_MESSAGE);
    process.exit(1);
  }
  return import(new URL(relativePath, SHARED_ROOT).href);
}
