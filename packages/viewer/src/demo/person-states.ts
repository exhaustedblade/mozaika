/**
 * How the demo shows a person by state (models/service-point.ts): the
 * legend, the colour in the scene, and where the figures count the person.
 * Everything goes by the names of the states, which the kernel's `build`
 * reply gives in the order of their codes, so a statechart with its states
 * in another order still shows right.
 */
import type { PopulationSnapshot } from '@mozaika/kernel';

import type { Messages } from '../i18n.js';
import type { PersonState } from '../models/service-point.js';

/** An entry of the legend: its text, its colour, and the states it stands for. */
export interface LegendEntry {
  readonly name: keyof Messages;
  readonly colour: number;
  readonly states: readonly PersonState[];
}

/** Slots 1, 4, 3, 6 and 7 of the validated palette; walking on to a window after service looks like walking to it. */
export const LEGEND: readonly LegendEntry[] = [
  { name: 'stateToLine', colour: 0x2a78d6, states: ['entering'] },
  { name: 'stateInLine', colour: 0xeda100, states: ['waiting'] },
  { name: 'stateToWindow', colour: 0x1baf7a, states: ['toWindow', 'finishing'] },
  { name: 'stateServed', colour: 0x008300, states: ['served'] },
  { name: 'stateOut', colour: 0x6250d6, states: ['leaving'] },
];

/** Colour of a state no entry of the legend names. */
const UNKNOWN = 0x8a8a90;

/** The colours of the states by state code, from the names of the states in the order of their codes. */
export function coloursByCode(stateNames: readonly string[]): number[] {
  return stateNames.map(
    (name) => LEGEND.find((entry) => (entry.states as readonly string[]).includes(name))?.colour ?? UNKNOWN,
  );
}

/** People in the line and at the windows (walking to one or served there), counted by state. */
export interface PeopleCount {
  readonly people: number;
  readonly inLine: number;
  readonly atWindows: number;
}

const IN_LINE: readonly string[] = ['entering', 'waiting'] satisfies PersonState[];
const AT_WINDOWS: readonly string[] = ['toWindow', 'served'] satisfies PersonState[];

/** Counts the people of a snapshot by where they are. */
export function countPeople(snapshot: PopulationSnapshot, stateNames: readonly string[]): PeopleCount {
  const inLineCode = stateNames.map((name) => IN_LINE.includes(name));
  const atWindowsCode = stateNames.map((name) => AT_WINDOWS.includes(name));
  let inLine = 0;
  let atWindows = 0;
  for (const code of snapshot.states) {
    if (inLineCode[code] === true) inLine++;
    else if (atWindowsCode[code] === true) atWindows++;
  }
  return { people: snapshot.size, inLine, atWindows };
}
