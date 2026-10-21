/**
 * Checks of block options. Errors are SimulationErrors with the same codes the
 * kernel uses, so callers handle both packages alike.
 */
import { SimulationError } from '@mozaika/kernel';

/** Short human-readable description of a value, for error messages. */
function describeValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'function') return 'a function';
  if (typeof value === 'object' && value !== null) return 'an object';
  return String(value);
}

/** A finite number; `what` names the value in the message, e.g. 'Service "desk" duration'. */
export function requireFinite(value: unknown, what: string): number {
  if (typeof value !== 'number') {
    throw new SimulationError('INVALID_ARGUMENT', `${what} must be a number, got ${describeValue(value)}`);
  }
  if (Number.isNaN(value)) throw new SimulationError('NOT_A_NUMBER', `${what} must be a number, got NaN`);
  if (!Number.isFinite(value)) throw new SimulationError('NOT_FINITE', `${what} must be finite, got ${String(value)}`);
  return value;
}

/** A finite number of model time that is not negative. */
export function requireDuration(value: unknown, what: string): number {
  const duration = requireFinite(value, what);
  if (duration < 0) {
    throw new SimulationError('NEGATIVE_DELAY', `${what} must not be negative, got ${String(duration)}`);
  }
  return duration;
}

/** A whole number not less than `minimum`. */
export function requireWholeNumber(value: unknown, what: string, minimum: number): number {
  const number = requireFinite(value, what);
  if (!Number.isInteger(number) || number < minimum) {
    throw new SimulationError(
      'INVALID_ARGUMENT',
      `${what} must be a whole number of at least ${String(minimum)}, got ${String(number)}`,
    );
  }
  return number;
}

/** A whole number not less than `minimum`, or Infinity for "no limit". */
export function requireLimit(value: unknown, what: string, minimum: number): number {
  return value === Infinity ? Infinity : requireWholeNumber(value, what, minimum);
}

/** A yes-or-no option; `fallback` when it is not given. */
export function requireBoolean(value: unknown, what: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  throw new SimulationError('INVALID_ARGUMENT', `${what} must be true or false, got ${describeValue(value)}`);
}

/** The name of a block: a non-empty string. `kind` is the block type, e.g. "Queue". */
export function requireName(value: unknown, kind: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new SimulationError('INVALID_ARGUMENT', `${kind} name must be a non-empty string, got ${describeValue(value)}`);
  }
  return value;
}
