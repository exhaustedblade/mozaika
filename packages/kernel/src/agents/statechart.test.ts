import { describe, expect, it } from 'vitest';

import { containing, simulationError } from '../test-helpers.js';
import type { StatechartConfig, StatechartImplementations } from './definition.js';
import { defineStatechart, rate } from './statechart.js';

/** Defines a statechart from data whose shape the type checker cannot vouch for, as an AI or a file might give it. */
function defineUnchecked(config: unknown, implementations?: unknown): unknown {
  return defineStatechart(config as StatechartConfig, implementations as StatechartImplementations);
}

describe('statechart definitions', () => {
  it('lists the states in the order of the definition; the index is the state code', () => {
    const chart = defineStatechart({
      id: 'phone',
      initial: 'idle',
      states: { idle: { on: { ring: 'ringing' } }, ringing: { after: { 3: 'idle' } }, broken: { type: 'final' } },
    });
    expect(chart.id).toBe('phone');
    expect(chart.stateNames).toEqual(['idle', 'ringing', 'broken']);
    expect(chart.initial.name).toBe('idle');
    expect(chart.states.map((state) => state.code)).toEqual([0, 1, 2]);
    expect(chart.states[2]?.final).toBe(true);
  });

  it('accepts the XState shape: string targets, transition objects, arrays tried in order, descriptions', () => {
    const chart = defineStatechart({
      initial: 'a',
      description: 'every form of transition',
      states: {
        a: {
          description: 'start',
          on: {
            go: [{ target: 'b', guard: () => false, description: 'never' }, 'c'],
            stay: { actions: [() => undefined, () => undefined] },
          },
          after: { 2.5: { target: 'b', reenter: true } },
          always: [{ guard: () => false, target: 'c' }],
        },
        b: { entry: () => undefined, exit: [() => undefined] },
        c: { type: 'final', entry: () => undefined },
      },
    });
    const a = chart.states[0];
    expect(a?.on.get('go')?.map((transition) => transition.target?.name)).toEqual(['b', 'c']);
    expect(a?.on.get('stay')?.[0]?.target).toBeUndefined();
    expect(a?.on.get('stay')?.[0]?.actions).toHaveLength(2);
    expect(a?.after[0]?.key).toBe('2.5');
    expect(a?.after[0]?.transitions[0]?.reenter).toBe(true);
  });

  it('takes named delays from the implementations', () => {
    const chart = defineStatechart(
      {
        initial: 'a',
        states: { a: { after: { fixed: 'b', drawn: 'b', exponential: 'b' } }, b: {} },
      },
      { delays: { fixed: 4, drawn: ({ random }) => random.uniform(1, 2), exponential: rate(0.5) } },
    );
    const timers = chart.states[0]?.after ?? [];
    expect(timers.map((timer) => timer.key)).toEqual(['fixed', 'drawn', 'exponential']);
    // Only delays that draw need a random stream of their own.
    expect(timers.map((timer) => timer.streamName)).toEqual([undefined, 'drawn', 'exponential']);
    expect(timers.map((timer) => timer.index)).toEqual([0, 1, 2]);
  });

  it.each([
    ['a definition that is not an object', 5, 'must be an object'],
    ['no initial state', { states: { a: {} } }, 'initial'],
    ['an initial state that does not exist', { initial: 'b', states: { a: {} } }, 'initial state "b"'],
    ['no states', { initial: 'a', states: {} }, 'at least one state'],
    ['an unknown key', { initial: 'a', states: { a: {} }, invoke: {} }, 'unknown key "invoke"'],
    ['a misspelt key of a state', { initial: 'a', states: { a: { afetr: { 1: 'a' } } } }, 'unknown key "afetr"'],
    ['nested states', { initial: 'a', states: { a: { initial: 'x', states: { x: {} } } } }, 'nested'],
    ['a parallel state', { initial: 'a', states: { a: { type: 'parallel' } } }, 'parallel'],
    ['a transition to an unknown state', { initial: 'a', states: { a: { on: { go: 'nowhere' } } } }, '"nowhere"'],
    ['a guard that is not a function', { initial: 'a', states: { a: { on: { go: { guard: true } } } } }, 'guard'],
    ['an action that is not a function', { initial: 'a', states: { a: { entry: ['log'] } } }, 'entry'],
    ['reenter without a target', { initial: 'a', states: { a: { on: { go: { reenter: true } } } } }, 'reenter'],
    ['an unknown delay', { initial: 'a', states: { a: { after: { patience: 'a' } } } }, 'unknown delay "patience"'],
    ['an eventless transition with neither guard nor target', { initial: 'a', states: { a: { always: {} } } }, 'loop'],
    ['an unguarded eventless transition to its own state', { initial: 'a', states: { a: { always: 'a' } } }, 'loop'],
    ['a final state with transitions', { initial: 'a', states: { a: { type: 'final', on: { go: 'a' } } } }, 'final'],
    ['fields that are not an object', { initial: 'a', context: 5, states: { a: {} } }, 'context'],
  ])('refuses %s', (_, config, message) => {
    const error = simulationError('INVALID_ARGUMENT', { message: containing(message) });
    expect(() => defineUnchecked(config)).toThrow(error);
  });

  it('names the place of the mistake', () => {
    expect(() => defineUnchecked({ id: 'customer', initial: 'a', states: { a: { on: { call: 'b' } } } })).toThrow(
      'Statechart "customer", state "a", on "call": target state "b" does not exist',
    );
  });

  it('refuses negative delays and bad implementations', () => {
    expect(() => defineUnchecked({ initial: 'a', states: { a: { after: { '-1': 'a' } } } })).toThrow(
      simulationError('NEGATIVE_DELAY'),
    );
    const config = { initial: 'a', states: { a: { after: { d: 'a' } } } };
    expect(() => defineUnchecked(config, { delays: { d: -1 } })).toThrow(simulationError('NEGATIVE_DELAY'));
    expect(() => defineUnchecked(config, { delays: { d: 'soon' } })).toThrow(simulationError('INVALID_ARGUMENT'));
    expect(() => defineUnchecked(config, { delays: { d: 1 }, guards: {} })).toThrow(
      simulationError('INVALID_ARGUMENT', { message: containing('unknown key "guards"') }),
    );
  });

  it('refuses a rate that is negative or not a finite number', () => {
    expect(() => rate(-1)).toThrow(simulationError('INVALID_ARGUMENT'));
    expect(() => rate(Number.NaN)).toThrow(simulationError('NOT_A_NUMBER'));
    expect(() => rate(Infinity)).toThrow(simulationError('NOT_FINITE'));
  });
});
