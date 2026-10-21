import { describe, expect, it } from 'vitest';

import { erlangC, mm1, mm1k, mmc } from './queueing-formulas.js';

/**
 * Erlang B by its textbook recursion, B(0) = 1, B(k) = a·B(k−1) / (k + a·B(k−1)),
 * and Erlang C from it: C = c·B / (c − a·(1 − B)). A route to C independent of
 * the sum in erlangC().
 */
function erlangCViaErlangB(servers: number, offeredLoad: number): number {
  let blocking = 1;
  for (let k = 1; k <= servers; k++) blocking = (offeredLoad * blocking) / (k + offeredLoad * blocking);
  return (servers * blocking) / (servers - offeredLoad * (1 - blocking));
}

describe('queueing formulas (the reference for the statistical tests)', () => {
  it('gives the M/M/1 measures', () => {
    const measures = mm1(0.5, 1);
    expect(measures.inSystem).toBeCloseTo(1, 12);
    expect(measures.waiting).toBeCloseTo(0.5, 12);
    expect(measures.timeInSystem).toBeCloseTo(2, 12);
    expect(measures.waitTime).toBeCloseTo(1, 12);
    expect(measures.utilization).toBeCloseTo(0.5, 12);
  });

  it('computes Erlang C like the Erlang B recursion', () => {
    expect(erlangC(2, 1)).toBeCloseTo(1 / 3, 12);
    for (const [servers, offeredLoad] of [[1, 0.9], [3, 1.5], [3, 2.7], [10, 8]] as const) {
      expect(erlangC(servers, offeredLoad)).toBeCloseTo(erlangCViaErlangB(servers, offeredLoad), 12);
    }
  });

  it('reduces M/M/c with one server to M/M/1', () => {
    const single = mm1(0.9, 1);
    const multi = mmc(0.9, 1, 1);
    for (const key of Object.keys(single) as (keyof typeof single)[]) {
      expect(multi[key]).toBeCloseTo(single[key], 12);
    }
  });

  it('keeps the M/M/c measures consistent with Little’s law', () => {
    const arrivalRate = 2.7;
    const measures = mmc(arrivalRate, 1, 3);
    expect(measures.inSystem).toBeCloseTo(arrivalRate * measures.timeInSystem, 12);
    expect(measures.waiting).toBeCloseTo(arrivalRate * measures.waitTime, 12);
  });

  it('gives the M/M/1/K loss probability and number in system', () => {
    // K = 1: the server is the only place, so P_1 = L = ρ / (1 + ρ).
    const rho = 0.9;
    expect(mm1k(rho, 1, 1).lossProbability).toBeCloseTo(rho / (1 + rho), 12);
    expect(mm1k(rho, 1, 1).inSystem).toBeCloseTo(rho / (1 + rho), 12);
    // A large K approaches the unlimited queue.
    expect(mm1k(rho, 1, 500).inSystem).toBeCloseTo(mm1(rho, 1).inSystem, 9);
    expect(mm1k(rho, 1, 500).lossProbability).toBeLessThan(1e-20);
  });

  it('refuses unstable queues', () => {
    expect(() => mm1(1, 1)).toThrow(RangeError);
    expect(() => mmc(3.1, 1, 3)).toThrow(RangeError);
  });
});
