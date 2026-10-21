import { describe, expect, it } from 'vitest';

import { Simulation } from '../simulation.js';
import { containing, describeEvent, simulationError } from '../test-helpers.js';
import { AgentPopulation } from './population.js';
import { type PopulationSnapshot, PopulationSnapshots } from './population-snapshots.js';
import { defineStatechart } from './statechart.js';

/** Agents that change state on a message and walk wherever the test sends them. */
const chart = defineStatechart({
  initial: 'idle',
  states: { idle: { on: { go: 'busy', 'agent.arrived': 'idle' } }, busy: { on: { 'agent.arrived': 'idle' } } },
});

/**
 * Six agents created at different times, some of them walking and some
 * busy; then two are removed, so the last agents take their rows.
 */
function shuffledPopulation(): { sim: Simulation; agents: AgentPopulation } {
  const sim = new Simulation();
  const agents = new AgentPopulation(sim, { name: 'agents', statechart: chart });
  for (let i = 0; i < 6; i++) {
    sim.run(i * 0.75);
    const agent = agents.add();
    agent.placeAt({ x: i, y: 10 - i });
    if (i % 2 === 0) agent.moveTo({ x: i + 3, y: 4 }, { duration: 6 });
    if (i % 3 === 1) agent.send({ type: 'go' });
  }
  sim.run(4.1);
  const [, second, , fourth] = agents.agents;
  if (second === undefined || fourth === undefined) throw new Error('an agent is missing');
  agents.remove(second);
  agents.remove(fourth);
  return { sim, agents };
}

/** The segment of each agent as the population keeps it, read through the public API at two moments. */
function expectSegmentsOf(snapshot: PopulationSnapshot, agents: AgentPopulation, sim: Simulation): void {
  // A position at the snapshot time by the formula of the snapshot's segment (docs/ARCHITECTURE.md,
  // "Снимок популяции") matches the kernel's position, to the precision of Float32.
  const positions = agents.positions();
  for (let row = 0; row < snapshot.size; row++) {
    const [fromX, fromY, toX, toY, start, arrival] = snapshot.segments.subarray(6 * row, 6 * row + 6);
    if (fromX === undefined || fromY === undefined || toX === undefined || toY === undefined) throw new Error('short');
    if (start === undefined || arrival === undefined) throw new Error('short');
    const k = arrival <= 0 ? 1 : (0 - start) / (arrival - start);
    expect(fromX + (toX - fromX) * k).toBeCloseTo(positions[2 * row] ?? Number.NaN, 5);
    expect(fromY + (toY - fromY) * k).toBeCloseTo(positions[2 * row + 1] ?? Number.NaN, 5);
  }
  expect(snapshot.time).toBe(sim.now);
}

describe('population snapshots: columns', () => {
  it('match the columns of the population after removals and reorderings', () => {
    const { sim, agents } = shuffledPopulation();
    const snapshots = new PopulationSnapshots(agents);
    const snapshot = snapshots.take();
    if (snapshot === undefined) throw new Error('no snapshot');

    expect(snapshot.population).toBe('agents');
    expect(snapshot.size).toBe(4);
    expect([...snapshot.ids]).toEqual([...agents.ids()]);
    expect([...snapshot.ids]).toEqual([1, 6, 3, 5]);
    expect([...snapshot.states]).toEqual([...agents.stateCodes()]);
    expect([...snapshot.createdAt]).toEqual(agents.agents.map((agent) => agent.createdAt));
    expect([...snapshot.createdAt]).toEqual([0, 3.75, 1.5, 3]);
    // Columns of the right types and lengths, all in the one buffer that is transferred.
    expect(snapshot.ids).toBeInstanceOf(Float64Array);
    expect(snapshot.createdAt).toBeInstanceOf(Float64Array);
    expect(snapshot.segments).toBeInstanceOf(Float32Array);
    expect(snapshot.states).toBeInstanceOf(Uint16Array);
    expect(snapshot.segments).toHaveLength(6 * 4);
    for (const column of [snapshot.ids, snapshot.createdAt, snapshot.segments, snapshot.states]) {
      expect(column.buffer).toBe(snapshot.buffer);
    }
    expectSegmentsOf(snapshot, agents, sim);
  });

  it('give the segments as Float32, with times counted from the snapshot', () => {
    const sim = new Simulation();
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: chart });
    const walking = agents.add();
    const standing = agents.add();
    walking.placeAt({ x: 1, y: 2 });
    walking.moveTo({ x: 7, y: 10 }, { speed: 2 });
    standing.placeAt({ x: -3, y: 0.1 });
    sim.run(1000.5);
    walking.moveTo({ x: 1, y: 2 }, { duration: 4 });
    sim.run(1001.5);
    const snapshot = new PopulationSnapshots(agents).take();
    if (snapshot === undefined) throw new Error('no snapshot');
    expect([...snapshot.segments.subarray(0, 6)]).toEqual([7, 10, 1, 2, -1, 3]);
    const y = Math.fround(0.1);
    expect([...snapshot.segments.subarray(6, 12)]).toEqual([-3, y, -3, y, -1001.5, -1001.5]);
  });

  it('give agents that never moved standing at the origin', () => {
    const sim = new Simulation();
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: chart });
    agents.add();
    sim.run(2);
    const snapshot = new PopulationSnapshots(agents).take();
    expect([...(snapshot?.segments ?? [])]).toEqual([0, 0, 0, 0, -2, -2]);
  });

  it('are taken without changing the run', () => {
    function run(withSnapshots: boolean): string[] {
      const trace: string[] = [];
      const sim = new Simulation({ seed: 5, trace: (event) => trace.push(describeEvent(event)) });
      const walkers = defineStatechart({
        initial: 'walking',
        states: {
          walking: {
            entry: ({ agent, random }) => {
              agent.moveTo({ x: random.uniform(), y: random.uniform() }, { speed: 0.5 });
            },
            on: { 'agent.arrived': { target: 'walking', reenter: true } },
          },
        },
      });
      const agents = new AgentPopulation(sim, { name: 'walkers', statechart: walkers });
      for (let i = 0; i < 20; i++) agents.add();
      const snapshots = new PopulationSnapshots(agents);
      for (let time = 1; time <= 10; time++) {
        sim.run(time);
        const snapshot = withSnapshots ? snapshots.take() : undefined;
        if (snapshot !== undefined) snapshots.giveBack(snapshot);
      }
      return trace;
    }
    const plain = run(false);
    expect(plain.length).toBeGreaterThan(100);
    expect(run(true)).toEqual(plain);
  });
});

describe('population snapshots: double buffering', () => {
  it('lends two buffers and gives none while both are lent', () => {
    const { agents } = shuffledPopulation();
    const snapshots = new PopulationSnapshots(agents);
    const first = snapshots.take();
    const second = snapshots.take();
    if (first === undefined || second === undefined) throw new Error('no snapshot');
    expect(second.buffer).not.toBe(first.buffer);
    expect([first.slot, second.slot]).toEqual([0, 1]);
    expect(snapshots.lent).toBe(2);
    expect(snapshots.take()).toBeUndefined();
  });

  it('never writes into a lent buffer, and reuses a buffer once it is given back', () => {
    const { sim, agents } = shuffledPopulation();
    const snapshots = new PopulationSnapshots(agents);
    const first = snapshots.take();
    const second = snapshots.take();
    if (first === undefined || second === undefined) throw new Error('no snapshot');
    const secondBytes = new Uint8Array(second.buffer).slice();

    agents.agents[0]?.send({ type: 'go' });
    agents.add().placeAt({ x: 50, y: 50 });
    sim.run(5);
    snapshots.giveBack(first);
    expect(snapshots.lent).toBe(1);
    const third = snapshots.take();
    if (third === undefined) throw new Error('no snapshot');
    // The buffer given back is written again; the one still lent is untouched.
    expect(third.slot).toBe(first.slot);
    expect(third.buffer).toBe(first.buffer);
    expect(new Uint8Array(second.buffer)).toEqual(secondBytes);
    expect([...third.ids]).toEqual([...agents.ids()]);
    expect([...third.states]).toEqual([...agents.stateCodes()]);
    expect(third.time).toBe(5);
    expectSegmentsOf(third, agents, sim);
  });

  it('takes back a buffer transferred there and back, as from a Web Worker to a viewer', () => {
    const { agents } = shuffledPopulation();
    const snapshots = new PopulationSnapshots(agents);
    const first = snapshots.take();
    if (first === undefined) throw new Error('no snapshot');
    // A transfer detaches the sender's ArrayBuffer and gives the receiver a new object for the same
    // memory, as ArrayBuffer.prototype.transfer (ES2024) does; the library of this package is ES2023.
    const transfer = (buffer: ArrayBuffer): ArrayBuffer =>
      (buffer as unknown as { transfer(): ArrayBuffer }).transfer();
    const atViewer = transfer(first.buffer);
    expect(first.buffer.byteLength).toBe(0);
    const backHere = transfer(atViewer);
    snapshots.giveBack({ slot: first.slot, buffer: backHere });
    const next = snapshots.take();
    expect(next?.slot).toBe(first.slot);
    expect(next?.buffer).toBe(backHere);
    expect([...(next?.ids ?? [])]).toEqual([...agents.ids()]);
  });

  it('gives a larger buffer when the population outgrows a free one', () => {
    const sim = new Simulation();
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: chart });
    agents.add();
    const snapshots = new PopulationSnapshots(agents);
    const small = snapshots.take();
    if (small === undefined) throw new Error('no snapshot');
    snapshots.giveBack(small);
    for (let i = 0; i < 5000; i++) agents.add().placeAt({ x: i, y: 0 });
    const large = snapshots.take();
    if (large === undefined) throw new Error('no snapshot');
    expect(large.size).toBe(5001);
    expect(large.buffer.byteLength).toBeGreaterThan(small.buffer.byteLength);
    expect([...large.ids]).toEqual([...agents.ids()]);
    expect(large.segments[6 * 5000]).toBe(4999);
  });

  it('refuses a buffer that is not lent or does not fit', () => {
    const { agents } = shuffledPopulation();
    const snapshots = new PopulationSnapshots(agents);
    const first = snapshots.take();
    if (first === undefined) throw new Error('no snapshot');
    expect(() => {
      snapshots.giveBack({ slot: 1, buffer: new ArrayBuffer(first.buffer.byteLength) });
    }).toThrow(simulationError('INVALID_ARGUMENT', { message: containing('not lent') }));
    expect(() => {
      snapshots.giveBack({ slot: 7, buffer: first.buffer });
    }).toThrow(simulationError('INVALID_ARGUMENT'));
    expect(() => {
      snapshots.giveBack({ slot: first.slot, buffer: new ArrayBuffer(8) });
    }).toThrow(simulationError('INVALID_ARGUMENT', { message: containing('bytes') }));
    // Refused returns leave the buffer lent.
    expect(snapshots.lent).toBe(1);
    snapshots.giveBack(first);
    expect(() => {
      snapshots.giveBack(first);
    }).toThrow(simulationError('INVALID_ARGUMENT'));
  });
});
