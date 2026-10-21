/**
 * Entry and exit actions of the blocks (docs/BLOCKS.md, section 8; П-40):
 * model code run when an entity enters or leaves a block, for example to
 * tell an agent that its turn has come.
 */
import type { Agent } from '@mozaika/kernel';
import { SimulationError } from '@mozaika/kernel';

import type { Block } from './block.js';

/** What an action receives: one object, like the actions of agents (docs/AGENTS.md, section 2). */
export interface BlockActionArgs {
  /** The entity that enters or leaves. */
  readonly agent: Agent;
  /** The block it enters or leaves. */
  readonly block: Block;
  /** Current model time. */
  readonly now: number;
}

/**
 * Runs inside the event of the block, when an entity enters (onEnter) or
 * leaves (onExit). It may change the agent's fields, send it messages (they
 * arrive as events after the current one) and schedule events of the model.
 */
export type BlockAction = (args: BlockActionArgs) => void;

/** An action option: a function, or nothing. `what` names the option in the message, e.g. 'Queue "hall" onEnter'. */
export function requireAction(action: unknown, what: string): BlockAction | undefined {
  if (action === undefined || typeof action === 'function') return action as BlockAction | undefined;
  throw new SimulationError('INVALID_ARGUMENT', `${what} must be a function of { agent, block, now }`);
}

/** Runs an action of `block` for `agent`, if the block has one. */
export function runAction(action: BlockAction | undefined, agent: Agent, block: Block): void {
  if (action !== undefined) action({ agent, block, now: block.simulation.now });
}
