import assert from "node:assert/strict";
import test from "node:test";
import { placeCard, type Rect } from "shirabe-sdk/word-card/placement.js";

const rect = (left: number, top: number, width: number, height: number): Rect =>
  ({ left, top, width, height, right: left + width, bottom: top + height });

const VIEW = { width: 1000, height: 800 };
const CARD = { width: 360, height: 400 };

test("a horizontal lookup drops below the word, never beside it", () => {
  const word = rect(100, 100, 40, 20);
  const place = placeCard({ rect: word, avoid: word, size: CARD, view: VIEW, vertical: false });

  assert.equal(place.top, 132); // clears the word by the 12px margin
  assert.equal(place.left, 100); // aligned to the word's left edge, not offset to a side
  assert.equal(place.maxHeight, null);
  // The rest of the sentence runs to the right of the word: the card must not reach it.
  assert.ok(place.top >= word.bottom, "card overlaps the line it was looked up from");
});

test("a horizontal lookup near the foot of the viewport flips above the word", () => {
  const word = rect(100, 700, 40, 20);
  const place = placeCard({ rect: word, avoid: word, size: CARD, view: VIEW, vertical: false });

  assert.equal(place.top, 288);
  assert.ok(place.top + CARD.height <= word.top, "flipped card still covers the line");
});

test("when neither side of the line can hold the card, it is capped rather than spilled over the line", () => {
  const view = { width: 1000, height: 500 };
  const card = { width: 360, height: 460 };
  const word = rect(100, 200, 40, 20);
  const place = placeCard({ rect: word, avoid: word, size: card, view, vertical: false });

  assert.equal(place.maxHeight, 256); // the room below, so the body scrolls
  assert.ok(place.top >= word.bottom, "capped card still overlaps the line");
  assert.ok(place.top + place.maxHeight! <= view.height, "capped card runs off the viewport");
});

test("a card squeezed past the readable floor overlaps the page rather than the word", () => {
  const view = { width: 1000, height: 400 };
  const word = rect(100, 180, 40, 40);
  const place = placeCard({ rect: word, avoid: word, size: { width: 360, height: 460 }, view, vertical: false });

  assert.equal(place.maxHeight, 160); // MIN_HEIGHT: shrinking further is unreadable
  assert.ok(place.top >= word.bottom, "squeezed card covers the word itself");
});

test("a subtitle lookup clears the whole caption line, not just the word", () => {
  const word = rect(480, 620, 40, 24);
  const caption = rect(200, 610, 600, 44);
  const place = placeCard({ rect: word, avoid: caption, size: { width: 360, height: 100 }, view: VIEW, vertical: false });

  assert.ok(place.top >= caption.bottom, "card covers the rest of the caption");
});

test("a vertical lookup sits beside the column, preferring the already-read left", () => {
  const column = rect(600, 100, 40, 300);
  const place = placeCard({ rect: column, avoid: column, size: CARD, view: VIEW, vertical: true });

  assert.equal(place.left, 228);
  assert.equal(place.top, 100); // aligned to the character, not pushed above or below it
  // vertical-rl advances leftwards, so the card must not sit where the text is heading.
  assert.ok(place.left + CARD.width <= column.left, "card overlaps the column being read");
});

test("a vertical lookup with no room on the left flips to the right", () => {
  const column = rect(100, 100, 40, 300);
  const place = placeCard({ rect: column, avoid: column, size: CARD, view: VIEW, vertical: true });

  assert.equal(place.left, 152);
  assert.ok(place.left >= column.right, "flipped card overlaps the column");
});

test("a vertical lookup with no room either side takes the wider gap", () => {
  const column = rect(300, 100, 400, 300);
  const place = placeCard({ rect: column, avoid: column, size: CARD, view: VIEW, vertical: true });

  assert.equal(place.left, 12); // clamped into the left gap, the wider of the two
});
