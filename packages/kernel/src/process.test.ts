import { describe, expect, it } from 'vitest';

import { type ProcessBody, timeout } from './process.js';
import { Simulation } from './simulation.js';
import { containing, simulationError } from './test-helpers.js';

describe('processes: timeouts', () => {
  it('wakes a process after each timeout', () => {
    const sim = new Simulation();
    const wakeTimes: number[] = [];
    function* body(): ProcessBody {
      wakeTimes.push(sim.now);
      yield timeout(2);
      wakeTimes.push(sim.now);
      yield timeout(0.5);
      wakeTimes.push(sim.now);
      yield timeout(0);
      wakeTimes.push(sim.now);
    }
    sim.process(body());
    sim.run();
    expect(wakeTimes).toEqual([0, 2, 2.5, 2.5]);
  });

  it('starts processes at the current time, in creation order, not synchronously', () => {
    const sim = new Simulation({ startTime: 3 });
    const log: string[] = [];
    function* named(name: string): ProcessBody {
      log.push(`${name} starts at ${String(sim.now)}`);
      yield timeout(1);
      log.push(`${name} wakes at ${String(sim.now)}`);
    }
    const first = sim.process(named('first'));
    sim.process(named('second'));
    expect(log).toEqual([]);
    expect(first.state).toBe('created');

    sim.run();
    expect(log).toEqual([
      'first starts at 3',
      'second starts at 3',
      'first wakes at 4',
      'second wakes at 4',
    ]);
  });

  it('wakes earlier for a smaller timeout priority', () => {
    const sim = new Simulation();
    const log: string[] = [];
    function* sleeper(name: string, priority: number): ProcessBody {
      yield timeout(1, { priority });
      log.push(name);
    }
    sim.process(sleeper('normal', 0));
    sim.process(sleeper('urgent', -1));
    sim.run();
    expect(log).toEqual(['urgent', 'normal']);
  });

  it('lets a process start another process, which starts at the same time', () => {
    const sim = new Simulation();
    const log: string[] = [];
    function* child(): ProcessBody {
      log.push(`child starts at ${String(sim.now)}`);
      yield timeout(1);
      log.push(`child ends at ${String(sim.now)}`);
    }
    function* parent(): ProcessBody {
      yield timeout(5);
      sim.process(child(), { name: 'child' });
      log.push('parent continues');
      yield timeout(0);
      log.push('parent after zero delay');
    }
    sim.process(parent());
    sim.run();
    expect(log).toEqual([
      'parent continues',
      'child starts at 5',
      'parent after zero delay',
      'child ends at 6',
    ]);
  });

  it('composes waits with yield*', () => {
    const sim = new Simulation();
    function* pause(steps: number): ProcessBody<number> {
      for (let i = 0; i < steps; i++) yield timeout(1);
      return steps;
    }
    let waited = 0;
    function* body(): ProcessBody {
      waited = yield* pause(3);
    }
    sim.process(body());
    sim.run();
    expect(waited).toBe(3);
    expect(sim.now).toBe(3);
  });

  it('reports state, name and result', () => {
    const sim = new Simulation();
    const signal = sim.signal('go');
    function* body(): ProcessBody<string> {
      yield timeout(1);
      yield signal.wait();
      return 'done';
    }
    const process = sim.process(body(), { name: 'worker' });
    expect(process.name).toBe('worker');
    expect(sim.process(body()).name).toBe('process-2');

    sim.run(0.5);
    expect(process.state).toBe('suspended');
    sim.run(2);
    expect(process.state).toBe('suspended');
    signal.notify();
    sim.run();
    expect(process.state).toBe('finished');
    expect(process.result).toBe('done');
  });
});

describe('processes: signals', () => {
  it('wakes every waiting process in the order they started waiting', () => {
    const sim = new Simulation();
    const door = sim.signal('door');
    const log: string[] = [];
    function* visitor(name: string, arrival: number): ProcessBody {
      yield timeout(arrival);
      const message = yield door.wait();
      log.push(`${name} at ${String(sim.now)}: ${String(message)}`);
    }
    sim.process(visitor('c', 3));
    sim.process(visitor('a', 1));
    sim.process(visitor('b', 2));
    sim.schedule(10, () => {
      expect(door.waiting).toBe(3);
      expect(door.notify('open')).toBe(3);
      expect(door.waiting).toBe(0);
    });
    sim.run();
    expect(log).toEqual(['a at 10: open', 'b at 10: open', 'c at 10: open']);
  });

  it('wakes only the processes that were waiting when notified', () => {
    const sim = new Simulation();
    const bell = sim.signal('bell');
    const log: string[] = [];
    function* listener(name: string): ProcessBody {
      yield bell.wait();
      log.push(`${name} woke at ${String(sim.now)}`);
      yield bell.wait();
      log.push(`${name} woke again at ${String(sim.now)}`);
    }
    sim.process(listener('early'));
    sim.schedule(1, () => {
      bell.notify();
      // Starts waiting after the notification, so the next one wakes it.
      sim.process(listener('late'));
    });
    sim.schedule(2, () => bell.notify());
    sim.run();
    expect(log).toEqual(['early woke at 1', 'early woke again at 2', 'late woke at 2']);
  });

  it('does not remember a notification nobody waited for', () => {
    const sim = new Simulation();
    const bell = sim.signal();
    expect(bell.notify()).toBe(0);
    const log: number[] = [];
    function* body(): ProcessBody {
      yield bell.wait();
      log.push(sim.now);
    }
    const process = sim.process(body());
    sim.run();
    expect(log).toEqual([]);
    expect(process.state).toBe('suspended');
  });

  it('wakes waiters after the events already waiting at that time, unless told otherwise', () => {
    const sim = new Simulation();
    const signal = sim.signal();
    const log: string[] = [];
    function* waiter(name: string): ProcessBody {
      yield signal.wait();
      log.push(name);
    }
    sim.process(waiter('normal waiter'));
    sim.schedule(1, () => signal.notify());
    sim.schedule(1, () => log.push('other event at 1'));
    sim.run();

    sim.process(waiter('urgent waiter'));
    sim.schedule(1, () => signal.notify(undefined, { priority: -1 }));
    sim.schedule(1, () => log.push('other event at 2'));
    sim.run();

    expect(log).toEqual(['other event at 1', 'normal waiter', 'urgent waiter', 'other event at 2']);
  });

  it('calls plain listeners as events, in order with waiting processes', () => {
    const sim = new Simulation();
    const signal = sim.signal();
    const log: string[] = [];
    function* waiter(): ProcessBody {
      const value = yield signal.wait();
      log.push(`process got ${String(value)}`);
    }
    sim.process(waiter());
    sim.run();
    signal.once((value) => log.push(`listener got ${String(value)}`));
    signal.notify(7);
    expect(log).toEqual([]);
    sim.run();
    expect(log).toEqual(['process got 7', 'listener got 7']);
  });
});

describe('processes: errors', () => {
  it('rejects negative, NaN and infinite timeouts where they are created', () => {
    expect(() => timeout(-1)).toThrow(simulationError('NEGATIVE_DELAY'));
    expect(() => timeout(Number.NaN)).toThrow(simulationError('NOT_A_NUMBER'));
    expect(() => timeout(Infinity)).toThrow(simulationError('NOT_FINITE'));
    expect(() => timeout(1, { priority: Number.NaN })).toThrow(simulationError('NOT_A_NUMBER'));
    expect(() => timeout(-1)).toThrow('timeout() delay must not be negative, got -1');
  });

  it('names the process and the time when a process fails', () => {
    const sim = new Simulation();
    function* body(): ProcessBody {
      yield timeout(4);
      yield timeout(-1);
    }
    const process = sim.process(body(), { name: 'customer-3' });
    expect(() => sim.run()).toThrow(
      simulationError('PROCESS_FAILED', {
        message: 'Process "customer-3" failed at time 4: timeout() delay must not be negative, got -1',
        cause: simulationError('NEGATIVE_DELAY'),
      }),
    );
    expect(process.state).toBe('failed');
    expect(process.error).toEqual(simulationError('NEGATIVE_DELAY'));
  });

  it('rejects a yielded value that is not a command', () => {
    const sim = new Simulation();
    function* body(): Generator {
      yield 5;
    }
    sim.process(body() as ProcessBody, { name: 'confused' });
    expect(() => sim.run()).toThrow(
      simulationError('PROCESS_FAILED', {
        cause: simulationError('INVALID_YIELD', {
          message: 'Process "confused" yielded 5; a process can yield timeout(...) or signal.wait()',
        }),
      }),
    );
  });

  it('lets the process catch an invalid yield at the yield itself', () => {
    const sim = new Simulation();
    let caught: unknown;
    function* body(): Generator {
      try {
        yield 'not a command';
      } catch (problem) {
        caught = problem;
      }
      yield timeout(1);
    }
    const process = sim.process(body() as ProcessBody);
    sim.run();
    expect(caught).toEqual(simulationError('INVALID_YIELD'));
    expect(process.state).toBe('finished');
  });

  it('rejects waiting on a signal of another simulation', () => {
    const sim = new Simulation();
    const foreign = new Simulation().signal();
    function* body(): ProcessBody {
      yield foreign.wait();
    }
    sim.process(body());
    expect(() => sim.run()).toThrow(
      simulationError('PROCESS_FAILED', { cause: simulationError('INVALID_YIELD') }),
    );
  });

  it('explains how to pass a generator', () => {
    const sim = new Simulation();
    function* body(): ProcessBody {
      yield timeout(1);
    }
    expect(() => sim.process(body as unknown as ProcessBody)).toThrow(
      simulationError('INVALID_ARGUMENT', { message: containing('call the generator function') }),
    );
  });
});
