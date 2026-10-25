// Tests for the scoring math (lib/score.js). Pure functions: no network, no files.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalize, hasPhrase, hasAllWords, sameLettersDifferentSpacing, rankOf, targetWeight, sizeScore, volumeScore, difficultyScore, opportunityScore, isSweetSpot,
} from "../skills/searchd-find/scripts/lib/score.js";

const app = (name, ratings = 0, description = "") => ({ id: Math.random(), name, ratings, description });

test("normalize folds case, punctuation and symbols", () => {
  assert.equal(normalize("Lose It! – Calorie Counter™"), "lose it calorie counter");
  assert.equal(normalize("ＡＢＣ"), "abc"); // full-width letters
});

test("hasPhrase matches whole words only, but substrings in Japanese", () => {
  assert.ok(hasPhrase("calorie counter app", "calorie counter"));
  assert.ok(!hasPhrase("calorie counter app", "cal"));
  assert.ok(hasPhrase("カロリー計算アプリ", "カロリー計算"));
});

test("rankOf is 1-based and null when missing", () => {
  const results = [{ id: 5 }, { id: 7 }];
  assert.equal(rankOf(results, 7), 2);
  assert.equal(rankOf(results, "5"), 1); // IDs may arrive as strings
  assert.equal(rankOf(results, 9), null);
});

test("targetWeight: exact name > all words in name / compound > description > nothing", () => {
  assert.equal(targetWeight(app("Calorie Counter by fatsecret"), "calorie counter"), 1);
  assert.equal(targetWeight(app("Counter of Calorie"), "calorie counter"), 0.6);
  assert.equal(targetWeight(app("Yazio: Kalorien Zähler"), "kalorienzähler"), 0.6);
  assert.equal(targetWeight(app("Yazio", 0, "the best calorie counter"), "calorie counter"), 0.25);
  assert.equal(targetWeight(app("Yazio"), "calorie counter"), 0);
});

test("volume divides by 50, so few results can't score high", () => {
  const exact = Array.from({ length: 50 }, () => app("Calorie Counter"));
  assert.equal(volumeScore(exact, "Calorie Counter"), 100);
  assert.equal(volumeScore(exact.slice(0, 5), "calorie counter"), 10);
  assert.equal(volumeScore([], "calorie counter"), 0);
});

test("difficulty uses the average LOG size, so one giant doesn't make it impossible", () => {
  const giants = Array.from({ length: 10 }, () => app("x", 1_000_000));
  assert.equal(difficultyScore(giants), 100);
  const oneGiant = [app("x", 2_000_000), ...Array.from({ length: 9 }, () => app("y", 10))];
  assert.ok(difficultyScore(oneGiant) < 30, "nine tiny apps keep it easy");
  assert.equal(difficultyScore([app("x", 1_000_000)]), 10, "empty slots count as 0");
});

test("opportunity and sweet spot", () => {
  assert.equal(opportunityScore(60, 25), 45);
  assert.ok(isSweetSpot(54, 54));
  assert.ok(!isSweetSpot(78, 78));
});

// ---- Edge cases (hardening) ----

test("normalize: empty, missing and non-string input never throws", () => {
  assert.equal(normalize(""), "");
  assert.equal(normalize(null), "");
  assert.equal(normalize(undefined), "");
  assert.equal(normalize(123), "123");
  assert.equal(normalize("   \t\n  "), "");
});

test("normalize: mixed case, extra spaces, tabs and no-break spaces collapse to single spaces", () => {
  assert.equal(normalize("  CaLoRiE\u00a0\t  CoUnTeR \n"), "calorie counter");
});

test("normalize: '|' (the keyword|country separator) can never survive", () => {
  assert.equal(normalize("a|b"), "a b");
  assert.ok(!normalize("|||x||").includes("|"));
  assert.equal(normalize("||"), "");
});

test("normalize: emoji, including ones with variation selectors or joiners, leave nothing behind", () => {
  assert.equal(normalize("🍅 Focus"), "focus");
  assert.equal(normalize("🍅🍅"), "");
  assert.equal(normalize("❤️"), "", "a heart + variation selector is only a symbol");
  assert.equal(normalize("❤️Love Timer"), "love timer", "the selector must not glue itself to the word");
  assert.equal(normalize("👨\u200d👩\u200d👧 family"), "family", "zero-width joiners in emoji sequences");
  assert.equal(normalize("👍🏽 like"), "like", "skin tones");
  assert.equal(normalize("🇩🇪 Berlin"), "berlin", "flags");
});

test("normalize: letters from other scripts and accents are kept", () => {
  assert.equal(normalize("Kalorienzähler"), "kalorienzähler");
  assert.equal(normalize("cafe\u0301"), "café", "a combining accent is composed (NFKC)");
  assert.equal(normalize("カロリー計算"), "カロリー計算");
  assert.equal(normalize("ＡＰＰ　ＳＴＯＲＥ"), "app store", "full-width letters and the ideographic space");
});

test("normalize: is idempotent and copes with a huge input", () => {
  for (const text of ["Lose It! – Calorie Counter™", "❤️Love|Timer", "ＡＢＣ  d"]) assert.equal(normalize(normalize(text)), normalize(text));
  const huge = "word! ".repeat(200_000);
  assert.equal(normalize(huge).length, 4 * 200_000 + 199_999); // 200k words of 4 letters, 199,999 single spaces
});

test("hasPhrase / hasAllWords: empty phrases never match", () => {
  assert.ok(!hasPhrase("anything", ""));
  assert.ok(!hasAllWords("anything", ""));
  assert.ok(!hasAllWords("anything", "   "));
});

test("hasAllWords: any order, but every word must be a whole word", () => {
  assert.ok(hasAllWords("counter of calorie", "calorie counter"));
  assert.ok(!hasAllWords("calories counter", "calorie counter"), "plurals are different words");
});

test("sameLettersDifferentSpacing needs 6+ letters", () => {
  assert.ok(sameLettersDifferentSpacing("kalorien zähler", "kalorienzähler"));
  assert.ok(sameLettersDifferentSpacing("abc def", "abcdef"), "exactly 6 letters counts");
  assert.ok(!sameLettersDifferentSpacing("my pal", "pal"));
  assert.ok(!sameLettersDifferentSpacing("ab cde", "abcde"), "5 letters is too short");
  assert.ok(!sameLettersDifferentSpacing("anything", ""));
});

test("rankOf: ties take the first match, and empty or id-less lists give null", () => {
  assert.equal(rankOf([{ id: 1 }, { id: 1 }], 1), 1);
  assert.equal(rankOf([], 1), null);
  assert.equal(rankOf([{ name: "no id" }], 1), null);
});

test("targetWeight: apps with missing name or description, and empty phrases, score 0", () => {
  assert.equal(targetWeight({}, "calorie counter"), 0);
  assert.equal(targetWeight({ name: "Calorie Counter" }, ""), 0);
  assert.equal(targetWeight({ name: "Calorie Counter" }, "calorie counter"), 1);
});

test("sizeScore: zero, missing, NaN and absurdly large rating counts stay inside 0-100", () => {
  assert.equal(sizeScore(0), 0);
  assert.equal(sizeScore(undefined), 0);
  assert.equal(sizeScore(NaN), 0);
  assert.equal(sizeScore(Infinity), 100);
  assert.equal(sizeScore(1e12), 100);
  assert.equal(Math.round(sizeScore(1_000_000)), 100);
  assert.equal(Math.round(sizeScore(10)), 17);
  assert.equal(Math.round(sizeScore(1000)), 50);
});

test("volumeScore: only the top 50 count, and the result is always a whole number 0-100", () => {
  const exact = Array.from({ length: 80 }, () => app("Calorie Counter"));
  assert.equal(volumeScore(exact, "calorie counter"), 100, "results 51-80 add nothing");
  const mixed = [...exact.slice(0, 25), ...Array.from({ length: 25 }, () => app("Other"))];
  assert.equal(volumeScore(mixed, "calorie counter"), 50);
  assert.equal(volumeScore(exact, ""), 0, "an empty phrase matches nothing");
  assert.equal(volumeScore([app("Calorie Counter")], "Calorie  Counter!"), 2, "the phrase is normalized too");
});

test("difficultyScore: apps without ratings count as 0, extra results past 10 are ignored", () => {
  assert.equal(difficultyScore([]), 0);
  assert.equal(difficultyScore([{}, { ratings: null }, { ratings: undefined }]), 0);
  const eleven = [...Array.from({ length: 10 }, () => app("x", 0)), app("giant", 1_000_000)];
  assert.equal(difficultyScore(eleven), 0, "the 11th app is outside the top 10");
});

test("opportunityScore: bounds, rounding, and the sweet-spot edges", () => {
  assert.equal(opportunityScore(0, 100), 0);
  assert.equal(opportunityScore(100, 0), 100);
  assert.equal(opportunityScore(100, 100), 0);
  assert.equal(opportunityScore(33, 50), 17, "16.5 rounds up");
  assert.ok(isSweetSpot(20, 55), "both limits are inclusive");
  assert.ok(!isSweetSpot(19, 55));
  assert.ok(!isSweetSpot(20, 56));
  assert.ok(!isSweetSpot(NaN, 10));
});
