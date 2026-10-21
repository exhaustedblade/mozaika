import { describe, expect, it } from 'vitest';

import { type EventHandler, EventKind } from './extension.js';
import * as kernel from './index.js';
import { type ProcessBody, timeout } from './process.js';
import { Simulation } from './simulation.js';
import { containing, describeEvent, simulationError } from './test-helpers.js';

/** A handler that logs every event it fires as "time target data", and names events "kind target/data". */
function loggingHandler(sim: Simulation, log: string[]): EventHandler & { labelCalls: number } {
  return {
    labelCalls: 0,
    fire(target, data) {
      log.push(`${String(sim.now)} ${String(target)} ${String(data)}`);
    },
    label(target, data) {
      this.labelCalls++;
      return `kind ${String(target)}/${String(data)}`;
    },
  };
}

describe('event kinds of packages built on the kernel', () => {
  it('fires each event with its numbers at its time', () => {
    const sim = new Simulation();
    const log: string[] = [];
    const kind = new EventKind(sim, loggingHandler(sim, log));
    kind.schedule(2, 7, 1);
    kind.schedule(0.5, -3, 0);
    kind.schedule(2, 7, 2);
    expect(sim.pendingEvents).toBe(3);
    expect(sim.run()).toEqual({ reason: 'empty', time: 2, events: 3 });
    expect(log).toEqual(['0.5 -3 0', '2 7 1', '2 7 2']);
  });

  it('orders its events with all others by time, priority and scheduling order (П-8)', () => {
    const trace: string[] = [];
    const sim = new Simulation({ trace: (event) => trace.push(describeEvent(event)) });
    const log: string[] = [];
    const kind = new EventKind(sim, loggingHandler(sim, log));
    sim.schedule(1, () => log.push('model 1'), { label: 'model 1' });
    kind.schedule(1, 1, 0);
    sim.schedule(1, () => log.push('model 2'), { label: 'model 2' });
    sim.schedule(1, () => log.push('early'), { label: 'early', priority: -1 });
    function* worker(): ProcessBody {
      yield timeout(1);
      log.push('process');
    }
    sim.process(worker(), { name: 'worker' });
    sim.run();
    expect(log).toEqual(['early', 'model 1', '1 1 0', 'model 2', 'process']);
    expect(trace).toEqual([
      '0 0 #4 worker',
      '1 -1 #3 early',
      '1 0 #0 model 1',
      '1 0 #1 kind 1/0',
      '1 0 #2 model 2',
      '1 0 #5 worker',
    ]);
  });

  it('names its events only when a trace or an error needs the name', () => {
    const sim = new Simulation();
    const handler = loggingHandler(sim, []);
    const kind = new EventKind(sim, handler);
    for (let i = 0; i < 100; i++) kind.schedule(i, i, 0);
    sim.run();
    expect(handler.labelCalls).toBe(0);
  });

  it('lets an event schedule further events of its kind, now or later', () => {
    const sim = new Simulation();
    const log: string[] = [];
    const kind: EventKind = new EventKind(sim, {
      fire(target) {
        log.push(`${String(sim.now)} #${String(target)}`);
        if (target < 3) kind.schedule(target === 1 ? 0 : 1.5, target + 1, 0);
      },
      label: () => undefined,
    });
    kind.schedule(1, 1, 0);
    sim.run();
    expect(log).toEqual(['1 #1', '1 #2', '2.5 #3']);
  });

  it('keeps the kinds of several packages apart', () => {
    const sim = new Simulation();
    const first: string[] = [];
    const second: string[] = [];
    const a = new EventKind(sim, loggingHandler(sim, first));
    const b = new EventKind(sim, loggingHandler(sim, second));
    a.schedule(1, 1, 1);
    b.schedule(1, 2, 2);
    a.schedule(2, 3, 3);
    sim.run();
    expect(first).toEqual(['1 1 1', '2 3 3']);
    expect(second).toEqual(['1 2 2']);
  });

  it('stops the run with EVENT_FAILED, naming the event, when a handler throws', () => {
    const sim = new Simulation();
    const kind = new EventKind(sim, {
      fire() {
        throw new Error('the block is broken');
      },
      label: (target) => `desk: customer#${String(target)} service ends`,
    });
    kind.schedule(4, 17, 0);
    const problem = new Error('the block is broken');
    expect(() => sim.run()).toThrow(
      simulationError('EVENT_FAILED', {
        message: containing('Event "desk: customer#17 service ends" failed at time 4'),
        cause: problem,
      }),
    );
  });

  it('refuses delays that schedule() refuses, and numbers that are not 32-bit integers', () => {
    const sim = new Simulation();
    const kind = new EventKind(sim, loggingHandler(sim, []));
    const scheduling = (delay: number, target: number, data: number) => () => {
      kind.schedule(delay, target, data);
    };
    expect(scheduling(-1, 0, 0)).toThrow(simulationError('NEGATIVE_DELAY'));
    expect(scheduling(Number.NaN, 0, 0)).toThrow(simulationError('NOT_A_NUMBER'));
    expect(scheduling(Infinity, 0, 0)).toThrow(simulationError('NOT_FINITE'));
    for (const number of [0.5, 2 ** 31, -(2 ** 31) - 1, Number.NaN]) {
      expect(scheduling(1, number, 0)).toThrow(simulationError('INVALID_ARGUMENT'));
      expect(scheduling(1, 0, number)).toThrow(simulationError('INVALID_ARGUMENT'));
    }
    expect(scheduling(1, 2 ** 31 - 1, -(2 ** 31))).not.toThrow();
    expect(sim.pendingEvents).toBe(1);
  });

  it('refuses a handler without fire and label, and anything but a simulation', () => {
    const sim = new Simulation();
    expect(() => new EventKind(sim, {} as EventHandler)).toThrow(simulationError('INVALID_ARGUMENT'));
    expect(() => new EventKind(sim, { fire: () => undefined } as unknown as EventHandler)).toThrow(
      simulationError('INVALID_ARGUMENT'),
    );
    expect(() => new EventKind({} as Simulation, loggingHandler(sim, []))).toThrow(
      simulationError('INVALID_ARGUMENT'),
    );
  });

  it('is not part of the main export of the kernel: model code schedules through schedule()', () => {
    expect(Object.keys(kernel)).not.toContain('EventKind');
  });
});
