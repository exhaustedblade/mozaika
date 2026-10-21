/**
 * Seeded random numbers with independent named streams.
 *
 * Bit generator: xoshiro128** 1.1 (D. Blackman, S. Vigna, "Scrambled linear
 * pseudorandom number generators", 2018; reference code in the public domain).
 * 128-bit state, period 2^128 − 1, 32-bit outputs, only 32-bit integer
 * arithmetic, so it is fast in JavaScript.
 *
 * Streams: a stream is identified by a seed and a path of names, e.g.
 * (42, ["arrivals"]). Its state is a hash of that identity, computed with the
 * SplitMix64 mixer (G. Steele, D. Lea, C. Flood, "Fast splittable pseudorandom
 * number generators", 2014), as the xoshiro authors recommend for seeding.
 * So a stream does not depend on when it was created or on how many numbers
 * other streams have drawn: each part of a model can have its own stream, and
 * changing one part does not shift the random numbers of the others.
 */

import { requireFinite, requirePositive, SimulationError } from './errors.js';

/** 2^64 / φ rounded to an odd number: the constant SplitMix64 adds at each step. */
const GOLDEN_GAMMA = 0x9e3779b97f4a7c15n;

/** 2^-53: turns a 53-bit integer into a double in [0, 1). */
const DOUBLE_UNIT = 2 ** -53;

/** SplitMix64 output function (variant 13 of Stafford's mixer): a bijection on 64-bit integers. */
export function mix64(value: bigint): bigint {
  let z = BigInt.asUintN(64, value);
  z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
  z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
  return z ^ (z >> 31n);
}

/** Key of the root stream: the first SplitMix64 output for the seed. */
function seedKey(seed: number): bigint {
  return mix64(BigInt(seed) + GOLDEN_GAMMA);
}

/**
 * Key of the child stream `name`: every UTF-16 code unit of the name is mixed
 * into the parent key, then the length, so that ["ab", "c"] differs from ["a", "bc"].
 */
function childKey(parentKey: bigint, name: string): bigint {
  let key = parentKey;
  for (let i = 0; i < name.length; i++) {
    key = mix64((key ^ BigInt(name.charCodeAt(i))) + GOLDEN_GAMMA);
  }
  return mix64((key ^ BigInt(name.length)) + GOLDEN_GAMMA);
}

function rotateLeft(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}

/** The xoshiro128** bit generator. State words are kept as signed 32-bit integers. */
export class Xoshiro128StarStar {
  #s0: number;
  #s1: number;
  #s2: number;
  #s3: number;

  constructor(s0: number, s1: number, s2: number, s3: number) {
    this.#s0 = s0 | 0;
    this.#s1 = s1 | 0;
    this.#s2 = s2 | 0;
    this.#s3 = s3 | 0;
  }

  /**
   * Seeds the state with two SplitMix64 outputs after `key`. They cannot both
   * be zero (the mixer is a bijection and maps only 0 to 0), so the state is never all zeros.
   */
  static fromKey(key: bigint): Xoshiro128StarStar {
    const low = mix64(key + GOLDEN_GAMMA);
    const high = mix64(key + 2n * GOLDEN_GAMMA);
    const word = (value: bigint, shift: bigint): number => Number(BigInt.asUintN(32, value >> shift));
    return new Xoshiro128StarStar(word(low, 0n), word(low, 32n), word(high, 0n), word(high, 32n));
  }

  /** Next 32-bit output as an integer in [0, 2^32). */
  nextUint32(): number {
    const s1 = this.#s1;
    const result = Math.imul(rotateLeft(Math.imul(s1, 5), 7), 9) >>> 0;
    const shifted = s1 << 9;
    this.#s2 ^= this.#s0;
    this.#s3 ^= s1;
    this.#s1 ^= this.#s2;
    this.#s0 ^= this.#s3;
    this.#s2 ^= shifted;
    this.#s3 = rotateLeft(this.#s3, 11);
    return result;
  }
}

function requireSeed(seed: unknown): number {
  const value = requireFinite(seed, 'Random seed');
  if (!Number.isSafeInteger(value)) {
    throw new SimulationError(
      'INVALID_ARGUMENT',
      `Random seed must be an integer between -(2^53 - 1) and 2^53 - 1, got ${String(value)}`,
    );
  }
  return value;
}

function requireStreamName(name: unknown): string {
  if (typeof name !== 'string') {
    throw new SimulationError('INVALID_ARGUMENT', `Random stream name must be a string, got ${typeof name}`);
  }
  return name;
}

/**
 * A stream of random numbers. Two streams with the same seed and path produce
 * the same numbers; streams with different seeds or paths are independent.
 *
 * Repeatability is guaranteed within one JavaScript engine: `exponential()`
 * uses Math.log1p, whose last bit may differ between engines.
 */
export class Random {
  readonly seed: number;
  readonly path: readonly string[];
  readonly #generator: Xoshiro128StarStar;
  readonly #streams = new Map<string, Random>();

  /** Creates the stream with the given seed and, optionally, path of stream names. */
  constructor(seed: number, path: readonly string[] = []) {
    this.seed = requireSeed(seed);
    this.path = Object.freeze(path.map(requireStreamName));
    const key = this.path.reduce(childKey, seedKey(this.seed));
    this.#generator = Xoshiro128StarStar.fromKey(key);
  }

  /**
   * The child stream with the given name, e.g. one per source of randomness
   * ("arrivals", "service") or per replication of an experiment. The same name
   * always returns the same object, so two parts of a model never share a
   * sequence by accident.
   */
  stream(name: string): Random {
    let stream = this.#streams.get(name);
    if (stream === undefined) {
      stream = new Random(this.seed, [...this.path, requireStreamName(name)]);
      this.#streams.set(name, stream);
    }
    return stream;
  }

  /** Next raw 32-bit output: an integer in [0, 2^32). */
  nextUint32(): number {
    return this.#generator.nextUint32();
  }

  /**
   * Uniform number on [min, max); by default on [0, 1).
   *
   * Scaling the [0, 1) value to another range rounds, so for some ranges `max`
   * itself can come out, with a probability of about 2^-53.
   */
  uniform(min = 0, max = 1): number {
    requireFinite(min, 'uniform() min');
    requireFinite(max, 'uniform() max');
    if (max < min) {
      throw new SimulationError(
        'INVALID_ARGUMENT',
        `uniform() max must not be less than min, got min ${String(min)} and max ${String(max)}`,
      );
    }
    return min + (max - min) * this.#nextUnit();
  }

  /**
   * Exponentially distributed number with the given mean (in model-time units
   * when used as a delay; the rate is 1 / mean). Inverse transform: −mean · ln(1 − U).
   */
  exponential(mean: number): number {
    requirePositive(mean, 'exponential() mean');
    return -mean * Math.log1p(-this.#nextUnit());
  }

  /** Uniform double on [0, 1): a multiple of 2^-53 built from two outputs (53 random bits). */
  #nextUnit(): number {
    const high = this.#generator.nextUint32() >>> 5; // 27 bits
    const low = this.#generator.nextUint32() >>> 6; // 26 bits
    return (high * 2 ** 26 + low) * DOUBLE_UNIT;
  }
}
