import {
  Agent,
  type AgentAction,
  AgentPopulation,
  defineStatechart,
  type ProcessBody,
  Simulation,
} from '@mozaika/kernel';
import { describe, expect, it } from 'vitest';

import { type Entity, type EntityReceiver, Queue, ResourcePool, Service, Sink, Source } from './index.js';

/**
 * A step of the flow written in model code: it takes no time and holds no
 * entities, it only tells the agent passing through that it has been called.
 * Its places are those of the next block, so an entity leaves the block before
 * it exactly when the next block has room — here, when service can start.
 */
class CallStep implements EntityReceiver {
  readonly simulation: Simulation;
  readonly name = 'call';
  readonly #next: EntityReceiver;

  constructor(simulation: Simulation, next: EntityReceiver) {
    this.simulation = simulation;
    this.#next = next;
  }

  tryReserve(): boolean {
    return this.#next.tryReserve();
  }

  *reserve(): ProcessBody {
    yield* this.#next.reserve();
  }

  // eslint-disable-next-line require-yield -- the receiver protocol expects a generator, even one that never waits
  *enter(entity: Entity): ProcessBody<EntityReceiver> {
    if (!(entity instanceof Agent)) throw new Error(`entity ${String(entity.id)} is not an agent`);
    entity.send({ type: 'called' });
    return this.#next;
  }
}

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

    // Arrivals at 1, 2, 3, 4; one clerk serves each for 3. The Service holds
    // only the customer being served, so the others wait in the Queue.
    const clerk = new ResourcePool(sim, { name: 'clerk', capacity: 1 });
    const door = new Source(sim, { name: 'door', interval: 1, limit: 4, entity: () => customers.add() });
    const hall = door.connect(new Queue(sim, { name: 'hall' }));
    const desk = new Service(sim, { name: 'desk', pool: clerk, duration: 3, capacity: 1 });
    hall.connect(new CallStep(sim, desk));
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
    expect(customers.agents.every((agent) => agent.done)).toBe(true);
    expect(sim.pendingEvents).toBe(0);
  });
});
