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

/** Does `text` contain `phrase` as whole words? Both must already be normalized. */
export function hasPhrase(text, phrase) {
  if (!phrase) return false;
  if (NO_SPACE_SCRIPTS.test(phrase)) return text.includes(phrase);
  // Padding with spaces makes "cal" NOT match inside "calorie", but "calorie" match anywhere.
  return ` ${text} `.includes(` ${phrase} `);
}

/** Does `text` contain every word of `phrase`, in any order? */
export function hasAllWords(text, phrase) {
  const words = phrase.split(" ").filter(Boolean);
  return words.length > 0 && words.every((word) => hasPhrase(text, word));
}

/**
 * German, Dutch, Swedish… glue words together ("kalorienzähler") while app names often keep them
 * apart ("Kalorien Zähler"), or the other way round. Compare with all spaces removed. We only do
 * this for phrases of 6+ letters, so a short word like "pal" can't match inside "mypal".
 */
export function sameLettersDifferentSpacing(text, phrase) {
  const squashed = phrase.replace(/ /g, "");
  return squashed.length >= 6 && text.replace(/ /g, "").includes(squashed);
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
 *   1.00  the exact phrase is in the name           ("Calorie Counter by fatsecret")
 *   0.60  every word is in the name, but split up    ("Counter of Calories"), or the same
 *         letters with different spacing ("Kalorien Zähler" for "kalorienzähler")
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
