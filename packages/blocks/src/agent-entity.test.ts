import { type Agent, type AgentAction, AgentPopulation, defineStatechart, Simulation } from '@mozaika/kernel';
import { describe, expect, it } from 'vitest';

import { Delay, Queue, ResourcePool, Service, Sink, Source } from './index.js';

describe('an agent as an entity', () => {
  it('goes through Source → Queue → Service → Sink and lives by its statechart on the way', () => {
    const sim = new Simulation();
    const history: string[] = [];
    const record: AgentAction<{ patience: number }> = ({ agent, now }) => {
      history.push(`${String(now)} customer ${String(agent.id)} ${agent.state}`);
    };
    const customer = defineStatechart(
      {
        initial: 'waiting',
        context: { patience: 2.5 },
        states: {
          waiting: { entry: record, after: { patience: 'impatient' }, on: { called: 'served' } },
          impatient: { entry: record, on: { called: 'served' } },
          served: { entry: record, type: 'final' },
        },
      },
      { delays: { patience: ({ context }) => context.patience } },
    );
    const customers = new AgentPopulation(sim, { name: 'customers', statechart: customer });
    const created: Agent<{ patience: number }>[] = [];

    // Arrivals at 1, 2, 3, 4; one clerk serves each for 3. The Service holds
    // only the customer being served, so the others wait in the Queue, and
    // entering the Service is the start of service: that is when the desk
    // calls the customer.
    const clerk = new ResourcePool(sim, { name: 'clerk', capacity: 1 });
    const door = new Source(sim, {
      name: 'door',
      interval: 1,
      limit: 4,
      entity: () => {
        const agent = customers.add();
        created.push(agent);
        return agent;
      },
    });
    const hall = door.connect(new Queue(sim, { name: 'hall' }));
    const desk = hall.connect(
      new Service(sim, {
        name: 'desk',
        pool: clerk,
        duration: 3,
        capacity: 1,
        onEnter: ({ agent }) => {
          agent.send({ type: 'called' });
        },
      }),
    );
    const exit = desk.connect(new Sink(sim, { name: 'exit' }));
    sim.run();

    // Customer 1 is called at once and its patience timer is cancelled.
    // Customer 2 waits 2–4: called before its patience (2.5) runs out.
    // Customers 3 and 4 wait 3–7 and 4–10: impatient at 5.5 and 6.5, then called.
    const historyOf = (id: number): string[] => history.filter((line) => line.includes(`customer ${String(id)} `));
    expect(historyOf(1)).toEqual(['1 customer 1 waiting', '1 customer 1 served']);
    expect(historyOf(2)).toEqual(['2 customer 2 waiting', '4 customer 2 served']);
    expect(historyOf(3)).toEqual(['3 customer 3 waiting', '5.5 customer 3 impatient', '7 customer 3 served']);
    expect(historyOf(4)).toEqual(['4 customer 4 waiting', '6.5 customer 4 impatient', '10 customer 4 served']);

    // The flow treats the agents like any entity: created at arrival, out after service.
    expect(exit.count).toBe(4);
    expect(exit.stats.timeInSystem.mean).toBe((3 + 5 + 7 + 9) / 4);
    expect(hall.stats.waitTime.mean).toBe((0 + 2 + 4 + 6) / 4);
    // The sink took them out of their population, each served, and no message was lost.
    expect(customers.size).toBe(0);
    expect(created.map((agent) => [agent.removed, agent.state])).toEqual(Array(4).fill([true, 'served']));
    expect(customers.discardedMessages).toBe(0);
    expect(sim.pendingEvents).toBe(0);
  });

  it('is by default an agent of the source, in its columns while it moves through the blocks', () => {
    const sim = new Simulation();
    const clerk = new ResourcePool(sim, { name: 'clerk', capacity: 1 });
    const door = new Source(sim, { name: 'door', interval: 1, limit: 3 });
    const seen: Agent[] = [];
    const hall = door.connect(new Queue(sim, { name: 'hall' }));
    const desk = hall.connect(new Service(sim, { name: 'desk', pool: clerk, duration: 2, capacity: 1 }));
    const walk = desk.connect(
      new Delay(sim, {
        name: 'walk',
        duration: 0.5,
        onEnter: ({ agent }) => {
          seen.push(agent);
        },
      }),
    );
    const exit = walk.connect(new Sink(sim, { name: 'exit' }));
    const population = door.population;
    if (population === undefined) throw new Error('the source has no population of its own');

    // A simple entity: an agent of a population named after the source, with one state and no fields.
    expect(population.name).toBe('door');
    expect(population.statechart.stateNames).toEqual(['active']);

    // Desk: entity 1 on [1, 3), 2 on [3, 5), 3 on [5, 7); each then walks for 0.5.
    sim.run(3.5);
    // Entity 1 has left: the last agent took its row in the columns.
    expect(population.size).toBe(2);
    expect([...population.ids()]).toEqual([3, 2]);
    expect([...population.stateCodes()]).toEqual([0, 0]);

    sim.run();
    expect(exit.count).toBe(3);
    expect(exit.stats.timeInSystem.mean).toBe((2.5 + 3.5 + 4.5) / 3);
    expect(population.size).toBe(0);
    expect(seen.map((agent) => [agent.id, agent.population.name, agent.state, agent.removed])).toEqual([
      [1, 'door', 'active', true],
      [2, 'door', 'active', true],
      [3, 'door', 'active', true],
    ]);
    expect(sim.now).toBe(7.5);
  });

  it('is removed by the sink with its timeouts, unless the sink keeps the agents', () => {
    function run(removeAgents: boolean) {
      const sim = new Simulation();
      let overdue = 0;
      const visitor = defineStatechart({
        initial: 'inside',
        states: {
          inside: { after: { 10: 'overdue' } },
          overdue: {
            entry: () => {
              overdue++;
            },
          },
        },
      });
      const visitors = new AgentPopulation(sim, { name: 'visitors', statechart: visitor });
      const door = new Source(sim, { name: 'door', interval: 1, limit: 3, entity: () => visitors.add() });
      door
        .connect(new Delay(sim, { name: 'tour', duration: 2 }))
        .connect(new Sink(sim, { name: 'exit', removeAgents }));
      sim.run();
      return { sim, visitors, overdue: () => overdue };
    }

    // Removed at 3, 4 and 5: their timeouts at 11, 12 and 13 never fire, so the run ends at 5.
    const removed = run(true);
    expect(removed.visitors.size).toBe(0);
    expect(removed.overdue()).toBe(0);
    expect(removed.sim.now).toBe(5);

    // Kept: they go on living by their statechart after the sink.
    const kept = run(false);
    expect(kept.visitors.size).toBe(3);
    expect([...kept.visitors.ids()]).toEqual([1, 2, 3]);
    expect(kept.overdue()).toBe(3);
    expect(kept.sim.now).toBe(13);
  });
});
