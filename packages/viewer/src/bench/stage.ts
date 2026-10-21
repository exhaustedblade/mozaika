/**
 * What the benchmark page needs of a 3D engine (temporary, for the choice of
 * Ф0-6б): the same scene on each — a floor, an orbiting camera and the agents
 * of a snapshot drawn by instancing, led along their segments in the shader.
 */
import type { PopulationSnapshot } from '@mozaika/kernel';

import type { MeshData } from '../scene/person-geometry.js';

export interface BenchStage {
  /** Copies a snapshot to the graphics card; the snapshot may go back to the kernel once this returns. */
  upload(snapshot: PopulationSnapshot): void;
  /** Draws a frame `since` units of model time after the snapshot uploaded last. */
  render(since: number): void;
  /** Renderer, as the graphics card names it, for the report. */
  readonly renderer: string;
}

export interface BenchStageOptions {
  /** The side of the square the agents walk in, in metres. */
  readonly side: number;
  /** Colours of the states, 0xRRGGBB. */
  readonly stateColours: readonly number[];
  /** The mesh of an agent: a person, or one triangle of no area (to measure the engines without a GPU). */
  readonly mesh: MeshData;
}

export type CreateBenchStage = (canvas: HTMLCanvasElement, options: BenchStageOptions) => BenchStage;

/** Room for `size` agents and more: the next power of two from 1 024, as snapshots grow. */
export function capacityFor(size: number): number {
  let capacity = 1024;
  while (capacity < size) capacity *= 2;
  return capacity;
}

/** The renderer the browser reports, if it tells. */
export function rendererName(gl: WebGL2RenderingContext): string {
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  return String(gl.getParameter(info === null ? gl.RENDERER : info.UNMASKED_RENDERER_WEBGL));
}

/** One triangle of no area: the vertex stage runs three times per agent, the raster stage not at all. */
export function degenerateMesh(): MeshData {
  return { positions: new Float32Array(9), normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), indices: Uint16Array.from([0, 1, 2]) };
}
