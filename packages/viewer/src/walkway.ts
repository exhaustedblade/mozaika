/**
 * The model of the 2D check of movement (Ф0-6а): people come in through a
 * door on the left, walk to a free spot in a hall, wait there and walk out
 * through a door on the right. Source → Delay "hall" → Delay "exit" → Sink:
 * the blocks hold each person for its time, and their entry actions move the
 * person, who is an agent with a statechart of its own (П-31, П-32).
 */
import { Delay, Sink, Source } from '@mozaika/blocks';
import { AgentPopulation, defineStatechart, type Point } from '@mozaika/kernel';
import type { ModelDefinition } from '@mozaika/kernel/worker';

/** The hall, in metres: people enter through the door at x = 0 and leave through the one at x = width. */
export const HALL = { width: 100, height: 60, door: { from: 24, to: 36 } } as const;

/** The parameters of the walkway: arrivals per unit of model time and walking speed in metres per unit. */
// A type rather than an interface: only a type is a record of numbers (ModelParameters).
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type WalkwayParameters = { arrivalsPerUnit: number; speed: number };

/** How long a person stays in the hall, and how long the way out takes. */
const STAY = { shortest: 15, longest: 30 } as const;
const WAY_OUT = 6;

/**
 * A person walks in, waits once there and walks out. The states only show
 * where a person is in the flow; the blocks move people and hold them.
 */
const person = defineStatechart({
  id: 'person',
  initial: 'entering',
  states: {
    entering: { on: { 'agent.arrived': 'waiting', leave: 'leaving' } },
    waiting: { on: { leave: 'leaving' } },
    leaving: {},
  },
});

export const walkway: ModelDefinition<WalkwayParameters> = {
  parameters: { arrivalsPerUnit: 20, speed: 8 },
  build({ simulation, parameters }) {
    const people = new AgentPopulation(simulation, { name: 'people', statechart: person });
    const moves = simulation.random.stream('moves');
    const door = new Source(simulation, {
      name: 'door',
      interval: (random) => random.exponential(1 / parameters.arrivalsPerUnit),
      entity: () => people.add(),
    });
    const hall = new Delay(simulation, {
      name: 'hall',
      duration: (random) => random.uniform(STAY.shortest, STAY.longest),
      onEnter: ({ agent }) => {
        agent.placeAt({ x: 0, y: moves.uniform(HALL.door.from, HALL.door.to) });
        agent.moveTo(spotInHall(moves.uniform(), moves.uniform()), { speed: parameters.speed });
      },
    });
    const exit = new Delay(simulation, {
      name: 'exit',
      duration: WAY_OUT,
      onEnter: ({ agent }) => {
        agent.send({ type: 'leave' });
        agent.moveTo({ x: HALL.width, y: moves.uniform(HALL.door.from, HALL.door.to) }, { duration: WAY_OUT });
      },
    });
    door
      .connect(hall)
      .connect(exit)
      .connect(new Sink(simulation, { name: 'out' }));
    return { populations: [people] };
  },
};

/** A spot in the middle of the hall, away from the walls, from two numbers in [0, 1). */
function spotInHall(u: number, v: number): Point {
  return { x: 15 + u * (HALL.width - 30), y: 5 + v * (HALL.height - 10) };
}
