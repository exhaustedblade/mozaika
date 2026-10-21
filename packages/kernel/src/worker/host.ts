/**
 * The kernel's side of a Web Worker (docs/ARCHITECTURE.md, "Ядро в Web
 * Worker"): it builds a model, runs it, takes snapshots of its populations
 * and changes its parameters, one request at a time. It knows nothing of the
 * DOM or of workers: the worker's script passes it each message and posts
 * back what it answers, transferring the buffers listed with the reply.
 *
 *     const host = new KernelHost({ walkway });
 *     self.onmessage = (event) => {
 *       const { reply, transfer } = host.handle(event.data);
 *       self.postMessage(reply, [...transfer]);
 *     };
 */
import { describeValue, messageOf, requireFinite, SimulationError } from '../errors.js';
import { AgentPopulation } from '../agents/population.js';
import { type PopulationSnapshot, PopulationSnapshots } from '../agents/population-snapshots.js';
import { Simulation } from '../simulation.js';
import type { SnapshotRecorder } from '../snapshots.js';
import type {
  BuildRequest,
  KernelAnswer,
  KernelReply,
  KernelRequest,
  ModelDefinition,
  ReleaseRequest,
  RunRequest,
  SetRequest,
} from './protocol.js';

/** A model the host has built, with what it keeps for it. */
interface BuiltModel {
  readonly name: string;
  readonly simulation: Simulation;
  /** The values the model reads; `set` changes them in place. */
  readonly parameters: Record<string, number>;
  /** The snapshots of each population, in the order the model gave them. */
  readonly snapshots: readonly PopulationSnapshots[];
  /** The model's records for charts, if it keeps any. */
  readonly records: SnapshotRecorder | undefined;
}

export class KernelHost {
  readonly #models: ReadonlyMap<string, ModelDefinition>;
  #built: BuiltModel | undefined;

  /** `models`: the models this worker can build, by name. */
  constructor(models: Readonly<Record<string, ModelDefinition>>) {
    this.#models = new Map(Object.entries(models));
  }

  /**
   * Does what a request asks and answers it. A request that fails gets an
   * `error` reply rather than an exception, and the host goes on serving.
   */
  handle(request: KernelRequest): KernelAnswer {
    try {
      return this.#answer(request);
    } catch (error) {
      const code = error instanceof SimulationError ? error.code : undefined;
      return { reply: { type: 'error', id: request.id, code, message: messageOf(error) }, transfer: [] };
    }
  }

  #answer(request: KernelRequest): KernelAnswer {
    switch (request.type) {
      case 'build':
        return withoutTransfer(this.#build(request));
      case 'run':
        return withoutTransfer(this.#run(request));
      case 'snapshot': {
        const model = this.#model();
        const populations = takeSnapshots(model.snapshots);
        const reply: KernelReply = { type: 'snapshot', id: request.id, time: model.simulation.now, populations };
        return { reply, transfer: populations.map((snapshot) => snapshot.buffer) };
      }
      case 'set':
        return withoutTransfer(this.#set(request));
      case 'release':
        this.#release(request);
        return withoutTransfer({ type: 'released', id: request.id });
      default:
        throw new SimulationError(
          'INVALID_ARGUMENT',
          `Unknown request ${describeValue((request as { type?: unknown }).type)}; ` +
            'requests: build, run, snapshot, set, release',
        );
    }
  }

  /** Builds the model in a new simulation; the model built before is dropped only once this one is built. */
  #build(request: BuildRequest): KernelReply {
    const definition = this.#models.get(request.model);
    if (definition === undefined) {
      throw new SimulationError(
        'INVALID_ARGUMENT',
        `No model named ${describeValue(request.model)}; this worker has: ${[...this.#models.keys()].join(', ')}`,
      );
    }
    const parameters: Record<string, number> = { ...definition.parameters };
    for (const [name, value] of Object.entries(request.parameters ?? {})) {
      parameters[requireParameterName(parameters, name, request.model)] = requireFinite(value, `Parameter "${name}"`);
    }
    const simulation = new Simulation({ seed: request.seed ?? 0 });
    const { populations, records } = definition.build({ simulation, parameters });
    for (const population of populations) {
      if (!(population instanceof AgentPopulation) || population.simulation !== simulation) {
        throw new SimulationError(
          'INVALID_ARGUMENT',
          `Model "${request.model}" must give populations of the simulation it was built in`,
        );
      }
    }
    const snapshots = populations.map((population) => new PopulationSnapshots(population));
    this.#built = { name: request.model, simulation, parameters, snapshots, records };
    return {
      type: 'built',
      id: request.id,
      time: simulation.now,
      parameters: { ...parameters },
      populations: populations.map(({ name, statechart }) => ({ name, stateNames: statechart.stateNames })),
    };
  }

  /** Runs the model to the moment asked for; the reply brings the records taken on the way. */
  #run(request: RunRequest): KernelReply {
    const model = this.#model();
    const { time, events, reason } = model.simulation.run(request.until);
    const ran = { type: 'ran', id: request.id, time, events, reason } as const;
    return model.records === undefined ? ran : { ...ran, records: model.records.take() };
  }

  #set(request: SetRequest): KernelReply {
    const model = this.#model();
    const name = requireParameterName(model.parameters, request.parameter, model.name);
    model.parameters[name] = requireFinite(request.value, `Parameter "${name}"`);
    return { type: 'set', id: request.id, parameter: name, value: request.value };
  }

  /** Takes back the buffers of the snapshots, each into the snapshots of its population. */
  #release(request: ReleaseRequest): void {
    const model = this.#model();
    for (const returned of request.snapshots) {
      const snapshots = model.snapshots.find((candidate) => candidate.name === returned.population);
      if (snapshots === undefined) {
        throw new SimulationError(
          'INVALID_ARGUMENT',
          `Model "${model.name}" has no population ${describeValue(returned.population)} to give a snapshot back to`,
        );
      }
      snapshots.giveBack(returned);
    }
  }

  #model(): BuiltModel {
    if (this.#built === undefined) {
      throw new SimulationError('INVALID_STATE', 'No model is built yet: send build first');
    }
    return this.#built;
  }
}

function withoutTransfer(reply: KernelReply): KernelAnswer {
  return { reply, transfer: [] };
}

/**
 * A snapshot of every population, or none: if the buffers of one are all
 * lent, the snapshots already taken are given back and the request fails.
 */
function takeSnapshots(all: readonly PopulationSnapshots[]): PopulationSnapshot[] {
  const taken: PopulationSnapshot[] = [];
  for (const snapshots of all) {
    const snapshot = snapshots.take();
    if (snapshot === undefined) {
      taken.forEach((done, index) => all[index]?.giveBack(done));
      throw new SimulationError(
        'INVALID_STATE',
        `Both snapshot buffers of "${snapshots.name}" are lent: release a snapshot before asking for another`,
      );
    }
    taken.push(snapshot);
  }
  return taken;
}

function requireParameterName(parameters: Readonly<Record<string, number>>, name: string, model: string): string {
  if (!Object.hasOwn(parameters, name)) {
    const known = Object.keys(parameters);
    const list = known.length > 0 ? known.join(', ') : 'none';
    throw new SimulationError(
      'INVALID_ARGUMENT',
      `Model "${model}" has no parameter ${describeValue(name)}; its parameters: ${list}`,
    );
  }
  return name;
}
