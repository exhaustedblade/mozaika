/**
 * The few Node APIs the browser tests use, declared here so that they need
 * no @types/node (as packages/kernel/bench does). Playwright's own types
 * name Node's Buffer, which this gives the one method the tests call.
 * A script, not a module, so that its declarations are global.
 */

interface Buffer extends Uint8Array {
  toString(encoding: 'base64'): string;
}

declare const process: { readonly env: Readonly<Record<string, string | undefined>> };

declare module 'node:fs' {
  export function appendFileSync(path: string, data: string): void;
  export function mkdirSync(path: string, options: { recursive: true }): void;
  export function readFileSync(path: string): Uint8Array;
  export function writeFileSync(path: string, data: string): void;
}

declare module 'node:zlib' {
  export function gzipSync(data: Uint8Array, options?: { level?: number }): Uint8Array;
}
