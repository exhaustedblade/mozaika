import { describe, expect, it } from 'vitest';

import { mix64, Random, Xoshiro128StarStar } from './random.js';
import { simulationError } from './test-helpers.js';

const SAMPLES = 100_000;

function draw(count: number, sample: () => number): number[] {
  return Array.from({ length: count }, sample);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function minimum(values: readonly number[]): number {
  return values.reduce((least, value) => Math.min(least, value), Infinity);
}

function maximum(values: readonly number[]): number {
  return values.reduce((most, value) => Math.max(most, value), -Infinity);
}

function variance(values: readonly number[]): number {
  const center = mean(values);
  return values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1);
}

/** Pearson correlation of two equally long samples. */
function correlation(xs: readonly number[], ys: readonly number[]): number {
  const meanX = mean(xs);
  const meanY = mean(ys);
  let covariance = 0;
  let sumSquaresX = 0;
  let sumSquaresY = 0;
  xs.forEach((x, i) => {
    const dx = x - meanX;
    const dy = (ys[i] ?? Number.NaN) - meanY;
    covariance += dx * dy;
    sumSquaresX += dx * dx;
    sumSquaresY += dy * dy;
  });
  return covariance / Math.sqrt(sumSquaresX * sumSquaresY);
}

/** For independent samples the correlation is about N(0, 1/n): 0.02 is over six standard deviations. */
const MAX_CORRELATION = 0.02;

describe('random number generator: reference values', () => {
  // Reference values come from the C reference implementations (unsigned 64-bit and
  // 32-bit arithmetic). They pin the algorithm: changing them changes every model run.

  it('implements the SplitMix64 mixer', () => {
    // SplitMix64 seeded with 0 outputs mix64(k * gamma) for k = 1, 2, 3.
    const gamma = 0x9e3779b97f4a7c15n;
    expect([1n, 2n, 3n].map((k) => mix64(k * gamma))).toEqual([
      0xe220a8397b1dcdafn,
      0x6e789e6aa1b965f4n,
      0x06c45d188009454fn,
    ]);
  });

  it('implements xoshiro128**', () => {
    const generator = new Xoshiro128StarStar(1, 2, 3, 4);
    expect(draw(6, () => generator.nextUint32())).toEqual([
      11520, 0, 5927040, 70819200, 2031721883, 1637235492,
    ]);
  });

  it('derives the state from the seed and the stream path', () => {
    const firstFour = (random: Random): number[] => draw(4, () => random.nextUint32());
    expect(firstFour(new Random(0))).toEqual([443589289, 1472243107, 1913443415, 1536281227]);
    expect(firstFour(new Random(42))).toEqual([1552505907, 4113083374, 3991650357, 132206321]);
    expect(firstFour(new Random(-1))).toEqual([2381295930, 548049140, 484646835, 1918055202]);
    expect(firstFour(new Random(42, ['arrivals', 'batch']))).toEqual([
      3061167639, 1764329458, 3590491276, 913371557,
    ]);
  });

  it('builds uniform doubles from 53 random bits', () => {
    const random = new Random(42);
    expect(draw(3, () => random.uniform())).toEqual([
      0.36147095231452464, 0.9293785172014063, 0.52281269225457383,
    ]);
  });
});

describe('random number generator: repeatability and streams', () => {
  it('repeats the sequence for the same seed and differs for another seed', () => {
    const sequence = (seed: number): number[] => {
      const random = new Random(seed);
      return draw(100, () => random.uniform());
    };
    expect(sequence(2026)).toEqual(sequence(2026));
    expect(sequence(2026)).not.toEqual(sequence(2027));
  });

  it('identifies a stream by its seed and path', () => {
    const viaStreams = new Random(42).stream('arrivals').stream('batch');
    const viaPath = new Random(42, ['arrivals', 'batch']);
    expect(viaStreams.seed).toBe(42);
    expect(viaStreams.path).toEqual(['arrivals', 'batch']);
    expect(draw(10, () => viaStreams.uniform())).toEqual(draw(10, () => viaPath.uniform()));
  });

  it('returns the same stream object for the same name', () => {
    const random = new Random(1);
    expect(random.stream('arrivals')).toBe(random.stream('arrivals'));
    expect(random.stream('arrivals')).not.toBe(random.stream('service'));
  });

  it('does not let one stream affect another', () => {
    const random = new Random(5);
    const arrivals = random.stream('arrivals');
    const service = random.stream('service');

    draw(1_000, () => arrivals.uniform());
    draw(1_000, () => random.uniform());
    const late = random.stream('late');

    const firstTen = (stream: Random): number[] => draw(10, () => stream.uniform());
    expect(firstTen(service)).toEqual(firstTen(new Random(5, ['service'])));
    expect(firstTen(late)).toEqual(firstTen(new Random(5, ['late'])));
  });

  it('gives different names different sequences', () => {
    const random = new Random(9);
    const starts = new Set<string>();
    for (let i = 0; i < 1_000; i++) {
      const stream = random.stream(`source-${String(i)}`);
      starts.add(`${String(stream.nextUint32())}:${String(stream.nextUint32())}`);
    }
    // Path elements are sealed with their length, so ["ab", "c"] and ["a", "bc"] differ.
    const split = (path: string[]): number => new Random(9, path).nextUint32();
    expect(starts.size).toBe(1_000);
    expect(split(['ab', 'c'])).not.toBe(split(['a', 'bc']));
    expect(split(['a', ''])).not.toBe(split(['', 'a']));
  });

  it('produces uncorrelated streams', () => {
    const pairs: [Random, Random][] = [
      [new Random(1), new Random(2)],
      [new Random(1), new Random(1).stream('arrivals')],
      [new Random(1).stream('arrivals'), new Random(1).stream('service')],
      [new Random(1).stream('replication-1'), new Random(1).stream('replication-2')],
    ];
    for (const [a, b] of pairs) {
      const xs = draw(SAMPLES, () => a.uniform());
      const ys = draw(SAMPLES, () => b.uniform());
      expect(Math.abs(correlation(xs, ys))).toBeLessThan(MAX_CORRELATION);
    }
  });

  it('produces values uncorrelated with the previous one', () => {
    const random = new Random(3);
    const values = draw(SAMPLES + 1, () => random.uniform());
    expect(Math.abs(correlation(values.slice(1), values.slice(0, -1)))).toBeLessThan(MAX_CORRELATION);
  });
});

describe('random number generator: distributions', () => {
  it('draws uniformly on [0, 1) by default', () => {
    const random = new Random(11);
    const values = draw(SAMPLES, () => random.uniform());
    expect(minimum(values)).toBeGreaterThanOrEqual(0);
    expect(maximum(values)).toBeLessThan(1);
    // Tolerances are about six standard deviations of the sample mean and variance.
    expect(Math.abs(mean(values) - 0.5)).toBeLessThan(0.006);
    expect(Math.abs(variance(values) - 1 / 12)).toBeLessThan(0.0015);

    // Chi-square over 100 equal bins: 99 degrees of freedom, so about 99 ± 14.
    const bins = new Array<number>(100).fill(0);
    for (const value of values) {
      const bin = Math.floor(value * bins.length);
      bins[bin] = (bins[bin] ?? 0) + 1;
    }
    const expected = SAMPLES / bins.length;
    const chiSquare = bins.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
    expect(chiSquare).toBeLessThan(180);
  });

  it('draws uniformly on a given range', () => {
    const random = new Random(12);
    const values = draw(SAMPLES, () => random.uniform(-3, 5));
    expect(minimum(values)).toBeGreaterThanOrEqual(-3);
    expect(maximum(values)).toBeLessThan(5);
    expect(Math.abs(mean(values) - 1)).toBeLessThan(0.05);
    expect(random.uniform(2, 2)).toBe(2);
  });

  it('draws exponential values with the given mean', () => {
    const random = new Random(13);
    const values = draw(SAMPLES, () => random.exponential(2.5));
    expect(minimum(values)).toBeGreaterThanOrEqual(0);
    // Sample mean: standard deviation 2.5 / sqrt(n) ≈ 0.008; variance of Exp is mean².
    expect(Math.abs(mean(values) - 2.5)).toBeLessThan(0.04);
    expect(Math.abs(variance(values) / 6.25 - 1)).toBeLessThan(0.05);
  });

  it('rejects invalid parameters with clear errors', () => {
    const random = new Random(1);
    expect(() => random.uniform(2, 1)).toThrow(simulationError('INVALID_ARGUMENT'));
    expect(() => random.uniform(Number.NaN, 1)).toThrow(simulationError('NOT_A_NUMBER'));
    expect(() => random.uniform(0, Infinity)).toThrow(simulationError('NOT_FINITE'));
    expect(() => random.exponential(0)).toThrow(simulationError('INVALID_ARGUMENT'));
    expect(() => random.exponential(-1)).toThrow(simulationError('INVALID_ARGUMENT'));
    expect(() => random.exponential(Number.NaN)).toThrow(simulationError('NOT_A_NUMBER'));
  });

  it('accepts only safe integer seeds and string stream names', () => {
    expect(() => new Random(1.5)).toThrow(simulationError('INVALID_ARGUMENT'));
    expect(() => new Random(2 ** 60)).toThrow(simulationError('INVALID_ARGUMENT'));
    expect(() => new Random(Number.NaN)).toThrow(simulationError('NOT_A_NUMBER'));
    const notAString = 5 as unknown as string;
    expect(() => new Random(1).stream(notAString)).toThrow(simulationError('INVALID_ARGUMENT'));
  });
});
