// Where the lookup card sits relative to the word under the cursor.
//
// The one rule: never sit in the reading flow. A card beside a word in
// horizontal text covers the rest of the sentence — the words the reader is
// heading towards — so horizontal lookups go below (or above), and vertical
// ones go beside the column. Pure geometry, so it can be tested without a
// layout engine; `popup.ts` does the measuring and the style writing.

export type Rect = { left: number; right: number; top: number; bottom: number; width: number; height: number };
export type Size = { width: number; height: number };
export type Placement = { left: number; top: number; maxHeight: number | null };

// Floor for the squeezed-card height: below this the card is unreadable, so we
// let it overlap rather than shrink it to a sliver.
const MIN_HEIGHT = 160;

export function placeCard(opts: {
  rect: Rect; // the word itself — what we align to
  avoid: Rect; // what we must clear: the word, or the whole caption line
  size: Size; // the card's natural size
  view: Size; // the viewport
  vertical: boolean; // is the text laid out top-to-bottom?
  margin?: number;
}): Placement {
  const { rect, avoid, size, view, vertical } = opts;
  const margin = opts.margin ?? 12;
  const clampLeft = (value: number): number => clamp(value, margin, view.width - size.width - margin);

  if (vertical) {
    // Tategaki runs top to bottom, so above/below buries the column. Sit beside
    // it, preferring the left: `vertical-rl` columns advance leftwards, so the
    // left holds text already read. Fall back to whichever side has more room.
    const roomLeft = avoid.left - margin * 2;
    const roomRight = view.width - avoid.right - margin * 2;
    const onLeft = roomLeft >= size.width || roomLeft >= roomRight;
    return {
      left: clampLeft(onLeft ? avoid.left - size.width - margin : avoid.right + margin),
      top: clamp(rect.top, margin, view.height - size.height - margin),
      maxHeight: null,
    };
  }

  // Horizontal text: stay on the block axis. Below by default, above when below
  // can't hold the card. When neither can, cap the height so the body scrolls
  // rather than spilling back over the line.
  const roomBelow = view.height - avoid.bottom - margin * 2;
  const roomAbove = avoid.top - margin * 2;
  const below = size.height <= roomBelow || roomBelow >= roomAbove;
  const room = Math.max(below ? roomBelow : roomAbove, MIN_HEIGHT);
  const height = Math.min(size.height, room);

  return {
    // Align to whichever edge of the word keeps the card on screen.
    left: clampLeft(rect.left + rect.width / 2 < view.width / 2 ? rect.left : rect.right - size.width),
    top: clamp(below ? avoid.bottom + margin : avoid.top - height - margin, margin, view.height - height - margin),
    maxHeight: height < size.height ? height : null,
  };
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));
