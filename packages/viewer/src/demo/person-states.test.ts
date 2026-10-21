import { PopulationSnapshots, Simulation } from '@mozaika/kernel';
import { describe, expect, it } from 'vitest';

import { buildServicePoint, PERSON_STATES, SERVICE_POINT_DEFAULTS } from '../models/service-point.js';
import { coloursByCode, countPeople, LEGEND } from './person-states.js';

describe('people of the demo by state', () => {
  it('gives every state but the last a colour of the legend, whatever the order of the states', () => {
    const colours = coloursByCode(PERSON_STATES);
    expect(colours.slice(0, -1).every((colour) => LEGEND.some((entry) => entry.colour === colour))).toBe(true);
    // The order of the codes decides the colour of a code, not the order of the legend.
    expect(coloursByCode([...PERSON_STATES].reverse())).toEqual([...colours].reverse());
  });

  it('counts the people in the line and at the windows as the blocks do', () => {
    const model = buildServicePoint(new Simulation({ seed: 9 }), { ...SERVICE_POINT_DEFAULTS, arrivalsPerMinute: 2.4 });
    model.simulation.run(90);
    const snapshot = new PopulationSnapshots(model.people).take();
    if (snapshot === undefined) throw new Error('no snapshot');
    expect(countPeople(snapshot, model.people.statechart.stateNames)).toEqual({
      people: model.people.size,
      inLine: model.line.stats.length.current,
      atWindows: model.windows.busy,
    });
    expect(model.line.stats.length.current).toBeGreaterThan(5);
  });
});
