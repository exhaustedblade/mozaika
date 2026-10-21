/**
 * A short fingerprint of a trace: FNV-1a (32 bits) over its lines. Lets a test
 * compare a whole trace with one recorded earlier, e.g. by an older kernel,
 * without keeping thousands of lines in the test.
 */
export function fingerprint(lines: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) hash = mix(hash, line.charCodeAt(i));
    // The line break too, so that ["ab", "c"] and ["a", "bc"] differ.
    hash = mix(hash, 0x0a);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function mix(hash: number, code: number): number {
  return Math.imul(hash ^ code, 0x01000193);
}
