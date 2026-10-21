import { describe, expect, it } from 'vitest';

import { Random } from './random.js';
import { Simulation } from './simulation.js';
import { describeEvent, simulationError } from './test-helpers.js';

describe('Simulation: order of events', () => {
  it('fires simultaneous events by priority, then in scheduling order', () => {
    const sim = new Simulation();
    const fired: string[] = [];
    const log = (name: string) => (): void => {
      fired.push(`${name}@${String(sim.now)}`);
    };

    sim.schedule(2, log('late'));
    sim.schedule(1, log('normal-1'));
    sim.schedule(1, log('low'), { priority: 1 });
    sim.schedule(1, log('normal-2'));
    sim.schedule(1, log('urgent'), { priority: -1 });
    sim.run();

    expect(fired).toEqual(['urgent@1', 'normal-1@1', 'normal-2@1', 'low@1', 'late@2']);
  });

  it('runs a zero-delay event after the events already waiting at that time', () => {
    const sim = new Simulation();
    const fired: string[] = [];
    sim.schedule(1, () => {
      fired.push('a');
      sim.schedule(0, () => fired.push('a → zero delay'));
      sim.schedule(0, () => fired.push('a → zero delay, urgent'), { priority: -1 });
    });
    sim.schedule(1, () => fired.push('b'));
    sim.schedule(1, () => fired.push('c, low priority'), { priority: 1 });
    sim.run();

    expect(fired).toEqual(['a', 'a → zero delay, urgent', 'b', 'a → zero delay', 'c, low priority']);
  });

  it('schedules at an absolute time and starts the clock at startTime', () => {
    const sim = new Simulation({ startTime: 100 });
    const times: number[] = [];
    sim.scheduleAt(105, () => times.push(sim.now));
    sim.scheduleAt(100, () => times.push(sim.now));
    expect(sim.now).toBe(100);
    sim.run();
    expect(times).toEqual([100, 105]);
  });

  it('describes scheduled events through their handles', () => {
    const sim = new Simulation();
    const first = sim.schedule(3, () => undefined, { label: 'first', priority: 2 });
    const second = sim.scheduleAt(1, () => undefined);
    expect(first).toMatchObject({ time: 3, priority: 2, seq: 0, label: 'first', pending: true });
    expect(second).toMatchObject({ time: 1, priority: 0, seq: 1, label: undefined, pending: true });
    expect(sim.pendingEvents).toBe(2);
    expect(sim.nextEventTime()).toBe(1);
  });

  it('passes every event to the trace callback before it fires', () => {
    const trace: string[] = [];
    const sim = new Simulation({ trace: (event) => trace.push(describeEvent(event)) });
    sim.schedule(2, () => undefined, { label: 'b' });
    sim.schedule(1, () => undefined, { label: 'a', priority: 3 });
    sim.run();
    expect(trace).toEqual(['1 3 #1 a', '2 0 #0 b']);
  });
});

describe('Simulation: running', () => {
  it('runs until the queue is empty and keeps the clock at the last event', () => {
    const sim = new Simulation();
    sim.schedule(4, () => undefined);
    sim.schedule(7, () => undefined);

    expect(sim.run()).toEqual({ reason: 'empty', time: 7, events: 2 });
    expect(sim.now).toBe(7);
    expect(sim.eventsProcessed).toBe(2);
    expect(sim.nextEventTime()).toBe(Infinity);
  });

  it('runs up to a given time, including events at exactly that time', () => {
    const sim = new Simulation();
    const fired: number[] = [];
    for (const time of [1, 2, 3, 3, 4]) {
      sim.scheduleAt(time, () => {
        fired.push(time);
        // Created at the stop time: still part of this run.
        if (time === 2) sim.scheduleAt(3, () => fired.push(3.5));
      });
    }

    expect(sim.run(3)).toEqual({ reason: 'until', time: 3, events: 5 });
    expect(fired).toEqual([1, 2, 3, 3, 3.5]);
    expect(sim.pendingEvents).toBe(1);

    expect(sim.run(10)).toEqual({ reason: 'until', time: 10, events: 1 });
    expect(fired).toEqual([1, 2, 3, 3, 3.5, 4]);
    expect(sim.now).toBe(10);
  });

  it('gives the same result whether a run is done at once or in pieces', () => {
    const build = (): { sim: Simulation; fired: number[] } => {
      const sim = new Simulation({ seed: 3 });
      const fired: number[] = [];
      const delays = sim.random.stream('delays');
      const tick = (): void => {
        fired.push(sim.now);
        if (sim.now < 50) sim.schedule(delays.exponential(1), tick);
      };
      sim.schedule(0, tick);
      return { sim, fired };
    };

    const whole = build();
    whole.sim.run(60);
    const pieces = build();
    for (let until = 0; until <= 60; until += 0.75) pieces.sim.run(until);

    expect(pieces.fired).toEqual(whole.fired);
  });

  it('stops after the current event when asked to', () => {
    const sim = new Simulation();
    const fired: string[] = [];
    sim.schedule(1, () => {
      fired.push('a');
      sim.stop();
    });
    sim.schedule(1, () => fired.push('b'));
    sim.schedule(2, () => fired.push('c'));

    expect(sim.run(10)).toEqual({ reason: 'stopped', time: 1, events: 1 });
    expect(fired).toEqual(['a']);
    expect(sim.now).toBe(1);

    expect(sim.run(10)).toEqual({ reason: 'until', time: 10, events: 2 });
    expect(fired).toEqual(['a', 'b', 'c']);
  });

  it('ignores stop() outside a run', () => {
    const sim = new Simulation();
    sim.schedule(1, () => undefined);
    sim.stop();
    expect(sim.run().reason).toBe('empty');
  });

  it('fires one event per step', () => {
    const sim = new Simulation();
    const fired: number[] = [];
    sim.schedule(2, () => fired.push(2));
    sim.schedule(1, () => fired.push(1));

    expect(sim.step()).toBe(true);
    expect(fired).toEqual([1]);
    expect(sim.now).toBe(1);
    expect(sim.step()).toBe(true);
    expect(sim.step()).toBe(false);
    expect(fired).toEqual([1, 2]);
  });

  it('does not fire cancelled events', () => {
    const sim = new Simulation();
    const fired: string[] = [];
    const cancelled = sim.schedule(1, () => fired.push('cancelled'));
    sim.schedule(2, () => fired.push('kept'));

    expect(cancelled.cancel()).toBe(true);
    expect(sim.pendingEvents).toBe(1);
    sim.run();
    expect(fired).toEqual(['kept']);
    expect(sim.eventsProcessed).toBe(1);
  });
});

describe('Simulation: cancelling events', () => {
  it('cancels a pending event once and then reports it as no longer pending', () => {
    const sim = new Simulation();
    const handle = sim.schedule(1, () => undefined);
    expect(handle.pending).toBe(true);
    expect(handle.cancel()).toBe(true);
    expect(handle.cancel()).toBe(false);
    expect(handle.pending).toBe(false);
    expect(sim.pendingEvents).toBe(0);
    expect(sim.nextEventTime()).toBe(Infinity);
  });

  it('does not let an old handle cancel the event that took over its place in the queue', () => {
    const sim = new Simulation();
    const fired: string[] = [];
    const cancelled = sim.schedule(1, () => fired.push('cancelled'));
    cancelled.cancel();
    // The next event takes the place the cancelled one has just freed.
    const fresh = sim.schedule(2, () => fired.push('fresh'));
    expect(cancelled.cancel()).toBe(false);
    expect(cancelled.pending).toBe(false);
    expect(fresh.pending).toBe(true);
    sim.run();
    expect(fired).toEqual(['fresh']);
  });

  it('does not let the handle of a fired event cancel a later one', () => {
    const sim = new Simulation();
    const fired: string[] = [];
    const first = sim.schedule(1, () => fired.push('first'));
    sim.run();
    const later = sim.schedule(1, () => fired.push('later'));
    expect(first.pending).toBe(false);
    expect(first.cancel()).toBe(false);
    expect(later.pending).toBe(true);
    sim.run();
    expect(fired).toEqual(['first', 'later']);
  });

  it('cannot cancel an event while it fires', () => {
    const sim = new Simulation();
    let result: boolean | undefined;
    const handle = sim.schedule(1, () => {
      result = handle.cancel();
    });
    sim.run();
    expect(result).toBe(false);
  });

  it('keeps describing an event after it has fired or been cancelled', () => {
    const sim = new Simulation();
    const fired = sim.schedule(2, () => undefined, { label: 'fired', priority: -1 });
    const cancelled = sim.schedule(3, () => undefined, { label: 'cancelled' });
    cancelled.cancel();
    sim.run();
    sim.schedule(1, () => undefined);
    sim.schedule(1, () => undefined);
    expect(fired).toMatchObject({ time: 2, priority: -1, seq: 0, label: 'fired', pending: false });
    expect(cancelled).toMatchObject({ time: 3, priority: 0, seq: 1, label: 'cancelled', pending: false });
  });

  it('cancels events of the same moment from inside an event, and later ones too', () => {
    const sim = new Simulation();
    const fired: string[] = [];
    const sameMoment = sim.schedule(1, () => fired.push('same moment'));
    const later = sim.schedule(5, () => fired.push('later'));
    sim.scheduleAt(1, () => fired.push('kept'));
    sim.schedule(1, () => {
      fired.push('canceller');
      sameMoment.cancel();
      later.cancel();
    }, { priority: -1 });
    sim.run();
    expect(fired).toEqual(['canceller', 'kept']);
    expect(sim.eventsProcessed).toBe(2);
  });

  it('fires only the events left when most scheduled ones are cancelled', () => {
    const sim = new Simulation({ seed: 4 });
    const delays = sim.random.stream('delays');
    const kept = new Set<number>();
    const fired: number[] = [];
    let nextTag = 0;
    // Each event schedules ten more and cancels all but a random one, like an agent leaving a state with many timers.
    const tick = (tag: number): void => {
      fired.push(tag);
      if (fired.length >= 2_000) return;
      const handles = Array.from({ length: 10 }, () => {
        const next = nextTag++;
        return { tag: next, handle: sim.schedule(delays.exponential(1), () => tick(next)) };
      });
      const keep = handles[Math.floor(delays.uniform(0, 10))];
      for (const { tag, handle } of handles) {
        if (tag === keep?.tag) kept.add(tag);
        else handle.cancel();
      }
      expect(sim.pendingEvents).toBe(1);
    };
    sim.schedule(0, () => tick(-1));
    sim.run();
    expect(fired).toHaveLength(2_000);
    expect(fired.slice(1).every((tag) => kept.has(tag))).toBe(true);
  });
});

describe('Simulation: random numbers', () => {
  it('seeds its random stream from the options', () => {
    const fromSeed = new Simulation({ seed: 77 });
    expect(fromSeed.random.uniform()).toBe(new Random(77).uniform());
    expect(new Simulation().random.seed).toBe(0);

    const stream = new Random(5, ['replication-2']);
    expect(new Simulation({ random: stream }).random).toBe(stream);
  });

  it('refuses both a seed and a random stream', () => {
    expect(() => new Simulation({ seed: 1, random: new Random(1) })).toThrow(simulationError('INVALID_ARGUMENT'));
  });
});

describe('Simulation: errors', () => {
  it('rejects negative, NaN and infinite delays', () => {
    const sim = new Simulation();
    const action = (): void => undefined;
    expect(() => sim.schedule(-1, action)).toThrow(simulationError('NEGATIVE_DELAY'));
    expect(() => sim.schedule(Number.NaN, action)).toThrow(simulationError('NOT_A_NUMBER'));
    expect(() => sim.schedule(Infinity, action)).toThrow(simulationError('NOT_FINITE'));
    expect(() => sim.schedule('1' as unknown as number, action)).toThrow(simulationError('INVALID_ARGUMENT'));
    expect(sim.pendingEvents).toBe(0);
  });

  it('explains what was wrong in the message', () => {
    const sim = new Simulation();
    expect(() => sim.schedule(-2, () => undefined)).toThrow('schedule() delay must not be negative, got -2');
    sim.schedule(5, () => undefined);
    sim.run();
    expect(() => sim.scheduleAt(3, () => undefined)).toThrow(
      'scheduleAt() time 3 is in the past: the clock is already at 5',
    );
  });

  it('rejects events in the past', () => {
    const sim = new Simulation({ startTime: 10 });
    expect(() => sim.scheduleAt(9.5, () => undefined)).toThrow(simulationError('EVENT_IN_PAST'));
    expect(() => sim.scheduleAt(Number.NaN, () => undefined)).toThrow(simulationError('NOT_A_NUMBER'));
    expect(() => sim.run(9)).toThrow(simulationError('INVALID_ARGUMENT'));
  });

  it('rejects invalid priorities, actions and run limits', () => {
    const sim = new Simulation();
    expect(() => sim.schedule(1, () => undefined, { priority: Number.NaN })).toThrow(simulationError('NOT_A_NUMBER'));
    expect(() => sim.schedule(1, 'tick' as unknown as () => void)).toThrow(simulationError('INVALID_ARGUMENT'));
    expect(() => sim.run(Number.NaN)).toThrow(simulationError('NOT_A_NUMBER'));
    expect(() => new Simulation({ startTime: Infinity })).toThrow(simulationError('NOT_FINITE'));
  });

  it('reports a failing action with its label and time, and can continue', () => {
    const sim = new Simulation();
    const cause = new Error('boom');
    sim.schedule(2, () => {
      throw cause;
    }, { label: 'arrival' });
    sim.schedule(3, () => undefined);

    expect(() => sim.run()).toThrow(
      simulationError('EVENT_FAILED', { message: 'Event "arrival" failed at time 2: boom', cause }),
    );
    expect(sim.now).toBe(2);
    expect(sim.running).toBe(false);
    expect(sim.run().reason).toBe('empty');
    expect(sim.now).toBe(3);
  });

  it('refuses to run or step from inside an event', () => {
    const sim = new Simulation();
    sim.schedule(1, () => sim.run());
    expect(() => sim.run()).toThrow(simulationError('EVENT_FAILED', { cause: simulationError('REENTRANT_CALL') }));
    sim.schedule(1, () => sim.step());
    expect(() => sim.step()).toThrow(simulationError('EVENT_FAILED', { cause: simulationError('REENTRANT_CALL') }));
  });
});
