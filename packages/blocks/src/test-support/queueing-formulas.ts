/**
 * Steady-state formulas of queueing theory, the reference the blocks are
 * tested against. Sources: L. Kleinrock, "Queueing Systems, Vol. 1", 1975;
 * D. Gross et al., "Fundamentals of Queueing Theory", 4th ed., 2008.
 *
 * Notation: λ — arrival rate, μ — service rate of one server, c — number of
 * servers, ρ = λ / (cμ) — utilization, a = λ / μ — offered load.
 * Not part of the package build.
 */

/** Long-run averages of a queueing system with unlimited capacity. */
export interface QueueMeasures {
  /** L: mean number of entities in the system (waiting or in service). */
  readonly inSystem: number;
  /** Lq: mean number of entities waiting for a server. */
  readonly waiting: number;
  /** W: mean time from arrival to departure. */
  readonly timeInSystem: number;
  /** Wq: mean time from arrival to the start of service. */
  readonly waitTime: number;
  /** ρ: fraction of time a server is busy. */
  readonly utilization: number;
}

/** Long-run averages of a system that turns away arrivals when full. */
export interface LossSystemMeasures {
  /** P_K: fraction of arrivals that find the system full and are lost. */
  readonly lossProbability: number;
  /** L: mean number of entities in the system. */
  readonly inSystem: number;
  /** Fraction of time the server is busy: λ(1 − P_K) / μ. */
  readonly utilization: number;
}

function requireStable(utilization: number): void {
  if (!(utilization > 0 && utilization < 1)) {
    throw new RangeError(`The queue is not stable: utilization ${String(utilization)} must be in (0, 1)`);
  }
}

/** M/M/1: Poisson arrivals, exponential service, one server. */
export function mm1(arrivalRate: number, serviceRate: number): QueueMeasures {
  const rho = arrivalRate / serviceRate;
  requireStable(rho);
  return {
    inSystem: rho / (1 - rho),
    waiting: (rho * rho) / (1 - rho),
    timeInSystem: 1 / (serviceRate - arrivalRate),
    waitTime: rho / (serviceRate - arrivalRate),
    utilization: rho,
  };
}

/**
 * Erlang C formula: the probability that an arrival to an M/M/c queue has to
 * wait, for `servers` servers and offered load a = λ / μ.
 */
export function erlangC(servers: number, offeredLoad: number): number {
  const rho = offeredLoad / servers;
  requireStable(rho);
  // a^k / k! is built up term by term, which avoids large factorials.
  let term = 1;
  let sumBelowServers = 0;
  for (let k = 0; k < servers; k++) {
    sumBelowServers += term;
    term *= offeredLoad / (k + 1);
  }
  const allBusy = term / (1 - rho); // (a^c / c!) · 1 / (1 − ρ)
  return allBusy / (sumBelowServers + allBusy);
}

/** M/M/c: Poisson arrivals, exponential service, c identical servers, one queue. */
export function mmc(arrivalRate: number, serviceRate: number, servers: number): QueueMeasures {
  const offeredLoad = arrivalRate / serviceRate;
  const rho = offeredLoad / servers;
  const waiting = (erlangC(servers, offeredLoad) * rho) / (1 - rho);
  const waitTime = waiting / arrivalRate;
  return {
    inSystem: waiting + offeredLoad,
    waiting,
    timeInSystem: waitTime + 1 / serviceRate,
    waitTime,
    utilization: rho,
  };
}

/** M/M/1/K: one server and room for at most `capacity` entities in the system. */
export function mm1k(arrivalRate: number, serviceRate: number, capacity: number): LossSystemMeasures {
  const rho = arrivalRate / serviceRate;
  if (rho === 1) throw new RangeError('M/M/1/K with ρ = 1 needs the limit formulas; use another rate');
  const rhoPowerK = rho ** capacity;
  const rhoPowerKPlus1 = rhoPowerK * rho;
  const lossProbability = ((1 - rho) * rhoPowerK) / (1 - rhoPowerKPlus1);
  return {
    lossProbability,
    inSystem: rho / (1 - rho) - ((capacity + 1) * rhoPowerKPlus1) / (1 - rhoPowerKPlus1),
    utilization: rho * (1 - lossProbability),
  };
}
