/** The typed arrays the kernel keeps its columns in. */
export type Column = Float64Array | Uint32Array | Int32Array | Uint16Array | Uint8Array;

/**
 * Copies a full column into the start of a larger one and returns the larger
 * one; the columns grow by doubling, so this happens rarely.
 */
export function grown<T extends Column>(column: T, larger: T): T {
  larger.set(column);
  return larger;
}
