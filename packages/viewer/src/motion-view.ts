/**
 * The 2D check of movement (Ф0-6а): draws the people of the walkway on a
 * canvas from the kernel's snapshots. Between snapshots the viewer leads the
 * agents along their segments itself (П-32), so frames do not wait for the
 * kernel: a frame at model time t puts each agent where its segment says.
 * The 3D scene of Ф0-6б will do the same on the graphics card.
 */
import type { PopulationSnapshot } from '@mozaika/kernel';

import { SEGMENT_WIDTH } from './scene/segment-shader.js';

/**
 * Writes the position of every agent of `snapshot` at model time `time` into
 * `into` (x and y of each in turn), by the formula of the segment
 * (docs/AGENTS.md, section 9): on the line before the arrival, at the target
 * from it on. `time` may be later than the snapshot: agents go on along their
 * segments, as they do in the model until an event changes them.
 */
export function positionsAt(snapshot: PopulationSnapshot, time: number, into: Float32Array): void {
  const segments = snapshot.segments;
  const since = time - snapshot.time;
  for (let row = 0; row < snapshot.size; row++) {
    const cell = row * SEGMENT_WIDTH;
    const fromX = segments[cell] ?? 0;
    const fromY = segments[cell + 1] ?? 0;
    const toX = segments[cell + 2] ?? 0;
    const toY = segments[cell + 3] ?? 0;
    const start = segments[cell + 4] ?? 0;
    const arrival = segments[cell + 5] ?? 0;
    if (since >= arrival) {
      into[2 * row] = toX;
      into[2 * row + 1] = toY;
    } else {
      const k = Math.max(0, (since - start) / (arrival - start));
      into[2 * row] = fromX + (toX - fromX) * k;
      into[2 * row + 1] = fromY + (toY - fromY) * k;
    }
  }
}

/** Colours of the states, by state code; the canvas cannot read CSS variables, so they are set here. */
export const STATE_COLOURS: readonly string[] = ['#2f6fb3', '#d08a1e', '#3c9a5f', '#8a5cc2'];

/** The hall the people walk in, in model units of length. */
export interface Scene {
  readonly width: number;
  readonly height: number;
  /** The doors in the left and the right wall: from and to y. */
  readonly door: { readonly from: number; readonly to: number };
}

/**
 * Draws frames: the walls of the hall with its doors, and each person as a
 * dot coloured by state. The positions of a frame go into an array kept
 * from frame to frame, which grows as the population does.
 */
export class MotionCanvas {
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D;
  readonly #scene: Scene;
  #positions = new Float32Array(0);

  constructor(canvas: HTMLCanvasElement, scene: Scene) {
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('This browser cannot draw on a 2D canvas');
    this.#canvas = canvas;
    this.#context = context;
    this.#scene = scene;
  }

  draw(snapshot: PopulationSnapshot | undefined, time: number): void {
    const canvas = this.#canvas;
    const context = this.#context;
    const ratio = window.devicePixelRatio;
    const width = Math.round(canvas.clientWidth * ratio);
    const height = Math.round(canvas.clientHeight * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const scale = width / this.#scene.width;
    context.clearRect(0, 0, width, height);
    this.#drawHall(scale);
    if (snapshot === undefined) return;
    if (this.#positions.length < 2 * snapshot.size) this.#positions = new Float32Array(4 * snapshot.size);
    const positions = this.#positions;
    positionsAt(snapshot, time, positions);
    const dot = Math.max(2, 0.6 * scale);
    for (let row = 0; row < snapshot.size; row++) {
      context.fillStyle = STATE_COLOURS[snapshot.states[row] ?? 0] ?? '#888888';
      const x = (positions[2 * row] ?? 0) * scale;
      // Model y grows upwards, canvas y downwards.
      const y = height - (positions[2 * row + 1] ?? 0) * scale;
      context.fillRect(x - dot / 2, y - dot / 2, dot, dot);
    }
  }

  #drawHall(scale: number): void {
    const context = this.#context;
    const { width, height, door } = this.#scene;
    context.strokeStyle = '#8a8a90';
    context.lineWidth = 2;
    // Canvas y grows downwards: the door from model y `from` to `to` is drawn from bottom − to to bottom − from.
    const right = width * scale;
    const bottom = height * scale;
    const doorTop = bottom - door.to * scale;
    const doorBottom = bottom - door.from * scale;
    context.beginPath();
    context.moveTo(0, doorTop);
    context.lineTo(0, 0);
    context.lineTo(right, 0);
    context.lineTo(right, doorTop);
    context.moveTo(right, doorBottom);
    context.lineTo(right, bottom);
    context.lineTo(0, bottom);
    context.lineTo(0, doorBottom);
    context.stroke();
  }
}
