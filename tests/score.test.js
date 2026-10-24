// Tests for the scoring math (lib/score.js). Pure functions: no network, no files.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalize, hasPhrase, rankOf, targetWeight, volumeScore, difficultyScore, opportunityScore, isSweetSpot,
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
