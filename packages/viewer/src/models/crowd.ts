/**
 * The model of the scene benchmark (Ф0-6б, П-18): a crowd of people that
 * walk between random points of a square without ever stopping. Time is in
 * seconds and length in metres; the square grows with the crowd, so its
 * density, and the look of the scene, stay the same at any size.
 */
import { type AgentAction, AgentPopulation, defineStatechart, type Point, type Random } from '@mozaika/kernel';
import type { ModelDefinition } from '@mozaika/kernel/worker';

/** The parameters: how many walk (read when the model is built) and how fast, in metres per second. */
// A type rather than an interface: only a type is a record of numbers (ModelParameters).
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type CrowdParameters = { agents: number; speed: number };

/** A crowd of 100 000 at a walking pace. */
export const CROWD_DEFAULTS: CrowdParameters = { agents: 100_000, speed: 1.4 };

/** People per square metre: a busy square, where everyone still walks freely. */
const DENSITY = 0.25;

/** The side of the square, in metres, for a crowd of `agents`. */
export function crowdSide(agents: number): number {
  return Math.sqrt(agents / DENSITY);
}

/**
 * A walker goes out to a random point and back to another, in turn: two
 * states, so that the scene colours them by state as it colours any model.
 * Each arrival starts the next walk; the first one is started when the model is built.
 */
function walkerChart(side: number, speed: () => number) {
  const walkOn: AgentAction = ({ agent, random }) => {
    agent.moveTo(randomPoint(random, side), { speed: speed() });
  };
  return defineStatechart({
    id: 'walker',
    initial: 'outbound',
    states: {
      outbound: { on: { 'agent.arrived': { target: 'inbound', actions: walkOn } } },
      inbound: { on: { 'agent.arrived': { target: 'outbound', actions: walkOn } } },
    },
  });
}

function randomPoint(random: Random, side: number): Point {
  return { x: random.uniform(0, side), y: random.uniform(0, side) };
}

export const crowd: ModelDefinition<CrowdParameters> = {
  parameters: CROWD_DEFAULTS,
  build({ simulation, parameters }) {
    const agents = Math.max(0, Math.floor(parameters.agents));
    const side = crowdSide(agents);
    const walkers = new AgentPopulation(simulation, {
      name: 'walkers',
      statechart: walkerChart(side, () => parameters.speed),
    });
    const start = simulation.random.stream('start');
    for (let i = 0; i < agents; i++) {
      const walker = walkers.add();
      walker.placeAt(randomPoint(start, side));
      walker.moveTo(randomPoint(start, side), { speed: parameters.speed });
    }
    return { populations: [walkers] };
  },
};
