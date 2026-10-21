import { Simulation } from '@mozaika/kernel';
import { describe, expect, it } from 'vitest';

import { type BlockAction, Delay, Queue, ResourcePool, Service, Sink, Source } from './index.js';
import { containing, simulationError } from './test-support/helpers.js';

describe('entry and exit actions of the blocks', () => {
  it('run when an entity enters and leaves each block, exit before the entry into the next one', () => {
    const sim = new Simulation();
    const log: string[] = [];
    const note =
      (what: string): BlockAction =>
      ({ agent, block, now }) => {
        log.push(`${String(now)} ${block.name} ${what} #${String(agent.id)}`);
      };
    const clerk = new ResourcePool(sim, { name: 'clerk', capacity: 1 });
    const door = new Source(sim, { name: 'door', interval: 1, limit: 2, onExit: note('exit') });
    door
      .connect(new Queue(sim, { name: 'hall', onEnter: note('enter'), onExit: note('exit') }))
      .connect(
        new Service(sim, { name: 'desk', pool: clerk, duration: 2, capacity: 1, onEnter: note('enter'), onExit: note('exit') }),
      )
      .connect(new Delay(sim, { name: 'walk', duration: 1, onEnter: note('enter'), onExit: note('exit') }))
      .connect(new Sink(sim, { name: 'exit', onEnter: note('enter') }));
    sim.run();
    expect(log).toEqual([
      // Entity 1 passes the queue at once: the desk is free.
      '1 door exit #1',
      '1 hall enter #1',
      '1 hall exit #1',
      '1 desk enter #1',
      // Entity 2 waits in the queue: the desk holds one entity.
      '2 door exit #2',
      '2 hall enter #2',
      // At 3 entity 1 leaves the desk for the walk, and its place at the desk goes to entity 2.
      '3 desk exit #1',
      '3 walk enter #1',
      '3 hall exit #2',
      '3 desk enter #2',
      '4 walk exit #1',
      '4 exit enter #1',
      '5 desk exit #2',
      '5 walk enter #2',
      '6 walk exit #2',
      '6 exit enter #2',
    ]);
  });

  it('see the entity counted on entry and still holding its unit and place on exit', () => {
    const sim = new Simulation();
    const seen: string[] = [];
    const clerk = new ResourcePool(sim, { name: 'clerk', capacity: 1 });
    const door = new Source(sim, { name: 'door', interval: 1, limit: 1 });
    const hall: Queue = door.connect(
      new Queue(sim, {
        name: 'hall',
        onEnter: () => seen.push(`hall length ${String(hall.stats.length.current)}`),
      }),
    );
    const desk: Service = hall.connect(
      new Service(sim, {
        name: 'desk',
        pool: clerk,
        duration: 2,
        capacity: 1,
        onEnter: () => seen.push(`desk content ${String(desk.stats.content.current)}, clerk busy ${String(clerk.busy)}`),
        onExit: () => seen.push(`desk content ${String(desk.stats.content.current)}, clerk busy ${String(clerk.busy)}`),
      }),
    );
    desk.connect(
      new Sink(sim, {
        name: 'exit',
        onEnter: ({ agent }) => seen.push(`in the sink: removed ${String(agent.removed)}, population ${String(agent.population.size)}`),
      }),
    );
    sim.run();
    expect(seen).toEqual([
      'hall length 1',
      // On entry the service has not asked for a clerk yet; on exit it still holds one.
      'desk content 1, clerk busy 0',
      'desk content 1, clerk busy 1',
      // The sink removes the agent after its action.
      'in the sink: removed false, population 1',
    ]);
    expect(door.population?.size).toBe(0);
  });

  it('can message the agent, which gets the message as an event after the current one', () => {
    const sim = new Simulation();
    const door = new Source(sim, { name: 'door', interval: 1, limit: 1 });
    let delivered = false;
    door
      .connect(
        new Delay(sim, {
          name: 'walk',
          duration: 1,
          onEnter: ({ agent }) => {
            agent.send({ type: 'hello' }); // the simple entity has no transition for it
            delivered = agent.population.discardedMessages > 0;
          },
        }),
      )
      .connect(new Sink(sim, { name: 'exit' }));
    sim.run();
    expect(delivered).toBe(false);
    expect(door.population?.discardedMessages).toBe(1);
  });

  it('stop the run with the error of the event they ran in, which names the block and the entity', () => {
    const sim = new Simulation();
    const problem = new Error('no badge');
    const door = new Source(sim, { name: 'door', interval: 1, limit: 1 });
    door
      .connect(new Delay(sim, { name: 'walk', duration: 1 }))
      .connect(
        new Sink(sim, {
          name: 'exit',
          onEnter: () => {
            throw problem;
          },
        }),
      );
    expect(() => sim.run()).toThrow(
      simulationError('EVENT_FAILED', { message: containing('walk: door#1 delay ends'), cause: problem }),
    );
  });

  it('must be functions', () => {
    const sim = new Simulation();
    const pool = new ResourcePool(sim, { capacity: 1 });
    const notAFunction = 'log' as unknown as BlockAction;
    expect(() => new Source(sim, { name: 'a', interval: 1, onExit: notAFunction })).toThrow(simulationError('INVALID_ARGUMENT'));
    expect(() => new Queue(sim, { name: 'b', onEnter: notAFunction })).toThrow(simulationError('INVALID_ARGUMENT'));
    expect(() => new Service(sim, { name: 'c', pool, duration: 1, onExit: notAFunction })).toThrow(
      simulationError('INVALID_ARGUMENT'),
    );
    expect(() => new Delay(sim, { name: 'd', duration: 1, onEnter: notAFunction })).toThrow(simulationError('INVALID_ARGUMENT'));
    expect(() => new Sink(sim, { name: 'e', onEnter: notAFunction })).toThrow(simulationError('INVALID_ARGUMENT'));
  });
});
