/**
 * The hall of the demo "service point", in metres: the model walks people
 * to these points, and the scene draws the hall around them. The plane is
 * the model's x, y (docs/ARCHITECTURE.md, "Показ"): x to the right, y into
 * the hall, from the entrance wall (y = 0) to the windows (y = depth).
 *
 *       windows 0 … 7 along the far wall
 *     ┌───────────────────────────────┐
 *     │  ▢  ▢  ▢  ▢  ▢  ▢  ▢  ▢        │ exit ▶
 *     │      ← ← ← ← ← ← ← head        │
 *     │      → → → → → → → ↑          │
 *     │      ← ← ← ← ← ← ← ←  the line │
 *   ▶ entrance                         │
 *     └───────────────────────────────┘
 */
import type { Point } from '@mozaika/kernel';

export const HALL = { width: 24, depth: 16 } as const;

/** Most windows the hall has; the model opens as many as its parameter says, from the left. */
export const MAX_WINDOWS = 8;

const WINDOWS = { firstX: 3, spacing: 2.5, customerY: 14, counterY: 14.8, clerkY: 15.5 } as const;

/** The serpentine line: rows along x, the head at the right end of the top row. */
const LINE = { rightX: 18.5, topY: 11.2, rowGap: 1.2, rows: 7, perRow: 18, spacing: 0.7 } as const;

/** Places of the line inside the hall; a longer line goes on outside the entrance. */
export const LINE_PLACES_IN_HALL = LINE.rows * LINE.perRow;

/** The line outside: rows along the front wall, away from the entrance, one behind another. */
const STREET_LINE = { startX: -1.5, firstY: 2, rowGap: 1.2, perRow: 30 } as const;

/** The entrance is in the left wall, the exit in the right one: from and to y. */
export const DOORS = { entrance: { from: 1, to: 3 }, exit: { from: 11.5, to: 13.5 } } as const;

/**
 * Where people appear, on the threshold of the entrance, and where they
 * disappear, outside the exit. A straight walk from the threshold to any
 * place in the hall, or out to the line in the street, passes no wall.
 */
export const ENTRANCE: Point = { x: 0.3, y: 2 };
export const EXIT: Point = { x: HALL.width + 1.5, y: 12.5 };

/** Where a customer stands at window `index`. */
export function windowSpot(index: number): Point {
  return { x: WINDOWS.firstX + WINDOWS.spacing * index, y: WINDOWS.customerY };
}

/** The middle of the counter of window `index`, and where its clerk sits, for the scene. */
export function counterOf(index: number): { counter: Point; clerk: Point } {
  const x = WINDOWS.firstX + WINDOWS.spacing * index;
  return { counter: { x, y: WINDOWS.counterY }, clerk: { x, y: WINDOWS.clerkY } };
}

/**
 * The `place`-th place of the line, 0 at the head. Rows run in turn right to
 * left and left to right; past the places in the hall the line goes out of
 * the entrance and on in rows along the street.
 */
export function lineSpot(place: number): Point {
  if (place >= LINE_PLACES_IN_HALL) {
    const outside = place - LINE_PLACES_IN_HALL;
    const row = Math.floor(outside / STREET_LINE.perRow);
    return {
      x: STREET_LINE.startX - LINE.spacing * (outside % STREET_LINE.perRow),
      y: STREET_LINE.firstY - STREET_LINE.rowGap * row,
    };
  }
  const row = Math.floor(place / LINE.perRow);
  const along = place % LINE.perRow;
  const offset = LINE.spacing * (row % 2 === 0 ? along : LINE.perRow - 1 - along);
  return { x: LINE.rightX - offset, y: LINE.topY - LINE.rowGap * row };
}

/** The rows of the line, for the posts the scene puts at their ends: y, and x of the two ends. */
export function lineRows(): { y: number; fromX: number; toX: number }[] {
  return Array.from({ length: LINE.rows }, (_, row) => ({
    y: LINE.topY - LINE.rowGap * row,
    fromX: LINE.rightX - LINE.spacing * (LINE.perRow - 1),
    toX: LINE.rightX,
  }));
}
