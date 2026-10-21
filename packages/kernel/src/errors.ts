/**
 * Errors raised by the kernel. Every error carries a stable `code`, so callers
 * (blocks, the MCP layer, the viewer) can react to it or translate the message
 * without parsing text.
 */

export type SimulationErrorCode =
  /** An argument has the wrong type or is out of its allowed range. */
  | 'INVALID_ARGUMENT'
  /** NaN was given where a number is required. */
  | 'NOT_A_NUMBER'
  /** ±Infinity was given where a finite number is required. */
  | 'NOT_FINITE'
  /** A delay is negative. */
  | 'NEGATIVE_DELAY'
  /** An event was scheduled before the current model time. */
  | 'EVENT_IN_PAST'
  /** A process yielded something that is not a command. */
  | 'INVALID_YIELD'
  /** run() or step() was called from inside an event. */
  | 'REENTRANT_CALL'
  /** An event action threw; the original error is the `cause`. */
  | 'EVENT_FAILED'
  /** A process body threw; the original error is the `cause`. */
  | 'PROCESS_FAILED';

export class SimulationError extends Error {
  override readonly name = 'SimulationError';
  readonly code: SimulationErrorCode;

  constructor(code: SimulationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

/** Short human-readable description of any value, for error messages. */
export function describeValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'function') return 'a function';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object' && value !== null) {
    const className = (value as { constructor?: { name?: unknown } }).constructor?.name;
    return typeof className === 'string' && className !== 'Object' ? `a ${className}` : 'an object';
  }
  return String(value);
}

/** Message of an error of unknown type. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Checks that `value` is a finite number and returns it.
 * `what` names the value in the message, e.g. "timeout() delay".
 */
export function requireFinite(value: unknown, what: string): number {
  if (typeof value !== 'number') {
    throw new SimulationError('INVALID_ARGUMENT', `${what} must be a number, got ${describeValue(value)}`);
  }
  if (Number.isNaN(value)) {
    throw new SimulationError('NOT_A_NUMBER', `${what} must be a number, got NaN`);
  }
  if (!Number.isFinite(value)) {
    throw new SimulationError('NOT_FINITE', `${what} must be finite, got ${String(value)}`);
  }
  return value;
}

/** Checks that `value` is a finite, non-negative number and returns it. */
export function requireDelay(value: unknown, what: string): number {
  const delay = requireFinite(value, what);
  if (delay < 0) {
    throw new SimulationError('NEGATIVE_DELAY', `${what} must not be negative, got ${String(delay)}`);
  }
  return delay;
}

/** Checks that `value` is a finite number greater than zero and returns it. */
export function requirePositive(value: unknown, what: string): number {
  const number = requireFinite(value, what);
  if (number <= 0) {
    throw new SimulationError('INVALID_ARGUMENT', `${what} must be greater than zero, got ${String(number)}`);
  }
  return number;
}

/** Checks that `value` is a function and returns it. */
export function requireFunction<T>(value: T, what: string): T {
  if (typeof value !== 'function') {
    throw new SimulationError('INVALID_ARGUMENT', `${what} must be a function, got ${describeValue(value)}`);
  }
  return value;
}
