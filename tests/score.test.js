// Tests for the scoring math (lib/score.js). Pure functions: no network, no files.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalize, hasPhrase, hasAllWords, isPluralOf, sameWord, sameLettersDifferentSpacing, rankOf, targetWeight, sizeScore, volumeScore, difficultyScore, opportunityScore, isSweetSpot,
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
  assert.ok(!hasAllWords("calorie count", "calorie counter"), "a shorter word is a different word");
  assert.ok(hasAllWords("counters of calories", "calorie counter"), "plurals count, in any order");
});

// ---- Plurals ----

test("isPluralOf: the three suffix rules (+s, +es after s/x/z/ch/sh, consonant+y → ies)", () => {
  for (const [plural, singular] of [
    ["calories", "calorie"], ["apps", "app"], ["maps", "map"], ["days", "day"], ["movies", "movie"], ["cafés", "café"],
    ["boxes", "box"], ["glasses", "glass"], ["watches", "watch"], ["dishes", "dish"], ["buses", "bus"], ["quizes", "quiz"],
    ["diaries", "diary"], ["stories", "story"], ["families", "family"],
  ]) {
    assert.ok(isPluralOf(plural, singular), `${plural} is the plural of ${singular}`);
    assert.ok(!isPluralOf(singular, plural), `${singular} is not the plural of ${plural}`);
  }
});

test("isPluralOf: conservative on purpose: no false merges", () => {
  assert.ok(!isPluralOf("news", "new"), "news isn't new + s");
  assert.ok(!isPluralOf("glass", "glas"), "nothing after a word that already ends in s");
  assert.ok(!isPluralOf("fitness", "fitnes"));
  assert.ok(!isPluralOf("has", "ha"), "the singular needs 3+ letters");
  assert.ok(!isPluralOf("les", "le"), "French/Spanish articles don't merge");
  assert.ok(!isPluralOf("los", "lo"));
  assert.ok(!isPluralOf("dies", "dy"), "y → ies needs a 3+ letter singular too");
  assert.ok(!isPluralOf("daies", "day"), "a vowel before y takes plain + s");
  assert.ok(!isPluralOf("gameses", "game"), "only one suffix");
  assert.ok(!isPluralOf("caloriesx", "calorie"));
  assert.ok(!isPluralOf("taxes", "taxi"), "no other spelling changes");
});

test("sameWord: either direction, or equal", () => {
  assert.ok(sameWord("diary", "diaries"));
  assert.ok(sameWord("diaries", "diary"));
  assert.ok(sameWord("box", "box"));
  assert.ok(!sameWord("new", "news"));
  assert.ok(!sameWord("cal", "calorie"));
});

test("hasPhrase: plurals match in either direction, word by word, but stay whole words", () => {
  assert.ok(hasPhrase("best calories counter", "calorie counter"));
  assert.ok(hasPhrase("food diary", "food diaries"), "the phrase can be the plural");
  assert.ok(hasPhrase("lunch boxes for kids", "lunch box"));
  assert.ok(hasPhrase("calories counters", "calorie counter"), "every word may differ");
  assert.ok(!hasPhrase("calories app counter", "calorie counter"), "still consecutive words");
  assert.ok(!hasPhrase("daily news", "daily new"), "news is not new");
  assert.ok(!hasPhrase("new app", "news app"));
  assert.ok(!hasPhrase("calorie counter", "cal"), "still whole words only");
});

test("hasPhrase: { plurals: false } asks for the exact words", () => {
  assert.ok(!hasPhrase("calories counter", "calorie counter", { plurals: false }));
  assert.ok(hasPhrase("calorie counter", "calorie counter", { plurals: false }));
});

test("hasPhrase: Japanese/Chinese/Korean/Thai matching is unchanged (substrings, no plural rule)", () => {
  assert.ok(hasPhrase("カロリー計算アプリ", "カロリー計算"));
  assert.ok(!hasPhrase("カロリー計算", "カロリー計算s"));
  assert.ok(hasPhrase("日记s", "日记"), "substring, exactly as before");
  assert.ok(!hasPhrase("가계부", "가계부들"));
});

test("targetWeight and volume: plurals count like the singular", () => {
  assert.equal(targetWeight(app("Calories Counter"), "calorie counter"), 1);
  assert.equal(targetWeight(app("Food Diaries"), "food diary"), 1);
  assert.equal(targetWeight(app("Counter of Calories"), "calorie counter"), 0.6);
  assert.equal(targetWeight(app("Yazio", 0, "count your calories with our counter"), "calorie counter"), 0.25);
  assert.equal(targetWeight(app("News App"), "new app"), 0, "news stays news");
  const mixed = [...Array.from({ length: 25 }, () => app("Calorie Counter")), ...Array.from({ length: 25 }, () => app("Calories Counter"))];
  assert.equal(volumeScore(mixed, "calorie counter"), 100);
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

// ---- Spacing rule: whole words only ----

test("sameLettersDifferentSpacing: the glued phrase must be whole words of the text, not part of one", () => {
  assert.ok(!sameLettersDifferentSpacing("daily news", "daily new"), "'dailynew' is inside 'dailynews', but 'news' isn't 'new'");
  assert.ok(!sameLettersDifferentSpacing("my kalorienzählers", "kalorienzähler"), "the text's word runs on past the phrase");
  assert.ok(!sameLettersDifferentSpacing("mykalorienzähler", "kalorienzähler"), "the phrase starts inside a word");
  assert.ok(!sameLettersDifferentSpacing("best kalorien zählerapp", "kalorienzähler"), "the last word runs on");
  assert.ok(sameLettersDifferentSpacing("yazio kalorien zähler", "kalorienzähler"), "two words glued");
  assert.ok(sameLettersDifferentSpacing("kalorienzähler app", "kalorien zähler"), "one word split");
  assert.ok(sameLettersDifferentSpacing("food log", "foo dlog"), "any split, as long as both ends line up with words");
  assert.ok(sameLettersDifferentSpacing("x kalo rien zäh ler y", "kalorienzähler"), "many words glued");
  assert.ok(!sameLettersDifferentSpacing("", "kalorienzähler"));
});

test("sameLettersDifferentSpacing: Japanese/Chinese/Korean/Thai keep the plain substring check", () => {
  assert.ok(sameLettersDifferentSpacing("カロリー 計算アプリ", "カロリー計算"), "no word ends to line up with in these scripts");
  assert.ok(sameLettersDifferentSpacing("가계부 앱 추천", "가계부앱추천"));
});

test("targetWeight: 'Daily News' gets nothing for 'daily new'; real spacing differences still get 0.6", () => {
  assert.equal(targetWeight(app("Daily News"), "daily new"), 0);
  assert.equal(targetWeight(app("Daily News"), "daily news"), 1);
  assert.equal(targetWeight(app("Yazio: Kalorien Zähler"), "kalorienzähler"), 0.6);
  assert.equal(targetWeight(app("Kalorienzähler Pro"), "kalorien zähler"), 0.6);
  assert.equal(targetWeight(app("MyKalorienzähler"), "kalorienzähler"), 0, "no longer a match from inside a word");
});
