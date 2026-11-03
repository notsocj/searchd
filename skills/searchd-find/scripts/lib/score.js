// score.js — turns one App Store search result list into searchd's numbers.
//
// Apple doesn't publish search volumes or difficulty, so these are ESTIMATES built from
// what a search returns. Each one is explained where it's computed. They're pure functions
// (no network, no files) so they're easy to test and easy to tweak.

/**
 * Lowercase, normalize Unicode, and turn punctuation into spaces, so that
 * "Lose It! – Calorie Counter" and "lose it calorie counter" compare equal.
 */
export function normalize(text) {
  // \p{P} = punctuation, \p{S} = symbols (™, ®, emoji…), in every script. We strip them BEFORE
  // NFKC too, because NFKC turns "™" into the letters "TM" ("Counter™" would become "countertm").
  // Emoji drag invisible helpers along: a variation selector (U+FE0F in "❤️"), a zero-width joiner
  // (U+200D in "👨‍👩‍👧") or a keycap mark (U+20E3 in "1️⃣"). They aren't symbols, so each symbol
  // takes the helpers that follow it; otherwise "❤️" would survive as an invisible "word" that
  // passes the "keyword is only symbols" check and stops "❤️Love" matching "love".
  const strip = (t) => t.replace(/(?:[\p{P}\p{S}][︀-️‍⃣]*)+/gu, " ");
  return strip(
    strip(String(text ?? ""))
      // NFKC folds look-alike characters together (full-width "Ａ" → "A", "ﬁ" → "fi").
      .normalize("NFKC")
      .toLowerCase()
  )
    .replace(/\s+/g, " ")
    .trim();
}

// Japanese, Chinese, Korean and Thai don't put spaces between words, so "whole word" matching
// can't work there. For phrases in those scripts we fall back to a plain substring match.
const NO_SPACE_SCRIPTS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

// ---- Plurals ----
// An app called "Calorie Counter" targets the search "calories counter" as much as "calorie
// counter" does, so word matching treats simple English plurals as the same word. This is a small
// suffix rule on purpose, not a stemmer: a stemmer also merges words that mean different things
// ("universe"/"university"), and a wrong merge inflates volume quietly. The rule only ever compares
// TWO words ("is one the plural of the other?"); it never rewrites a word on its own.

// The singular must have 3+ letters. That keeps "app"/"apps" and "map"/"maps", but stops short
// words from merging: "us"/"u", "has"/"ha", "his"/"hi", and the French/Spanish articles
// "les"/"le", "des"/"de", "los"/"lo".
const MIN_SINGULAR = 3;

// Words that end like a plural but aren't one of the shorter word next to them.
const NOT_PLURALS = new Set(["news"]); // "news" isn't "new" + s

/**
 * Is `plural` a simple English plural of `singular`? Three patterns:
 *   + s     calorie → calories, app → apps, day → days, movie → movies
 *   + es    after s, x, z, ch, sh: box → boxes, glass → glasses, watch → watches
 *   y → ies after a consonant: diary → diaries, story → stories ("day" → "days" is the + s rule)
 */
export function isPluralOf(plural, singular) {
  if (singular.length < MIN_SINGULAR || NOT_PLURALS.has(plural)) return false;
  // Not after a word that already ends in "s": "glass" isn't the plural of "glas" (German for glass),
  // and "fitness" isn't the plural of "fitnes".
  if (plural === singular + "s") return !singular.endsWith("s");
  if (plural === singular + "es") return /(?:s|x|z|ch|sh)$/.test(singular);
  if (/[^aeiou]y$/.test(singular)) return plural === singular.slice(0, -1) + "ies";
  return false;
}

/** Same word, or one is the simple plural of the other ("diary" = "diaries", "new" ≠ "news"). */
export function sameWord(a, b) {
  return a === b || isPluralOf(a, b) || isPluralOf(b, a);
}

/**
 * Does `text` contain `phrase` as whole words? Both must already be normalized.
 * Simple plurals count as the same word ("calories counter" contains "calorie counter"), unless
 * `{ plurals: false }` asks for the exact words (the audit's "already in the name" check does).
 */
export function hasPhrase(text, phrase, { plurals = true } = {}) {
  if (!phrase) return false;
  // Plurals stay off for these scripts: there are no spaces to find word endings with, and
  // their plurals don't work like English ones anyway.
  if (NO_SPACE_SCRIPTS.test(phrase)) return text.includes(phrase);
  // Padding with spaces makes "cal" NOT match inside "calorie", but "calorie" match anywhere.
  // This exact check is also the fast path: most matches are exact, and it's one string search.
  if (` ${text} `.includes(` ${phrase} `)) return true;
  if (!plurals) return false;
  // Slide the phrase's words along the text's words; each pair must be the same word or a plural.
  // Both are normalized, so words are separated by exactly one space.
  const want = phrase.split(" ");
  const words = text.split(" ");
  for (let i = 0; i + want.length <= words.length; i++) {
    if (want.every((word, j) => sameWord(words[i + j], word))) return true;
  }
  return false;
}

/** Does `text` contain every word of `phrase`, in any order? (Plurals count, as in hasPhrase.) */
export function hasAllWords(text, phrase) {
  const words = phrase.split(" ").filter(Boolean);
  return words.length > 0 && words.every((word) => hasPhrase(text, word));
}

/**
 * German, Dutch, Swedish… glue words together ("kalorienzähler") while app names often keep them
 * apart ("Kalorien Zähler"), or the other way round. So: does the phrase, with its spaces removed,
 * equal one or more WHOLE words of the text glued together?
 *   "kalorienzähler" vs "yazio kalorien zähler"  → "kalorien" + "zähler"  ✓
 *   "kalorien zähler" vs "kalorienzähler"        → "kalorienzähler"       ✓
 *   "daily new" vs "daily news"                  → "daily" + "news" is "dailynews", not "dailynew" ✗
 * The whole-word part matters: squashing the text too and searching inside it found "dailynew"
 * inside "dailynews", so "Daily News" got partial credit for "daily new".
 * It needs 6+ letters, so short coincidences ("my pal" for "mypal") don't count.
 * Plurals don't apply here: glued words are compared letter for letter.
 * Japanese, Chinese, Korean and Thai have no spaces to mark where words end, so for them it stays
 * a plain substring check of the squashed text.
 */
export function sameLettersDifferentSpacing(text, phrase) {
  const squashed = phrase.replace(/ /g, "");
  if (squashed.length < 6) return false;
  if (NO_SPACE_SCRIPTS.test(phrase)) return text.replace(/ /g, "").includes(squashed);
  const words = text.split(" ");
  for (let start = 0; start < words.length; start++) {
    // Glue words from `start` onward while they still spell the beginning of the phrase.
    let glued = "";
    for (let end = start; end < words.length; end++) {
      glued += words[end];
      if (glued === squashed) return true;
      if (!squashed.startsWith(glued)) break; // went off track: try the next starting word
    }
  }
  return false;
}

/**
 * RANK: where the app appears in Apple's results (1 = first). null means it wasn't in the
 * results at all; we show that as "200+" because the API returns at most 200 apps.
 */
export function rankOf(results, appId) {
  const index = results.findIndex((app) => String(app.id) === String(appId));
  return index === -1 ? null : index + 1;
}

/**
 * How strongly one app "targets" a phrase. Developers put the keywords they care about most in
 * the app NAME (the field Apple weighs most), so:
 * (Simple plurals count as the same word at every level: "Calories Counter" is 1.00 for
 * "calorie counter". See isPluralOf above.)
 *   1.00  the exact phrase is in the name           ("Calorie Counter by fatsecret")
 *   0.60  every word is in the name, but split up    ("Counter of Calories"), or the same
 *         whole words with different spacing ("Kalorien Zähler" for "kalorienzähler")
 *   0.25  only the description mentions all the words
 *   0     none of the above (Apple matched it some other way, e.g. the hidden keyword field)
 */
export function targetWeight(app, phrase) {
  const name = normalize(app.name);
  if (hasPhrase(name, phrase)) return 1;
  if (hasAllWords(name, phrase) || sameLettersDifferentSpacing(name, phrase)) return 0.6;
  if (hasAllWords(normalize(app.description), phrase)) return 0.25;
  return 0;
}

/**
 * VOLUME (0–100): a DEMAND PROXY, not a real search count.
 *
 * The idea: developers chase searches that people actually type. If most of the top 50 apps
 * put a phrase in their name, lots of developers decided it's worth ranking for, which usually
 * means real demand. If almost none do, people probably don't search for it that way.
 * Also, a phrase with only 12 results can't score high, because we always divide by 50:
 * few apps at all is itself a sign of a niche search.
 *
 * score = (sum of targetWeight over the top 50) / 50 × 100
 */
export function volumeScore(results, phrase) {
  const p = normalize(phrase);
  const top = results.slice(0, 50);
  const total = top.reduce((sum, app) => sum + targetWeight(app, p), 0);
  return Math.round((total / 50) * 100);
}

// About 1,000,000 ratings means "giant" → 100.
const GIANT_RATINGS = 1_000_000;

/** One app's size on a 0–100 log scale: ~10 ratings → 17, ~1,000 → 50, ~1,000,000 → 100. */
export function sizeScore(ratings) {
  const score = (Math.log10((ratings || 0) + 1) / Math.log10(GIANT_RATINGS + 1)) * 100;
  return Math.min(100, Math.max(0, score));
}

/**
 * DIFFICULTY (0–100): how hard it is to break into the top 10.
 *
 * Rating counts are the best public signal of how big (and well-optimized) an app is.
 * We give each of the top 10 apps a LOG-scaled size score (sizeScore above), because going from
 * 100 → 1,000 ratings matters as much as 100,000 → 1,000,000. Then we average those scores.
 *
 * Why average the log scores instead of averaging the raw rating counts first? One giant would
 * dominate a raw average: MyFitnessPal's 2.3M ratings alone make any top 10 look "impossible",
 * even when the other nine apps have 3–400 ratings and are easy to pass. Averaging the log scores
 * says "how big is a typical top-10 app", which is what you have to beat.
 *
 * We always divide by 10, even if there are fewer results: empty slots count as 0,
 * because a search with only 3 apps is easy to break into.
 */
export function difficultyScore(results) {
  const total = results.slice(0, 10).reduce((sum, app) => sum + sizeScore(app.ratings), 0);
  return Math.round(total / 10);
}

/**
 * OPPORTUNITY (0–100): volume, discounted by difficulty. A keyword with volume 60 and
 * difficulty 25 scores 45; volume 60 with difficulty 90 scores 6.
 */
export function opportunityScore(volume, difficulty) {
  return Math.round((volume * (100 - difficulty)) / 100);
}

// "Sweet spot" keywords for brainstorm ideas: real demand, beatable competition.
export const SWEET_SPOT = { minVolume: 20, maxDifficulty: 55 };

export function isSweetSpot(volume, difficulty) {
  return volume >= SWEET_SPOT.minVolume && difficulty <= SWEET_SPOT.maxDifficulty;
}
