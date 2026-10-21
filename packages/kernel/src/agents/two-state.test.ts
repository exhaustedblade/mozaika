import { beforeAll, describe, it } from 'vitest';

import { Random } from '../random.js';
import { Simulation } from '../simulation.js';
import { expectFormulaInInterval, REPLICATIONS } from '../test-support/index.js';
import { AgentPopulation } from './population.js';
import { defineStatechart, rate } from './statechart.js';

/**
 * N independent agents, each a two-state Markov chain in continuous time:
 * A → B with rate a and B → A with rate b (S. M. Ross, "Introduction to
 * Probability Models", ch. 6). In the steady state
 *   - the fraction of agents in B is a / (a + b);
 *   - the time in A is exponential with mean 1/a, the time in B with mean 1/b.
 *
 * Method — replication/deletion, as for the blocks (П-16): 20 replications,
 * replication k with its own stream new Random(SEED, ['replication', k]);
 * the formula must lie in the 99.9 % t-interval of the 20 estimates, and the
 * interval must be narrow (see @mozaika/kernel/test-support). Three intervals,
 * so the Bonferroni bound on a false failure is 0.3 %.
 *
 * Warm-up: every agent starts in A, and P(B at t) approaches a / (a + b)
 * like exp(−(a + b) t). A warm-up of 13 / (a + b) leaves e⁻¹³ ≈ 2 · 10⁻⁶ of
 * the initial gap: negligible.
 *
 * Time in a state is measured on the sojourns that begin inside the window,
 * each followed to its end even after the window closes. A sojourn already
 * under way when the window opens is left out: it covers a fixed moment, so it
 * is length-biased — twice as long on average (the inspection paradox). With
 * about 150 sojourns in A per agent it would add about 0.5 % to the mean time
 * in A, as much as the half-width of the interval. What remains is a ratio of
 * sums whose expectations agree exactly (Wald's identity); its own bias is of
 * the order 1 / (number of sojourns), about 3 · 10⁻⁵.
 *
 * With these sizes the half-width is about 0.5 % of the value. Checked on 500
 * seeds: 1 of the 1 500 intervals missed (1.5 expected at 99.9 %), and no
 * half-width exceeded 0.8 %.
 */
const SEED = 20_261_021;
const AGENTS = 200;
const RATE_A_TO_B = 1;
const RATE_B_TO_A = 3;
const WARM_UP = 13 / (RATE_A_TO_B + RATE_B_TO_A);
const WINDOW = 200;

interface ReplicationEstimates {
  /** Time-average fraction of agents in B over the window. */
  readonly fractionInB: number;
  /** Mean length of the sojourns in A that began inside the window. */
  readonly meanTimeInA: number;
  /** Mean length of the sojourns in B that began inside the window. */
  readonly meanTimeInB: number;
}

/** Sum and count of observed sojourns in one state. */
class SojournTally {
  count = 0;
  #sum = 0;

  add(length: number): void {
    this.#sum += length;
    this.count++;
  }

  get mean(): number {
    return this.#sum / this.count;
  }
}

/** ∫ count dt for a count that changes in steps; restarted at the start of the window. */
class CountIntegral {
  readonly #simulation: Simulation;
  #count = 0;
  #since = 0;
  #area = 0;

  constructor(simulation: Simulation) {
    this.#simulation = simulation;
  }

  change(delta: number): void {
    this.#area += this.#count * (this.#simulation.now - this.#since);
    this.#since = this.#simulation.now;
    this.#count += delta;
  }

  restart(): void {
    this.#area = 0;
    this.#since = this.#simulation.now;
  }

  /** The integral from the restart up to now. */
  get area(): number {
    return this.#area + this.#count * (this.#simulation.now - this.#since);
  }
}

function runReplication(random: Random): ReplicationEstimates {
  const sim = new Simulation({ random });
  const windowEnd = WARM_UP + WINDOW;
  const inB = new CountIntegral(sim);
  const sojourns = { A: new SojournTally(), B: new SojournTally() };
  let unfinishedSojourns = 0;

  const flip = defineStatechart(
    {
      initial: 'A',
      context: { enteredAt: 0, observed: false },
      states: {
        A: {
          entry: ({ context, now }) => {
            context.enteredAt = now;
            context.observed = now >= WARM_UP && now < windowEnd;
            if (context.observed) unfinishedSojourns++;
          },
          exit: ({ context, now }) => {
            if (!context.observed) return;
            sojourns.A.add(now - context.enteredAt);
            unfinishedSojourns--;
          },
          after: { toB: 'B' },
        },
        B: {
          entry: ({ context, now }) => {
            inB.change(1);
            context.enteredAt = now;
            context.observed = now >= WARM_UP && now < windowEnd;
            if (context.observed) unfinishedSojourns++;
          },
          exit: ({ context, now }) => {
            inB.change(-1);
            if (!context.observed) return;
            sojourns.B.add(now - context.enteredAt);
            unfinishedSojourns--;
          },
          after: { toA: 'A' },
        },
      },
    },
    { delays: { toB: rate(RATE_A_TO_B), toA: rate(RATE_B_TO_A) } },
  );
  const agents = new AgentPopulation(sim, { name: 'flips', statechart: flip });
  for (let i = 0; i < AGENTS; i++) agents.add();

  sim.run(WARM_UP);
  inB.restart();
  sim.run(windowEnd);
  const fractionInB = inB.area / (AGENTS * WINDOW);
  // Follow the sojourns that began in the window to their ends.
  while (unfinishedSojourns > 0) sim.run(sim.now + 1);
  return { fractionInB, meanTimeInA: sojourns.A.mean, meanTimeInB: sojourns.B.mean };
}

const RATES = `A → B at rate ${String(RATE_A_TO_B)}, B → A at rate ${String(RATE_B_TO_A)}`;

describe(`${String(AGENTS)} two-state agents, ${RATES}`, () => {
  let replications: ReplicationEstimates[] = [];

  beforeAll(() => {
    replications = Array.from({ length: REPLICATIONS }, (_, k) =>
      runReplication(new Random(SEED, ['replication', String(k)])),
    );
  }, 60_000);

  it('spends the fraction a / (a + b) of the time in B', () => {
    const formula = RATE_A_TO_B / (RATE_A_TO_B + RATE_B_TO_A);
    expectFormulaInInterval('fraction in B', formula, replications.map((r) => r.fractionInB));
  });

  it('stays in A for 1/a and in B for 1/b on average', () => {
    expectFormulaInInterval('mean time in A', 1 / RATE_A_TO_B, replications.map((r) => r.meanTimeInA));
    expectFormulaInInterval('mean time in B', 1 / RATE_B_TO_A, replications.map((r) => r.meanTimeInB));
  });
});
