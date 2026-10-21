/**
 * The position of an agent on its segment, as the vertex shader computes it
 * (docs/ARCHITECTURE.md, "Показ"): the formula of a segment (docs/AGENTS.md,
 * section 9) with the start and the arrival counted from the snapshot, at
 * `since` — the frame's model time minus the snapshot's. The GLSL function and
 * its twin in TypeScript are kept side by side and line by line alike: the
 * tests check the twin against positionsAt and the kernel's positions, and the
 * Playwright test checks the GLSL on a graphics card against the twin.
 */

/**
 * GLSL ES 3.00: `fromTo` — from x, y, to x, y; `times` — start and arrival,
 * from the snapshot. The second branch gives what max(0, k) gives in
 * positionsAt, and spares a segment of no duration a division by zero.
 */
export const SEGMENT_POSITION_GLSL = /* glsl */ `
vec2 segmentPosition(vec4 fromTo, vec2 times, float since) {
  if (since >= times.y) return fromTo.zw;
  if (since <= times.x) return fromTo.xy;
  return fromTo.xy + (fromTo.zw - fromTo.xy) * ((since - times.x) / (times.y - times.x));
}
`;

/**
 * Numbers per agent in the segments of a snapshot: from x, y, to x, y, start
 * and arrival (the last two from the snapshot time), as the kernel writes them.
 */
export const SEGMENT_WIDTH = 6;

/**
 * The twin of SEGMENT_POSITION_GLSL: writes the positions of the first `size`
 * agents of `segments` at `since` into `into` (x and y of each in turn),
 * rounding each step to Float32 as the graphics card computes.
 */
export function shaderPositions(segments: Float32Array, size: number, since: number, into: Float32Array): void {
  const f = Math.fround;
  const at = f(since);
  for (let row = 0; row < size; row++) {
    const cell = row * SEGMENT_WIDTH;
    const fromX = segments[cell] ?? 0;
    const fromY = segments[cell + 1] ?? 0;
    const toX = segments[cell + 2] ?? 0;
    const toY = segments[cell + 3] ?? 0;
    const start = segments[cell + 4] ?? 0;
    const arrival = segments[cell + 5] ?? 0;
    if (at >= arrival) {
      into[2 * row] = toX;
      into[2 * row + 1] = toY;
    } else if (at <= start) {
      into[2 * row] = fromX;
      into[2 * row + 1] = fromY;
    } else {
      const k = f(f(at - start) / f(arrival - start));
      into[2 * row] = f(fromX + f(f(toX - fromX) * k));
      into[2 * row + 1] = f(fromY + f(f(toY - fromY) * k));
    }
  }
}
