import { describe, expect, it } from 'vitest';

import { Random } from '../random.js';
import { Simulation } from '../simulation.js';
import { containing, describeEvent, simulationError } from '../test-helpers.js';
import type { AgentArgs } from './definition.js';
import { AgentPopulation } from './population.js';
import { defineStatechart, rate } from './statechart.js';

/** An entry action, for statecharts with any fields, that logs "<time> <state>" each time a state is entered. */
function logEntry(log: string[]): <TContext extends object>(args: AgentArgs<TContext>) => void {
  return ({ agent, now }) => {
    log.push(`${String(now)} ${agent.state}`);
  };
}

describe('agents: timeouts', () => {
  it('moves after the timeout, counted from entering the state', () => {
    const sim = new Simulation();
    const log: string[] = [];
    const enter = logEntry(log);
    const chart = defineStatechart({
      initial: 'a',
      states: {
        a: { entry: enter, after: { 5: 'b' } },
        b: { entry: enter, after: { 2.5: 'c' } },
        c: { entry: enter, type: 'final' },
      },
    });
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: chart });
    sim.run(1);
    const agent = agents.add();
    sim.run();
    expect(log).toEqual(['1 a', '6 b', '8.5 c']);
    expect(agent.state).toBe('c');
    expect(agent.done).toBe(true);
  });

  it('computes a named delay at entry, after the entry actions, from the fields', () => {
    const sim = new Simulation();
    const chart = defineStatechart(
      {
        initial: 'waiting',
        context: { patience: 3 },
        states: {
          waiting: {
            entry: ({ context }) => {
              context.patience = 4;
            },
            after: { patience: 'impatient' },
          },
          impatient: {},
        },
      },
      { delays: { patience: ({ context }) => context.patience } },
    );
    const agent = new AgentPopulation(sim, { name: 'customers', statechart: chart }).add();
    sim.run(3.9);
    expect(agent.state).toBe('waiting');
    sim.run(4);
    expect(agent.state).toBe('impatient');
  });

  it('cancels the timeout when the agent leaves the state', () => {
    const times: number[] = [];
    const sim = new Simulation({ trace: (event) => times.push(event.time) });
    const log: string[] = [];
    const enter = logEntry(log);
    const chart = defineStatechart({
      initial: 'a',
      states: {
        a: { entry: enter, after: { 10: 'late' }, on: { go: 'b' } },
        b: { entry: enter },
        late: { entry: enter },
      },
    });
    const agent = new AgentPopulation(sim, { name: 'agents', statechart: chart }).add();
    expect(sim.pendingEvents).toBe(1);
    sim.schedule(3, () => {
      agent.send({ type: 'go' });
    });
    sim.run();
    expect(log).toEqual(['0 a', '3 b']);
    expect(sim.pendingEvents).toBe(0);
    // The cancelled timeout never fired: no event at time 10.
    expect(times).toEqual([3, 3]);
  });

  it('does nothing when the guard of the timeout is false; the timeout is used up', () => {
    const sim = new Simulation();
    const chart = defineStatechart({
      initial: 'a',
      states: { a: { after: { 2: { target: 'b', guard: () => false } } }, b: {} },
    });
    const agent = new AgentPopulation(sim, { name: 'agents', statechart: chart }).add();
    expect(sim.run()).toEqual({ reason: 'empty', time: 2, events: 1 });
    expect(agent.state).toBe('a');
  });

  it('never fires a timeout of Infinity', () => {
    const sim = new Simulation();
    const chart = defineStatechart(
      { initial: 'a', states: { a: { after: { never: 'b' } }, b: {} } },
      { delays: { never: Infinity } },
    );
    new AgentPopulation(sim, { name: 'agents', statechart: chart }).add();
    expect(sim.pendingEvents).toBe(0);
  });

  it('restarts the timers on a re-entering self-transition, but not on a plain one', () => {
    const sim = new Simulation();
    const log: string[] = [];
    const chart = defineStatechart({
      initial: 'a',
      states: {
        a: {
          entry: ({ agent, now }) => log.push(`${String(now)} agent ${String(agent.id)} enters a`),
          exit: ({ agent, now }) => log.push(`${String(now)} agent ${String(agent.id)} leaves a`),
          after: { 5: 'b' },
          on: {
            stay: { target: 'a', actions: ({ agent }) => log.push(`agent ${String(agent.id)} stays`) },
            again: { target: 'a', reenter: true },
          },
        },
        b: { entry: ({ agent, now }) => log.push(`${String(now)} agent ${String(agent.id)} enters b`) },
      },
    });
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: chart });
    const plain = agents.add();
    const reentering = agents.add();
    sim.schedule(3, () => {
      plain.send({ type: 'stay' });
      reentering.send({ type: 'again' });
    });
    sim.run();
    expect(log).toEqual([
      '0 agent 1 enters a',
      '0 agent 2 enters a',
      'agent 1 stays',
      '3 agent 2 leaves a',
      '3 agent 2 enters a',
      '5 agent 1 leaves a',
      '5 agent 1 enters b',
      '8 agent 2 leaves a',
      '8 agent 2 enters b',
    ]);
  });
});

describe('agents: rates', () => {
  it('draws the delay of a rate transition from the stream of that delay', () => {
    const seed = 11;
    const sim = new Simulation({ seed });
    const times: number[] = [];
    const chart = defineStatechart(
      {
        initial: 'a',
        context: { speed: 0.5 },
        states: {
          a: { entry: ({ now }) => times.push(now), after: { toB: 'b' } },
          b: { entry: ({ now }) => times.push(now), after: { toA: 'a' } },
        },
      },
      { delays: { toB: rate(2), toA: rate(({ context }) => context.speed) } },
    );
    new AgentPopulation(sim, { name: 'flips', statechart: chart }).add();
    sim.run(20);

    const toB = new Random(seed, ['agents', 'flips', 'toB']);
    const toA = new Random(seed, ['agents', 'flips', 'toA']);
    const expected = [0];
    let time = 0;
    while (expected.length < times.length) {
      time += expected.length % 2 === 1 ? toB.exponential(1 / 2) : toA.exponential(1 / 0.5);
      expected.push(time);
    }
    expect(times.length).toBeGreaterThan(5);
    expect(times).toEqual(expected);
  });

  it('never fires a rate of zero and draws nothing for it', () => {
    const sim = new Simulation();
    const chart = defineStatechart(
      { initial: 'a', states: { a: { after: { off: 'b' } }, b: {} } },
      { delays: { off: rate(0) } },
    );
    new AgentPopulation(sim, { name: 'agents', statechart: chart }).add();
    expect(sim.pendingEvents).toBe(0);
  });

  it('fails when a rate function gives a negative rate', () => {
    const sim = new Simulation();
    const chart = defineStatechart(
      { initial: 'a', states: { a: { after: { bad: 'a' } } } },
      { delays: { bad: rate(() => -1) } },
    );
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: chart });
    expect(() => agents.add()).toThrow(simulationError('AGENT_FAILED', { cause: simulationError('INVALID_ARGUMENT') }));
  });
});

describe('agents: messages', () => {
  it('delivers a message as an event at the current time, after the events already due', () => {
    const sim = new Simulation();
    const log: string[] = [];
    const chart = defineStatechart({ initial: 'a', states: { a: { on: { go: 'b' } }, b: { entry: logEntry(log) } } });
    const agent = new AgentPopulation(sim, { name: 'agents', statechart: chart }).add();
    sim.schedule(2, () => {
      agent.send({ type: 'go' });
      log.push(`sent, still in ${agent.state}`);
    });
    sim.schedule(2, () => log.push('other event at 2'));
    sim.run();
    expect(log).toEqual(['sent, still in a', 'other event at 2', '2 b']);
  });

  it('takes the first transition whose guard holds and passes the message to guards and actions', () => {
    const sim = new Simulation();
    const paid: number[] = [];
    const chart = defineStatechart({
      initial: 'shop',
      states: {
        shop: {
          on: {
            pay: [
              {
                guard: ({ event }) => Number(event.amount) > 10,
                target: 'rich',
                actions: ({ event }) => paid.push(Number(event.amount)),
              },
              { target: 'poor' },
            ],
          },
        },
        rich: {},
        poor: {},
      },
    });
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: chart });
    const big = agents.add();
    const small = agents.add();
    big.send({ type: 'pay', amount: 20 });
    small.send({ type: 'pay', amount: 5 });
    sim.run();
    expect([big.state, small.state]).toEqual(['rich', 'poor']);
    expect(paid).toEqual([20]);
  });

  it('discards a message with no matching transition and counts it', () => {
    const sim = new Simulation();
    const chart = defineStatechart({
      initial: 'a',
      states: { a: { on: { go: { target: 'b', guard: () => false } } }, b: {}, end: { type: 'final' } },
    });
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: chart });
    const agent = agents.add();
    agent.send({ type: 'hello' }); // no transition for this type
    agent.send({ type: 'go' }); // a transition, but its guard is false
    sim.run();
    expect(agent.state).toBe('a');
    expect(agents.discardedMessages).toBe(2);
  });

  it('runs exit actions, then the actions of the transition, then entry actions', () => {
    const sim = new Simulation();
    const log: string[] = [];
    const chart = defineStatechart({
      initial: 'a',
      states: {
        a: {
          exit: ({ agent }) => log.push(`exit a, state ${agent.state}`),
          on: { go: { target: 'b', actions: ({ agent }) => log.push(`action, state ${agent.state}`) } },
        },
        b: { entry: ({ agent }) => log.push(`entry b, state ${agent.state}`) },
      },
    });
    new AgentPopulation(sim, { name: 'agents', statechart: chart }).add().send({ type: 'go' });
    sim.run();
    expect(log).toEqual(['exit a, state a', 'action, state a', 'entry b, state b']);
  });

  it('refuses a message without a string type', () => {
    const sim = new Simulation();
    const chart = defineStatechart({ initial: 'a', states: { a: {} } });
    const agent = new AgentPopulation(sim, { name: 'agents', statechart: chart }).add();
    expect(() => {
      agent.send({ kind: 'go' } as unknown as { type: string });
    }).toThrow(simulationError('INVALID_ARGUMENT'));
  });
});

describe('agents: conditions', () => {
  it('checks a condition right after entering a state, the initial one included', () => {
    const sim = new Simulation();
    const log: string[] = [];
    const enter = logEntry(log);
    const chart = defineStatechart({
      initial: 'a',
      context: { ready: true },
      states: {
        a: { entry: enter, always: { guard: ({ context }) => context.ready, target: 'b' } },
        b: { entry: enter, always: 'c' },
        c: { entry: enter },
      },
    });
    const agent = new AgentPopulation(sim, { name: 'agents', statechart: chart }).add();
    // Eventless transitions run inside add(), at the same moment, without events.
    expect(agent.state).toBe('c');
    expect(log).toEqual(['0 a', '0 b', '0 c']);
    expect(sim.pendingEvents).toBe(0);
  });

  it('does not poll: a condition made true by other code waits for an event of the agent or a check', () => {
    const sim = new Simulation();
    const world = { open: false };
    const chart = defineStatechart({
      initial: 'closed',
      states: {
        closed: { on: { ping: { actions: () => undefined } }, always: { guard: () => world.open, target: 'open' } },
        open: {},
      },
    });
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: chart });
    const pinged = agents.add();
    const checked = agents.add();
    const forgotten = agents.add();
    sim.schedule(1, () => {
      world.open = true;
    });
    sim.schedule(5, () => {
      pinged.send({ type: 'ping' }); // a transition without a target: the condition is checked after it
    });
    sim.schedule(7, () => {
      checked.check();
    });
    sim.run(10);
    expect(sim.eventsProcessed).toBe(4); // three scheduled events and one message: no polling
    expect([pinged.state, checked.state, forgotten.state]).toEqual(['open', 'open', 'closed']);
  });

  it('checks the condition after a discarded message and after a timeout without a transition', () => {
    const sim = new Simulation();
    const world = { open: false };
    const log: string[] = [];
    const chart = defineStatechart({
      initial: 'closed',
      states: {
        closed: {
          after: { 4: { target: 'open', guard: () => false } },
          always: { guard: () => world.open, target: 'open' },
        },
        open: { entry: ({ agent, now }) => log.push(`${String(now)} agent ${String(agent.id)} opens`) },
      },
    });
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: chart });
    const byMessage = agents.add();
    agents.add();
    sim.schedule(1, () => {
      world.open = true;
    });
    sim.schedule(2, () => {
      byMessage.send({ type: 'nothing to do with it' });
    });
    sim.run();
    expect(log).toEqual(['2 agent 1 opens', '4 agent 2 opens']);
    expect(agents.discardedMessages).toBe(1);
  });

  it('checks every agent of the population on population.check(), in creation order', () => {
    const sim = new Simulation();
    const log: number[] = [];
    let open = false;
    const chart = defineStatechart({
      initial: 'closed',
      states: {
        closed: { always: { guard: () => open, target: 'open' } },
        open: { entry: ({ agent }) => log.push(agent.id) },
      },
    });
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: chart });
    for (let i = 0; i < 3; i++) agents.add();
    open = true;
    agents.check();
    expect(log).toEqual([1, 2, 3]);
    expect(agents.count('open')).toBe(3);
  });

  it('ignores check() from inside its own step: the step checks the conditions at its end', () => {
    const sim = new Simulation();
    const chart = defineStatechart({
      initial: 'a',
      context: { count: 0 },
      states: {
        a: {
          on: {
            bump: {
              actions: ({ agent, context }) => {
                context.count++;
                agent.check(); // no effect here
                expect(agent.state).toBe('a');
              },
            },
          },
          always: { guard: ({ context }) => context.count > 0, target: 'b' },
        },
        b: {},
      },
    });
    const agent = new AgentPopulation(sim, { name: 'agents', statechart: chart }).add();
    agent.send({ type: 'bump' });
    sim.run();
    expect(agent.state).toBe('b');
  });

  it('fails when eventless transitions loop', () => {
    const sim = new Simulation();
    const chart = defineStatechart({
      initial: 'a',
      states: { a: { always: { guard: () => true, target: 'b' } }, b: { always: { guard: () => true, target: 'a' } } },
    });
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: chart });
    expect(() => agents.add()).toThrow(
      simulationError('AGENT_FAILED', { cause: simulationError('INVALID_STATE', { message: containing('loop') }) }),
    );
  });
});

describe('agents: simultaneous events', () => {
  it('fires timeouts due at the same moment in the order they were set', () => {
    const sim = new Simulation();
    const log: string[] = [];
    const chart = defineStatechart(
      {
        initial: 'a',
        context: { wait: 0 },
        states: {
          a: { after: { wait: 'b' } },
          b: { entry: ({ agent, now }) => log.push(`${String(now)} agent ${String(agent.id)}`) },
        },
      },
      { delays: { wait: ({ context }) => context.wait } },
    );
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: chart });
    agents.add({ wait: 2 }); // its timeout is set first, at time 0
    sim.run(1);
    agents.add({ wait: 1 }); // set at time 1, due at 2 as well
    sim.run();
    expect(log).toEqual(['2 agent 1', '2 agent 2']);
  });

  it('fires a timeout due now before a message sent now, which then meets the new state', () => {
    const sim = new Simulation();
    const chart = defineStatechart({
      initial: 'a',
      states: { a: { after: { 2: 'b' }, on: { go: 'c' } }, b: {}, c: {} },
    });
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: chart });
    const agent = agents.add();
    sim.schedule(2, () => {
      agent.send({ type: 'go' });
    });
    sim.run();
    expect(agent.state).toBe('b');
    expect(agents.discardedMessages).toBe(1);
  });

  it('lets the first of two equal timeouts of a state win and cancels the other', () => {
    const sim = new Simulation();
    const chart = defineStatechart(
      { initial: 'a', states: { a: { after: { first: 'b', second: 'c' } }, b: {}, c: {} } },
      { delays: { first: 2, second: 2 } },
    );
    const agent = new AgentPopulation(sim, { name: 'agents', statechart: chart }).add();
    expect(sim.run()).toEqual({ reason: 'empty', time: 2, events: 1 });
    expect(agent.state).toBe('b');
  });
});

describe('agents: final states', () => {
  it('stops in a final state: no timers or conditions, messages are discarded', () => {
    const sim = new Simulation();
    const chart = defineStatechart({
      initial: 'a',
      states: { a: { on: { stop: 'end' }, after: { 5: 'a' } }, end: { type: 'final' } },
    });
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: chart });
    const agent = agents.add();
    agent.send({ type: 'stop' });
    sim.run(1);
    expect(agent.done).toBe(true);
    expect(sim.pendingEvents).toBe(0);
    agent.send({ type: 'stop' });
    agent.check();
    sim.run();
    expect(agent.state).toBe('end');
    expect(agents.discardedMessages).toBe(1);
  });
});

describe('agents: errors', () => {
  it('names the agent, the time and the state when an action fails', () => {
    const sim = new Simulation();
    const chart = defineStatechart({
      initial: 'a',
      states: {
        a: { after: { 2: 'b' } },
        b: {
          entry: () => {
            throw new Error('boom');
          },
        },
      },
    });
    const agents = new AgentPopulation(sim, { name: 'customers', statechart: chart });
    agents.add();
    agents.add();
    expect(() => sim.run()).toThrow(
      simulationError('AGENT_FAILED', {
        message: 'Agent "customers#1" failed at time 2 in state "b": boom',
        cause: new Error('boom'),
      }),
    );
  });

  it('fails on a delay that is negative or not a number', () => {
    const sim = new Simulation();
    const chart = defineStatechart({ initial: 'a', states: { a: { after: { d: 'a' } } } }, { delays: { d: () => -1 } });
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: chart });
    expect(() => agents.add()).toThrow(simulationError('AGENT_FAILED', { cause: simulationError('NEGATIVE_DELAY') }));
  });

  it('labels the events of agents with the agent and the transition', () => {
    const trace: string[] = [];
    const sim = new Simulation({ trace: (event) => trace.push(describeEvent(event)) });
    const chart = defineStatechart({ initial: 'a', states: { a: { after: { 1: 'b' } }, b: { on: { go: 'a' } } } });
    const agent = new AgentPopulation(sim, { name: 'customers', statechart: chart }).add();
    sim.run();
    agent.send({ type: 'go' });
    sim.run(1);
    expect(trace).toEqual(['1 0 #0 customers#1: a after 1', '1 0 #1 customers#1: message "go"']);
  });

  it('keeps naming an agent in labels after it has moved in the population', () => {
    const trace: string[] = [];
    const sim = new Simulation({ trace: (event) => trace.push(describeEvent(event)) });
    const chart = defineStatechart({ initial: 'a', states: { a: { after: { 2: 'b' } }, b: {} } });
    const customers = new AgentPopulation(sim, { name: 'customers', statechart: chart });
    const first = customers.add();
    customers.add();
    customers.add();
    // Agent 3 takes the place of agent 1.
    customers.remove(first);
    sim.run();
    expect(trace).toEqual(['2 0 #1 customers#2: a after 2', '2 0 #2 customers#3: a after 2']);
  });
});
