/**
 * Entities: whatever moves through the blocks is an agent of a population
 * (П-31, П-38; docs/BLOCKS.md, section 1). A simple entity — what a Source
 * makes without a factory — is an agent with one state and no fields.
 */
import { type Agent, defineStatechart } from '@mozaika/kernel';

/**
 * The fields of a simple entity: none. All simple entities share this one
 * frozen object rather than getting an empty object each, which would be a
 * third of the memory of such an agent (П-38).
 */
const NO_FIELDS: object = Object.freeze({});

/** The statechart of simple entities: one state, `active`, and no fields. */
export const SIMPLE_ENTITY = defineStatechart({
  id: 'entity',
  description: 'A simple entity of the process blocks: one state, no fields.',
  initial: 'active',
  context: () => NO_FIELDS,
  states: { active: {} },
});

/**
 * An agent of any population, as model code hands it to the blocks.
 * Agent<TContext> is invariant in its fields — its population's actions take
 * them — so an Agent<{ vip: boolean }> is not an Agent<object>. The blocks
 * never read the fields, so here they may be anything; inside the blocks an
 * entity is a plain Agent.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any fields, as explained above
export type AnyAgent = Agent<any>;

/** How traces and errors name an entity: "<population>#<id>", as the kernel names agents (П-29). */
export function describeEntity(agent: Agent | undefined): string {
  return agent === undefined ? 'an entity' : `${agent.population.name}#${String(agent.id)}`;
}
