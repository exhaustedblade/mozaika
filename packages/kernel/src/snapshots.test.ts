import { describe, expect, it } from 'vitest';

import { type ProcessBody, timeout } from './process.js';
import { Simulation } from './simulation.js';
import { simulationError } from './test-helpers.js';

/** A counter that events increase at times 0.5, 1, 1 and 2.5. */
function counterModel(): { sim: Simulation; counter: { value: number } } {
  const sim = new Simulation();
  const counter = { value: 0 };
  for (const time of [0.5, 1, 1, 2.5]) {
    sim.scheduleAt(time, () => {
      counter.value += 1;
    });
  }
  return { sim, counter };
}

describe('snapshots', () => {
  it('captures the state at each step, after all events at that time', () => {
    const { sim, counter } = counterModel();
    const recorder = sim.recordSnapshots({ every: 1, capture: () => ({ count: counter.value }) });
    sim.run(3);

    expect(recorder.take()).toEqual([
      { time: 0, data: { count: 0 } },
      { time: 1, data: { count: 3 } },
      { time: 2, data: { count: 3 } },
      { time: 3, data: { count: 4 } },
    ]);
    expect(recorder.take()).toEqual([]);
  });

  it('continues across runs and matches a single run', () => {
    const single = counterModel();
    const singleRecorder = single.sim.recordSnapshots({ every: 0.25, capture: () => single.counter.value });
    single.sim.run(5);

    const pieces = counterModel();
    const piecesRecorder = pieces.sim.recordSnapshots({ every: 0.25, capture: () => pieces.counter.value });
    for (const until of [0.3, 1, 1, 2.6, 5]) pieces.sim.run(until);

    const snapshots = singleRecorder.take();
    expect(snapshots).toHaveLength(21);
    expect(piecesRecorder.take()).toEqual(snapshots);
  });

  it('sets the clock to the snapshot time while capturing', () => {
    const { sim } = counterModel();
    const recorder = sim.recordSnapshots({ every: 0.5, start: 1, capture: (time) => [time, sim.now] });
    sim.run(2);
    expect(recorder.take()).toEqual([
      { time: 1, data: [1, 1] },
      { time: 1.5, data: [1.5, 1.5] },
      { time: 2, data: [2, 2] },
    ]);
  });

  it('computes snapshot times without accumulating rounding errors', () => {
    const sim = new Simulation();
    const recorder = sim.recordSnapshots({ every: 0.1, capture: () => null });
    sim.run(1);
    const times = recorder.take().map((snapshot) => snapshot.time);
    // Adding 0.1 ten times gives 0.9999999999999999; the k-th snapshot is at k * 0.1.
    expect(times).toEqual(Array.from({ length: 11 }, (_, k) => k * 0.1));
    expect(times.at(-1)).toBe(1);
  });

  it('keeps the clock moving forward with several recorders', () => {
    const { sim } = counterModel();
    const seen: number[] = [];
    sim.recordSnapshots({ every: 1, capture: () => seen.push(sim.now) });
    sim.recordSnapshots({ every: 0.75, capture: () => seen.push(sim.now) });
    sim.run(3);
    expect(seen).toEqual([0, 0, 0.75, 1, 1.5, 2, 2.25, 3, 3]);
  });

  it('does not add events to the model', () => {
    const { sim } = counterModel();
    sim.recordSnapshots({ every: 0.1, capture: () => sim.pendingEvents });
    expect(sim.pendingEvents).toBe(4);
    expect(sim.run()).toEqual({ reason: 'empty', time: 2.5, events: 4 });
  });

  it('stops recording on request', () => {
    const { sim } = counterModel();
    const recorder = sim.recordSnapshots({ every: 1, capture: () => sim.now });
    sim.run(1);
    recorder.stop();
    sim.run(5);
    expect(recorder.take().map((snapshot) => snapshot.time)).toEqual([0, 1]);
  });

  it('produces plain data that survives a JSON round trip', () => {
    const sim = new Simulation({ seed: 1 });
    const queue: number[] = [];
    const arrivals = sim.random.stream('arrivals');
    function* source(): ProcessBody {
      for (let id = 1; id <= 20; id++) {
        yield timeout(arrivals.exponential(0.5));
        queue.push(id);
      }
    }
    sim.process(source());
    const recorder = sim.recordSnapshots({
      every: 1,
      capture: (time) => ({ time, queue: [...queue], busy: queue.length > 3, label: 'shop' }),
    });
    sim.run(10);

    const snapshots = recorder.take();
    expect(snapshots.length).toBe(11);
    expect(JSON.parse(JSON.stringify(snapshots))).toEqual(snapshots);
  });

  it('rejects a non-positive step and a start in the past', () => {
    const sim = new Simulation({ startTime: 5 });
    const capture = (): null => null;
    expect(() => sim.recordSnapshots({ every: 0, capture })).toThrow(simulationError('INVALID_ARGUMENT'));
    expect(() => sim.recordSnapshots({ every: Number.NaN, capture })).toThrow(simulationError('NOT_A_NUMBER'));
    expect(() => sim.recordSnapshots({ every: 1, start: 4, capture })).toThrow(simulationError('INVALID_ARGUMENT'));
  });
});
