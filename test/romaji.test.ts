import assert from "node:assert/strict";
import test from "node:test";
import { searchReadings } from "../src/common/romaji.js";

test("spaced negative copulas retain literal and grammatical particle spellings", () => {
  for (const query of ["shizuka dewa arimasen deshita", "shizuka\tdewa\u00a0arimasen　deshita"]) {
    const readings = searchReadings(query);
    for (const reading of ["しずかでわありませんでした", "しずかではありませんでした", "シズカデワアリマセンデシタ", "シズカデハアリマセンデシタ"]) {
      assert.ok(readings.includes(reading), `${query}: ${reading}`);
    }
  }
});

test("romaji readings preserve syllable boundaries before removing Unicode whitespace", () => {
  for (const query of ["benkyou  shimashita", "benkyou\tshimashita", "benkyou　shimashita", "ＢＥＮＫＹＯＵ　ＳＨＩＭＡＳＨＩＴＡ"]) {
    assert.ok(searchReadings(query).includes("べんきょうしました"), query);
  }
  assert.ok(searchReadings("shin ai").includes("しんあい"));
  assert.ok(!searchReadings("shin ai").includes("しない"));
  assert.ok(searchReadings("shizukadewanakatta").includes("しずかではなかった"));
  assert.ok(searchReadings("konnichiha").includes("こんにちは"));
  assert.ok(searchReadings("matcha").includes("まっちゃ"));
  assert.ok(searchReadings("kan'i").includes("かんい"));
  assert.ok(searchReadings("agua").includes("あぐあ"));
  for (const query of ["", "   ", "hello", "water", "arm hair", "食べる", "taberu1"]) {
    assert.deepEqual(searchReadings(query), [], query);
  }
});
