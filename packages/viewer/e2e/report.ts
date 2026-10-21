/**
 * What the browser tests measured, for people: JSON files and screenshots in
 * e2e/results (an artifact of the CI job), and Markdown tables in the job
 * summary when CI gives one (GITHUB_STEP_SUMMARY).
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import type { Page } from '@playwright/test';

// File paths, not URL paths: those would keep %-escapes of spaces and Cyrillic, and a leading / before C: on Windows.
export const RESULTS = fileURLToPath(new URL('./results/', import.meta.url));
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

/** Saves `data` as results/<name>.json. */
export function saveResult(name: string, data: unknown): void {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(`${RESULTS}${name}.json`, `${JSON.stringify(data, null, 2)}\n`);
}

/** Adds Markdown to the summary of the CI job, if there is one. */
export function summarise(markdown: string): void {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined && summary !== '') appendFileSync(summary, `${markdown}\n`);
}

/** The scripts a page loads, as it loads them: paths in the built preview. */
export function loadedScripts(page: Page): Set<string> {
  const scripts = new Set<string>();
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (path.endsWith('.js')) scripts.add(path.slice(path.lastIndexOf('/assets/') + 1));
  });
  return scripts;
}

export interface ScriptSize {
  readonly files: number;
  /** Bytes as built, and gzip-compressed, as a server would send them. */
  readonly bytes: number;
  readonly gzipBytes: number;
}

/** Sizes of the built scripts at `paths` (relative to dist). */
export function scriptSize(paths: Iterable<string>): ScriptSize {
  let files = 0;
  let bytes = 0;
  let gzipBytes = 0;
  for (const path of paths) {
    const data = readFileSync(`${DIST}${path}`);
    files++;
    bytes += data.length;
    gzipBytes += gzipSync(data, { level: 9 }).length;
  }
  return { files, bytes, gzipBytes };
}

export function kilobytes(bytes: number): string {
  return (bytes / 1024).toFixed(0);
}
