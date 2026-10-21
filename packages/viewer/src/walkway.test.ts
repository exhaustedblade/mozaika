import { type AnyPopulation, PopulationSnapshots, Simulation } from '@mozaika/kernel';
import type { SnapshotReply } from '@mozaika/kernel/worker';
import { describe, expect, it } from 'vitest';

import { KernelClient, KernelError } from './kernel-client.js';
import { positionsAt } from './motion-view.js';
import { workerInThisThread } from './test-support/worker-in-this-thread.js';
import { HALL, walkway } from './walkway.js';

/** The walkway built directly, without a worker, run to `until`. */
function walkwayAt(until: number): { people: AnyPopulation } {
  const simulation = new Simulation({ seed: 1 });
  const parameters = { arrivalsPerUnit: 20, speed: 8 };
  const [people] = walkway.build({ simulation, parameters }).populations;
  if (people === undefined) throw new Error('the walkway has no population');
  simulation.run(until);
  return { people };
}

describe('walkway model', () => {
  it('lets people in, walk to a spot, wait and leave, all inside the hall', () => {
    const { people } = walkwayAt(60);
    expect(people.size).toBeGreaterThan(200);
    // Every state is there once the flow is steady: walking in, waiting and leaving.
    expect(['entering', 'waiting', 'leaving'].map((state) => people.count(state) > 0)).toEqual([true, true, true]);
    const positions = people.positions();
    for (let row = 0; row < people.size; row++) {
      const [x, y] = [positions[2 * row] ?? Number.NaN, positions[2 * row + 1] ?? Number.NaN];
      expect(x >= 0 && x <= HALL.width && y >= 0 && y <= HALL.height).toBe(true);
    }
  });

  it('gives snapshots from which the viewer finds the kernel’s positions, to the precision of Float32', () => {
    const { people } = walkwayAt(40);
    const snapshot = new PopulationSnapshots(people).take();
    if (snapshot === undefined) throw new Error('no snapshot');
    const fromSnapshot = new Float32Array(2 * snapshot.size);
    positionsAt(snapshot, snapshot.time, fromSnapshot);
    expect(snapshot.size).toBeGreaterThan(200);
    people.positions().forEach((value, index) => {
      expect(fromSnapshot[index]).toBeCloseTo(value, 3);
    });
  });
});

describe('positions between snapshots', () => {
  it('lead each agent along its segment, and keep it at the end once it has arrived', () => {
    const buffer = new ArrayBuffer(64);
    // One agent walking from (0, 0) to (10, 0) since 1 before the snapshot, arriving 4 after it;
    // another standing at (3, 7) since long ago.
    const segments = new Float32Array(buffer, 0, 12);
    segments.set([0, 0, 10, 0, -1, 4, 3, 7, 3, 7, -500, -500]);
    const snapshot = {
      population: 'people',
      time: 100,
      size: 2,
      slot: 0,
      buffer,
      ids: new Float64Array(buffer, 48, 2),
      createdAt: new Float64Array(2),
      segments,
      states: new Uint16Array(2),
    };
    const into = new Float32Array(4);
    positionsAt(snapshot, 100, into);
    expect([...into]).toEqual([2, 0, 3, 7]);
    positionsAt(snapshot, 101.5, into);
    expect([...into]).toEqual([5, 0, 3, 7]);
    positionsAt(snapshot, 120, into);
    expect([...into]).toEqual([10, 0, 3, 7]);
    // A frame before the segment began shows the agent at its start.
    positionsAt(snapshot, 98, into);
    expect([...into]).toEqual([0, 0, 3, 7]);
  });
});

describe('kernel client', () => {
  it('builds, runs and takes snapshots through the messages of the worker, and gives the buffers back', async () => {
    const client = new KernelClient(workerInThisThread({ walkway }));
    const built = await client.build('walkway', 1);
    expect(built.populations).toEqual([{ name: 'people', stateNames: ['entering', 'waiting', 'leaving'] }]);
    const [ran, first] = await Promise.all([client.run(20), client.snapshot()]);
    expect(ran.time).toBe(20);
    expect(first.populations[0]?.size).toBeGreaterThan(100);
    const second: SnapshotReply = await client.snapshot();
    // Both buffers are lent now: a third snapshot must wait for one to come back.
    await expect(client.snapshot()).rejects.toThrow(KernelError);
    await client.release(first);
    const third = await client.snapshot();
    expect(third.populations[0]?.slot).toBe(first.populations[0]?.slot);
    await client.release(second);
    await client.set('speed', 12);
    await expect(client.set('colour', 1)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});
