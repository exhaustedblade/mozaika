import { type AnyPopulation, type PopulationSnapshot, PopulationSnapshots, Simulation } from '@mozaika/kernel';
import { describe, expect, it } from 'vitest';

import { positionsAt } from '../motion-view.js';
import { walkway, WALKWAY_DEFAULTS } from '../walkway.js';
import { SEGMENT_POSITION_GLSL, SEGMENT_WIDTH, shaderPositions } from './segment-shader.js';

/**
 * The formula the vertex shader leads agents by (docs/ARCHITECTURE.md,
 * "Показ"), through its twin in TypeScript that computes step by step in
 * Float32 as the shader does: it must agree with positionsAt of the 2D check
 * and with the kernel's own positions, to the precision of Float32. The
 * shader itself runs on a graphics card in the Playwright test
 * (e2e/shader.e2e.ts), against the same twin.
 */

const SEGMENT = SEGMENT_WIDTH;

/**
 * A few units in the last place of Float32 at the size of the operands, the
 * ends of the segment: the twin rounds after every step and positionsAt once
 * at the end, so a step that cancels (from 9 000 towards 10 gives about 100)
 * keeps the error of the larger numbers.
 */
function expectFloat32Close(actual: number, expected: number, operands: number, what: string): void {
  const ulp = 2 ** -23 * Math.max(1, operands);
  expect(Math.abs(actual - expected), `${what}: ${String(actual)} against ${String(expected)}`).toBeLessThanOrEqual(
    8 * ulp,
  );
}

/** The size of the ends of the segment in `row` along `axis` (0: x, 1: y): what the error scales with. */
function operandsOf(segments: Float32Array, row: number, axis: number): number {
  return Math.max(Math.abs(segments[SEGMENT * row + axis] ?? 0), Math.abs(segments[SEGMENT * row + 2 + axis] ?? 0));
}

/** A snapshot of hand-made segments, as the kernel writes them: start and arrival from the snapshot time. */
function snapshotOf(time: number, segments: readonly number[]): PopulationSnapshot {
  const size = segments.length / SEGMENT;
  const buffer = new ArrayBuffer(4 * segments.length);
  const column = new Float32Array(buffer);
  column.set(segments);
  return {
    population: 'people',
    time,
    size,
    slot: 0,
    buffer,
    ids: Float64Array.from({ length: size }, (_, row) => row),
    createdAt: new Float64Array(size),
    segments: column,
    states: new Uint16Array(size),
  };
}

/** The positions of the twin and of positionsAt for `snapshot` at model time `time`. */
function bothAt(snapshot: PopulationSnapshot, time: number): { shader: Float32Array; reference: Float32Array } {
  const shader = new Float32Array(2 * snapshot.size);
  const reference = new Float32Array(2 * snapshot.size);
  shaderPositions(snapshot.segments, snapshot.size, time - snapshot.time, shader);
  positionsAt(snapshot, time, reference);
  return { shader, reference };
}

/** The walkway (the model of the 2D check) built without a worker, with its people. */
function walkwayModel(): { simulation: Simulation; people: AnyPopulation } {
  const simulation = new Simulation({ seed: 7 });
  const [people] = walkway.build({ simulation, parameters: WALKWAY_DEFAULTS }).populations;
  if (people === undefined) throw new Error('the walkway has no population');
  return { simulation, people };
}

function take(snapshots: PopulationSnapshots): PopulationSnapshot {
  const snapshot = snapshots.take();
  if (snapshot === undefined) throw new Error('no free snapshot buffer');
  return snapshot;
}

describe('the formula of the shader', () => {
  it('is a GLSL function of the segment and of the time since the snapshot', () => {
    expect(SEGMENT_POSITION_GLSL).toContain('vec2 segmentPosition(vec4 fromTo, vec2 times, float since)');
  });

  it('leads an agent along its segment, keeps it at the start before and at the target from the arrival on', () => {
    const snapshot = snapshotOf(100, [
      // Walking from (0, 0) to (10, 0) since 1 before the snapshot, arriving 4 after it.
      0, 0, 10, 0, -1, 4,
      // Standing at (3, 7) since long ago.
      3, 7, 3, 7, -500, -500,
      // Starting 2 after the snapshot from (-4, 6) to (8, -6), arriving 5 after it.
      -4, 6, 8, -6, 2, 5,
      // A walk of no duration, 1 after the snapshot: before it the agent is at the start.
      1, 1, 2, 2, 1, 1,
    ]);
    const at = (time: number): number[] => {
      const into = new Float32Array(8);
      shaderPositions(snapshot.segments, snapshot.size, time - snapshot.time, into);
      return [...into];
    };
    expect(at(100)).toEqual([2, 0, 3, 7, -4, 6, 1, 1]);
    expect(at(101.5)).toEqual([5, 0, 3, 7, -4, 6, 2, 2]);
    expect(at(103.5)).toEqual([9, 0, 3, 7, 2, 0, 2, 2]);
    // From the arrival on, exactly the target.
    expect(at(104)).toEqual([10, 0, 3, 7, 4, -2, 2, 2]);
    expect(at(1e6)).toEqual([10, 0, 3, 7, 8, -6, 2, 2]);
    // A frame before the snapshot, before the first segment began.
    expect(at(98)).toEqual([0, 0, 3, 7, -4, 6, 1, 1]);
  });

  it('agrees with positionsAt of the 2D check at any frame time, before and after the snapshot', () => {
    const { simulation, people } = walkwayModel();
    simulation.run(45);
    const snapshot = take(new PopulationSnapshots(people));
    expect(snapshot.size).toBeGreaterThan(200);
    for (const time of [45, 45.01, 45.5, 47, 52, 60, 200, 44.9, 40]) {
      const { shader, reference } = bothAt(snapshot, time);
      shader.forEach((value, index) => {
        const operands = operandsOf(snapshot.segments, Math.floor(index / 2), index % 2);
        expectFloat32Close(value, reference[index] ?? Number.NaN, operands, `t = ${String(time)}, coordinate ${String(index)}`);
      });
    }
  });

  it('puts agents where the kernel has them later, while their segments last: walking or arrived', () => {
    const { simulation, people } = walkwayModel();
    const snapshots = new PopulationSnapshots(people);
    simulation.run(45);
    const before = take(snapshots);
    const later = 46.5;
    simulation.run(later);
    const after = take(snapshots);
    const kernel = people.positions();
    const fromBefore = new Float32Array(2 * before.size);
    shaderPositions(before.segments, before.size, later - before.time, fromBefore);

    // Rows change as people leave, so agents are matched by id (ARCHITECTURE, "Показ").
    const rowBefore = new Map([...before.ids].map((id, row) => [id, row]));
    let walking = 0;
    let arrived = 0;
    after.ids.forEach((id, row) => {
      const old = rowBefore.get(id);
      if (old === undefined || !sameSegment(before, old, after, row)) return;
      const arrival = (after.segments[row * SEGMENT + 5] ?? Number.NaN) + after.time;
      if (arrival > later) walking++;
      else arrived++;
      for (const axis of [0, 1]) {
        const value = fromBefore[2 * old + axis] ?? Number.NaN;
        const operands = operandsOf(before.segments, old, axis);
        expectFloat32Close(value, kernel[2 * row + axis] ?? Number.NaN, operands, `agent ${String(id)}, axis ${String(axis)}`);
      }
    });
    // Both cases are there: agents still on their way, and agents that arrived and stand.
    expect(walking).toBeGreaterThan(20);
    expect(arrived).toBeGreaterThan(20);
  });
});

/**
 * Whether the agent kept its segment between two snapshots: the same ends,
 * and the same start and arrival once counted from model time zero.
 */
function sameSegment(first: PopulationSnapshot, firstRow: number, second: PopulationSnapshot, secondRow: number): boolean {
  const a = first.segments.subarray(firstRow * SEGMENT, firstRow * SEGMENT + SEGMENT);
  const b = second.segments.subarray(secondRow * SEGMENT, secondRow * SEGMENT + SEGMENT);
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return false;
  const shift = second.time - first.time;
  // Moments are counted from the snapshot in Float32: compare them to its precision.
  return [4, 5].every((i) => Math.abs((a[i] ?? 0) - shift - (b[i] ?? 0)) < 1e-3);
}
