/**
 * Snapshots of a population for a viewer (docs/ARCHITECTURE.md, "Снимок
 * популяции"; П-44): the columns of the population at one moment — ids,
 * creation times, segments of movement and state codes — in one ArrayBuffer,
 * which a Web Worker hands to the viewer without copying (a transferable
 * object of postMessage).
 *
 * Double buffering: a transferred buffer belongs to the viewer until it
 * gives it back, so the kernel writes the next snapshot into the other
 * buffer, and writes none while both are lent.
 *
 *     const snapshots = new PopulationSnapshots(visitors);
 *     const snapshot = snapshots.take();             // undefined while both buffers are lent
 *     if (snapshot) postMessage(snapshot, [snapshot.buffer]);
 *     // …when the viewer sends the snapshot back, with its buffer transferred:
 *     snapshots.giveBack(returned);
 */
import { describeValue, SimulationError } from '../errors.js';
import { SEGMENT_WIDTH } from './motion.js';
import { type AgentPopulation, type AnyPopulation, storeOf } from './population.js';
import type { AgentStore } from './store.js';

/** The columns of one population at one moment, as views of one buffer. */
export interface PopulationSnapshot {
  /** Name of the population. */
  readonly population: string;
  /** Model time of the snapshot: the state after every event up to it, when taken between runs. */
  readonly time: number;
  /** Number of agents: the length of each column, in rows. */
  readonly size: number;
  /** Which buffer of the population's snapshots this is; giveBack() needs it. */
  readonly slot: number;
  /** The memory of all the columns: the one object to transfer. */
  readonly buffer: ArrayBuffer;
  /** The id of each agent: a viewer recognises agents by it after the rows change. */
  readonly ids: Float64Array;
  /** The creation time of each agent. */
  readonly createdAt: Float64Array;
  /**
   * Six numbers per agent: from x, y, to x, y, the start and the arrival of
   * its segment, both counted from `time`. A standing agent's segment has
   * the same point at both ends. Float32, as graphics cards compute.
   */
  readonly segments: Float32Array;
  /** The state code of each agent in region 0 of the statechart: an index into statechart.stateNames. */
  readonly states: Uint16Array;
}

/** A snapshot coming back from the viewer: which buffer it is, and the buffer itself. */
export interface ReturnedSnapshot {
  readonly slot: number;
  readonly buffer: ArrayBuffer;
}

/** Two buffers: one with the viewer, one for the kernel to write into. */
const BUFFERS = 2;

/** Bytes per agent in a buffer: ids and creation times (8 each), a segment (6 × 4) and a state code (2). */
const BYTES_PER_AGENT = 8 + 8 + 4 * SEGMENT_WIDTH + 2;

/** Fewest agents a buffer has room for; buffers grow to powers of two, as the columns do. */
const MIN_CAPACITY = 1024;

/** One of the buffers: not allocated until the first snapshot needs it, then lent to the viewer or free. */
interface Slot {
  buffer: ArrayBuffer | undefined;
  lent: boolean;
  /**
   * Size of the buffer lent, to check the one given back: a transfer detaches
   * the lent buffer here, and a detached buffer has no bytes.
   */
  lentBytes: number;
}

/** Writes snapshots of one population into two buffers that it lends in turn; see the module comment. */
export class PopulationSnapshots {
  readonly name: string;
  readonly #population: AgentPopulation;
  readonly #store: AgentStore<object>;
  readonly #slots: Slot[] = Array.from({ length: BUFFERS }, () => ({
    buffer: undefined,
    lent: false,
    lentBytes: 0,
  }));

  /** A snapshot reads only the columns, never the fields, so it takes a population with any fields. */
  constructor(population: AnyPopulation) {
    this.#population = population as AgentPopulation;
    this.#store = storeOf(this.#population);
    this.name = this.#population.name;
  }

  /** Number of buffers lent and not yet given back. */
  get lent(): number {
    return this.#slots.filter((slot) => slot.lent).length;
  }

  /**
   * Writes the population as it is now into a free buffer and lends it.
   * Returns undefined, writing nothing, while every buffer is lent.
   */
  take(): PopulationSnapshot | undefined {
    const slot = this.#slots.findIndex((candidate) => !candidate.lent);
    const free = this.#slots[slot];
    if (free === undefined) return undefined;
    const size = this.#population.size;
    const buffer = fits(free.buffer, size) ? free.buffer : new ArrayBuffer(BYTES_PER_AGENT * capacityFor(size));
    const capacity = buffer.byteLength / BYTES_PER_AGENT;
    const ids = new Float64Array(buffer, 0, size);
    const createdAt = new Float64Array(buffer, 8 * capacity, size);
    const segments = new Float32Array(buffer, 16 * capacity, SEGMENT_WIDTH * size);
    const states = new Uint16Array(buffer, (16 + 4 * SEGMENT_WIDTH) * capacity, size);
    this.#store.writeSnapshot(ids, createdAt, segments, states);
    free.buffer = buffer;
    free.lent = true;
    free.lentBytes = buffer.byteLength;
    const time = this.#population.simulation.now;
    return { population: this.name, time, size, slot, buffer, ids, createdAt, segments, states };
  }

  /**
   * Takes back a lent buffer, so later snapshots can be written into it. A
   * buffer transferred back from a Web Worker is the same memory in a new
   * ArrayBuffer object, so it is known by its slot and must be as large as the one lent.
   */
  giveBack(snapshot: ReturnedSnapshot): void {
    const slot = this.#slots[snapshot.slot];
    if (slot === undefined) {
      throw new SimulationError(
        'INVALID_ARGUMENT',
        `PopulationSnapshots "${this.name}" has buffers 0 to ${String(BUFFERS - 1)}, ` +
          `got ${describeValue(snapshot.slot)}`,
      );
    }
    if (!slot.lent) {
      throw new SimulationError(
        'INVALID_ARGUMENT',
        `PopulationSnapshots "${this.name}": buffer ${String(snapshot.slot)} is not lent, so it cannot be given back`,
      );
    }
    const expected = slot.lentBytes;
    if (!(snapshot.buffer instanceof ArrayBuffer) || snapshot.buffer.byteLength !== expected) {
      const got = snapshot.buffer instanceof ArrayBuffer ? `${String(snapshot.buffer.byteLength)} bytes` : 'no buffer';
      throw new SimulationError(
        'INVALID_ARGUMENT',
        `PopulationSnapshots "${this.name}": buffer ${String(snapshot.slot)} was lent ` +
          `with ${String(expected)} bytes, got ${got}`,
      );
    }
    slot.buffer = snapshot.buffer;
    slot.lent = false;
  }
}

/** Whether a buffer has room for `size` agents. */
function fits(buffer: ArrayBuffer | undefined, size: number): buffer is ArrayBuffer {
  return buffer !== undefined && buffer.byteLength >= BYTES_PER_AGENT * size;
}

/** Room for `size` agents and more: the next power of two, so a growing population rarely needs a new buffer. */
function capacityFor(size: number): number {
  let capacity = MIN_CAPACITY;
  while (capacity < size) capacity *= 2;
  return capacity;
}
