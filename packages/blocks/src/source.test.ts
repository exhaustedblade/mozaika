import { type Agent, AgentPopulation, defineStatechart, Random, Simulation } from '@mozaika/kernel';
import { describe, expect, it } from 'vitest';

import { Delay, type EntityFactory, ResourcePool, Service, Sink, Source } from './index.js';
import { containing, Recorder, simulationError } from './test-support/helpers.js';

describe('Source', () => {
  it('creates entities after each interval, numbered in creation order', () => {
    const sim = new Simulation();
    const source = new Source(sim, { name: 'arrivals', interval: 2, limit: 3 });
    const recorder = source.connect(new Recorder(sim));
    sim.run();
    expect(recorder.visits).toEqual([
      { id: 1, time: 2 },
      { id: 2, time: 4 },
      { id: 3, time: 6 },
    ]);
    expect(source.arrivals).toBe(3);
    expect(source.lost).toBe(0);
  });

  it('records the creation time of each entity', () => {
    const sim = new Simulation({ startTime: 10 });
    const source = new Source(sim, { name: 'arrivals', interval: 1.5, limit: 2 });
    const delay = source.connect(new Delay(sim, { name: 'walk', duration: 4 }));
    const sink = delay.connect(new Sink(sim, { name: 'exit' }));
    sim.run();
    // Created at 11.5 and 13, each spends 4 time units in the delay.
    expect(sink.stats.timeInSystem.mean).toBe(4);
  });

  it('draws intervals from its own stream, blocks/<name>', () => {
    const seed = 7;
    const sim = new Simulation({ seed });
    const source = new Source(sim, { name: 'arrivals', interval: (random) => random.exponential(3), limit: 5 });
    const recorder = source.connect(new Recorder(sim));
    sim.run();

    const stream = new Random(seed, ['blocks', 'arrivals']);
    let time = 0;
    const expected = Array.from({ length: 5 }, () => (time += stream.exponential(3)));
    expect(recorder.visits.map((visit) => visit.time)).toEqual(expected);
  });

  it('keeps its arrival times when other blocks change', () => {
    function arrivalTimes(serviceMean: number): number[] {
      const sim = new Simulation({ seed: 3 });
      const servers = new ResourcePool(sim, { capacity: 1 });
      const source = new Source(sim, { name: 'arrivals', interval: (random) => random.exponential(1), limit: 50 });
      const service = source.connect(
        new Service(sim, { name: 'service', pool: servers, duration: (random) => random.exponential(serviceMean) }),
      );
      const recorder = service.connect(new Recorder(sim));
      sim.run();
      return recorder.entities.map((entity) => entity.createdAt);
    }
    const withFastService = arrivalTimes(0.5);
    expect(withFastService).toHaveLength(50);
    expect(arrivalTimes(2)).toEqual(withFastService);
  });

  it('loses an arrival when the next block has no room', () => {
    const sim = new Simulation();
    const source = new Source(sim, { name: 'arrivals', interval: 1, limit: 6 });
    // One place, held for 2.5: arrivals at 1 and 4 get in, those at 2, 3, 5 and 6 are lost.
    const delay = source.connect(new Delay(sim, { name: 'booth', duration: 2.5, capacity: 1 }));
    const recorder = delay.connect(new Recorder(sim));
    sim.run();
    expect(recorder.visits).toEqual([
      { id: 1, time: 3.5 },
      { id: 4, time: 6.5 },
    ]);
    expect(source.arrivals).toBe(6);
    expect(source.lost).toBe(4);
  });

  it('makes each entity with its factory, given the id and the creation time', () => {
    const sim = new Simulation();
    const customer = defineStatechart({ initial: 'in', context: { vip: false }, states: { in: {} } });
    const customers = new AgentPopulation(sim, { name: 'customers', statechart: customer });
    const given: [number, number][] = [];
    const source = new Source(sim, {
      name: 'arrivals',
      interval: 2,
      limit: 3,
      entity: (id, createdAt) => {
        given.push([id, createdAt]);
        return customers.add({ vip: id % 2 === 0 });
      },
    });
    const recorder = source.connect(new Recorder(sim));
    sim.run();
    expect(given).toEqual([
      [1, 2],
      [2, 4],
      [3, 6],
    ]);
    expect(recorder.entities.map((entity) => (entity.context as { vip: boolean }).vip)).toEqual([false, true, false]);
    expect(recorder.entities.every((entity) => entity.population === customers)).toBe(true);
    expect(recorder.visits).toEqual([
      { id: 1, time: 2 },
      { id: 2, time: 4 },
      { id: 3, time: 6 },
    ]);
    // With a factory, the source has no population of its own.
    expect(source.population).toBeUndefined();
  });

  it('calls the factory only for arrivals that get in; lost ones still use up their ids', () => {
    const sim = new Simulation();
    const tickets = new AgentPopulation(sim, { name: 'tickets', statechart: defineStatechart({ initial: 'a', states: { a: {} } }) });
    const made: number[] = [];
    const source = new Source(sim, {
      name: 'arrivals',
      interval: 1,
      limit: 6,
      entity: (id) => {
        made.push(id);
        return tickets.add({}, { id });
      },
    });
    // The same booth as in the test above: arrivals 1 and 4 get in.
    const recorder = source.connect(new Delay(sim, { name: 'booth', duration: 2.5, capacity: 1 })).connect(new Recorder(sim));
    sim.run();
    expect(made).toEqual([1, 4]);
    expect(recorder.ids).toEqual([1, 4]);
    expect(source.lost).toBe(4);
  });

  it('makes agents of its own population by default, numbered by arrival across all sources', () => {
    const sim = new Simulation();
    const recorder = new Recorder(sim);
    const morning = new Source(sim, { name: 'morning', interval: 2, limit: 2 }); // 2, 4
    const evening = new Source(sim, { name: 'evening', interval: 3, limit: 2 }); // 3, 6
    morning.connect(recorder);
    evening.connect(recorder);
    sim.run();
    expect(recorder.visits).toEqual([
      { id: 1, time: 2 },
      { id: 2, time: 3 },
      { id: 3, time: 4 },
      { id: 4, time: 6 },
    ]);
    expect(recorder.entities.map((agent) => agent.population.name)).toEqual(['morning', 'evening', 'morning', 'evening']);
    expect([...(morning.population?.ids() ?? [])]).toEqual([1, 3]);
    expect([...(evening.population?.ids() ?? [])]).toEqual([2, 4]);
    expect(recorder.entities.map((agent) => agent.createdAt)).toEqual([2, 3, 4, 6]);
  });

  it('gives simple entities no fields: they share one empty, frozen context', () => {
    const sim = new Simulation();
    const source = new Source(sim, { name: 'arrivals', interval: 1, limit: 2 });
    const recorder = source.connect(new Recorder(sim));
    sim.run();
    const [first, second] = recorder.entities as [Agent, Agent];
    expect(first.context).toEqual({});
    expect(Object.isFrozen(first.context)).toBe(true);
    expect(second.context).toBe(first.context);
  });

  it('refuses a population name that the model already uses, and keeps its block name free', () => {
    const sim = new Simulation();
    new AgentPopulation(sim, { name: 'customers', statechart: defineStatechart({ initial: 'a', states: { a: {} } }) });
    expect(() => new Source(sim, { name: 'customers', interval: 1 })).toThrow(
      simulationError('INVALID_ARGUMENT', { message: containing('"customers"') }),
    );
    expect(() => new Sink(sim, { name: 'customers' })).not.toThrow();
  });

  it('fails when the factory does not return an agent of the simulation', () => {
    const other = new Simulation();
    const strangers = new AgentPopulation(other, { name: 'strangers', statechart: defineStatechart({ initial: 'a', states: { a: {} } }) });
    for (const entity of [() => undefined as unknown as Agent, () => ({ id: 1, createdAt: 0 }) as unknown as Agent, () => strangers.add()]) {
      const sim = new Simulation();
      const source = new Source(sim, { name: 'arrivals', interval: 1, entity });
      source.connect(new Recorder(sim));
      expect(() => sim.run()).toThrow(
        simulationError('EVENT_FAILED', {
          cause: simulationError('INVALID_ARGUMENT', { message: containing('entity factory') }),
        }),
      );
    }
  });

  it('stops after the limit and creates nothing for a limit of zero', () => {
    const sim = new Simulation();
    const silent = new Source(sim, { name: 'silent', interval: 1, limit: 0 });
    silent.connect(new Recorder(sim));
    const { events } = sim.run(100);
    expect(silent.arrivals).toBe(0);
    expect(events).toBe(1); // only the start of the source
  });

  it('refuses invalid options', () => {
    const sim = new Simulation();
    expect(() => new Source(sim, { name: '', interval: 1 })).toThrow(simulationError('INVALID_ARGUMENT'));
    expect(() => new Source(sim, { name: 'a', interval: -1 })).toThrow(simulationError('NEGATIVE_DELAY'));
    expect(() => new Source(sim, { name: 'b', interval: Number.NaN })).toThrow(simulationError('NOT_A_NUMBER'));
    expect(() => new Source(sim, { name: 'c', interval: 1, limit: 2.5 })).toThrow(simulationError('INVALID_ARGUMENT'));
    expect(() => new Source(sim, { name: 'd', interval: 1, limit: -1 })).toThrow(simulationError('INVALID_ARGUMENT'));
    expect(() => new Source(sim, { name: 'e', interval: 1, entity: 'customer' as unknown as EntityFactory })).toThrow(
      simulationError('INVALID_ARGUMENT'),
    );
  });

  it('refuses an interval drawn from the distribution that is negative', () => {
    const sim = new Simulation();
    const source = new Source(sim, { name: 'arrivals', interval: () => -1 });
    source.connect(new Recorder(sim));
    expect(() => sim.run()).toThrow(
      simulationError('EVENT_FAILED', {
        cause: simulationError('NEGATIVE_DELAY', { message: containing('"arrivals"') }),
      }),
    );
  });

  it('fails when an entity arrives and the source is not connected', () => {
    const sim = new Simulation();
    new Source(sim, { name: 'arrivals', interval: 1 });
    expect(() => sim.run()).toThrow(
      simulationError('EVENT_FAILED', {
        cause: simulationError('INVALID_STATE', { message: containing('"arrivals"') }),
      }),
    );
  });

  it('refuses a second block with the same name in one simulation', () => {
    const sim = new Simulation();
    new Source(sim, { name: 'arrivals', interval: 1 });
    expect(() => new Sink(sim, { name: 'arrivals' })).toThrow(
      simulationError('INVALID_ARGUMENT', { message: containing('"arrivals"') }),
    );
    // Another simulation has its own names.
    expect(() => new Sink(new Simulation(), { name: 'arrivals' })).not.toThrow();
  });
});
