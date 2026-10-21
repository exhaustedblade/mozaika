/**
 * The event machinery of a simulation: the clock, the records of pending
 * events, the queue that orders them and the kinds of events with their
 * handlers (docs/ARCHITECTURE.md, "Очередь событий на массивах"; П-28).
 *
 * It is shared by the modules of the kernel — the run loop, processes,
 * signals, agents — and is not part of the package's API: model code
 * schedules events through Simulation, and packages built on the kernel
 * register kinds of their own through extension.ts.
 */
import type { EventInfo, EventQueue } from './event-queue.js';
import { EventRecords } from './event-records.js';
import { FourAryHeap } from './four-ary-heap.js';
import { ModelEvents } from './model-events.js';
import type { Simulation } from './simulation.js';
import { WakeUps } from './wake-ups.js';

/**
 * What the kernel does with the events of one kind. An event carries two
 * numbers for its kind, `target` and `data`; what they mean is up to the kind,
 * e.g. the place of an agent in its population and the number of its timer.
 */
export interface EventKindHandler {
  /**
   * Fires an event. If it fails, throws a SimulationError that names what
   * failed: EVENT_FAILED, PROCESS_FAILED or AGENT_FAILED.
   */
  fire(target: number, data: number): void;
  /** Name of an event in traces and error messages; computed only when one is needed (П-29). */
  label(target: number, data: number): string | undefined;
  /** Lets go of what a cancelled event holds. Kinds that hold nothing, or cannot be cancelled, leave it out. */
  cancelled?(target: number, data: number): void;
}

/** Kind numbers are kept in a Uint16Array column of the records. */
const MAX_KINDS = 0x10000;

export class Scheduler {
  /** Current model time. Only the run loop moves it. */
  now: number;
  /** Events of schedule() and scheduleAt(). */
  readonly modelEvents: ModelEvents;
  /** Processes going on after a timeout or a signal, and listeners of signals. */
  readonly wakeUps: WakeUps;
  readonly #records = new EventRecords();
  readonly #queue: EventQueue = new FourAryHeap(this.#records);
  /** The handler of each kind of events, by kind number. */
  readonly #kinds: EventKindHandler[] = [];
  #nextSeq = 0;

  constructor(startTime: number) {
    this.now = startTime;
    this.modelEvents = new ModelEvents(this);
    this.wakeUps = new WakeUps(this);
  }

  /** Number of events waiting to fire. */
  get pendingEvents(): number {
    return this.#queue.size;
  }

  /** Time of the next event; Infinity if there is none. */
  nextEventTime(): number {
    return this.#queue.firstTime();
  }

  /** Adds a kind of events with its handler and returns its number, which events of the kind carry. */
  registerKind(handler: EventKindHandler): number {
    if (this.#kinds.length === MAX_KINDS) {
      throw new Error(`Scheduler: more than ${String(MAX_KINDS)} kinds of events`);
    }
    return this.#kinds.push(handler) - 1;
  }

  /**
   * Schedules an event of a kind at `time` and returns its slot. The caller
   * has checked the time (finite, not in the past) and the priority. Every
   * event gets the next number, which orders events of equal time and priority.
   */
  add(time: number, priority: number, kind: number, target: number, data: number): number {
    const slot = this.#records.allocate(priority, this.#nextSeq++, kind, target, data);
    this.#queue.add(slot, time);
    return slot;
  }

  /** Cancels a pending event: it leaves the queue at once, its kind lets go of it, its slot is freed. */
  cancel(slot: number): void {
    const records = this.#records;
    this.#queue.remove(slot);
    this.#kindOf(slot).cancelled?.(records.target(slot), records.data(slot));
    records.free(slot);
  }

  /** The generation of a slot: an event's handle compares it with the one it was made with. */
  generation(slot: number): number {
    return this.#records.generation(slot);
  }

  /** The number of the event in a slot. */
  seq(slot: number): number {
    return this.#records.seq(slot);
  }

  /** Points a pending event at another target, e.g. an agent that has moved in its population. */
  retarget(slot: number, target: number): void {
    this.#records.setTarget(slot, target);
  }

  /**
   * Fires the next event: takes it out of the queue, frees its slot, moves the
   * clock to it, shows it to the trace and lets its kind fire it. The slot is
   * free before the event fires, so the event's handle is no longer pending,
   * and an event scheduled while it fires can reuse the slot.
   */
  fireNext(trace: ((event: EventInfo) => void) | undefined): void {
    const records = this.#records;
    const time = this.#queue.firstTime();
    const slot = this.#queue.removeFirst();
    const kind = this.#kindOf(slot);
    const target = records.target(slot);
    const data = records.data(slot);
    const info: EventInfo | undefined =
      trace === undefined
        ? undefined
        : { time, priority: records.priority(slot), seq: records.seq(slot), label: kind.label(target, data) };
    records.free(slot);
    this.now = time;
    if (trace !== undefined && info !== undefined) trace(info);
    kind.fire(target, data);
  }

  #kindOf(slot: number): EventKindHandler {
    const kind = this.#kinds[this.#records.kind(slot)];
    if (kind === undefined) throw new Error(`Scheduler: slot ${String(slot)} has no kind of event`);
    return kind;
  }
}

/**
 * Reads the scheduler of a simulation; given by the static block of
 * Simulation, which sees its private fields. A function rather than a public
 * property, so that model code cannot reach the scheduler, and a private
 * field rather than a WeakMap, because processes and signals look it up each
 * time one is created — hundreds of thousands of times in a run of blocks.
 */
let readScheduler: ((simulation: Simulation) => Scheduler) | undefined;

/** Called once, by the static block of Simulation. */
export function provideSchedulers(read: (simulation: Simulation) => Scheduler): void {
  readScheduler = read;
}

/** The scheduler of a simulation, for the modules of the kernel. */
export function schedulerOf(simulation: Simulation): Scheduler {
  if (readScheduler === undefined) throw new Error('schedulerOf(): the Simulation class is not initialised');
  return readScheduler(simulation);
}
