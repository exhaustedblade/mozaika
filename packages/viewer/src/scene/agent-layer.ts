/**
 * The agents of one population in the 3D scene (docs/ARCHITECTURE.md,
 * "Показ"): one mesh drawn once per agent by instancing, its attributes per
 * agent uploaded straight from the columns of a snapshot — the segment, the
 * state code and the id — and the position of each agent computed in the
 * vertex shader from its segment at the frame's time. Optionally, a soft
 * shadow on the floor under each agent, drawn from the same segments.
 */
import type { PopulationSnapshot } from '@mozaika/kernel';
import { Buffer, type VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { type IShaderMaterialOptions, ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import type { Observer } from '@babylonjs/core/Misc/observable.js';
import type { Scene } from '@babylonjs/core/scene.js';

import {
  AGENT_LOOK_GLSL,
  AGENT_POSITION_GLSL,
  LIGHT_DIRECTION,
  MAX_STATE_COLOURS,
  SHADE_GLSL,
  stateColourTable,
} from './agent-look.js';
import { floorDisc, type MeshData } from './person-geometry.js';
import { SEGMENT_WIDTH } from './segment-shader.js';

// Babylon's GLSL: it turns attribute and varying into the in and out of WebGL 2 itself.
const AGENT_VERTEX = /* glsl */ `
precision highp float;
precision highp int;
uniform mat4 viewProjection;
uniform float since;
uniform vec3 stateColours[${String(MAX_STATE_COLOURS)}];
attribute vec3 position;
attribute vec3 normal;
attribute vec4 fromTo;
attribute vec2 times;
attribute float state;
attribute float agentId;
varying vec3 vColour;
varying vec3 vNormal;
${AGENT_POSITION_GLSL}
${AGENT_LOOK_GLSL}
void main() {
  vec2 look = agentLook(agentId);
  vec3 world = agentOffset(fromTo, times, since) + position * vec3(1.0, look.x, 1.0);
  gl_Position = viewProjection * vec4(world, 1.0);
  vColour = stateColour(state) * look.y;
  vNormal = normal;
}
`;

const AGENT_FRAGMENT = /* glsl */ `
precision highp float;
uniform vec3 lightDirection;
varying vec3 vColour;
varying vec3 vNormal;
${SHADE_GLSL}
void main() {
  gl_FragColor = vec4(shade(vColour, vNormal), 1.0);
}
`;

const SHADOW_VERTEX = /* glsl */ `
precision highp float;
uniform mat4 viewProjection;
uniform float since;
attribute vec3 position;
attribute vec4 fromTo;
attribute vec2 times;
varying vec2 vLocal;
${AGENT_POSITION_GLSL}
void main() {
  gl_Position = viewProjection * vec4(agentOffset(fromTo, times, since) + position, 1.0);
  vLocal = position.xz;
}
`;

const SHADOW_FRAGMENT = /* glsl */ `
precision highp float;
uniform float shadowRadius;
varying vec2 vLocal;
void main() {
  float r = length(vLocal) / shadowRadius;
  gl_FragColor = vec4(0.0, 0.0, 0.0, 0.28 * (1.0 - r * r));
}
`;

/** The mesh, the colours and the shadows of a population's agents. */
export interface AgentLayerOptions {
  /** The mesh of one agent, standing at the origin. */
  readonly mesh: MeshData;
  /** Colours of the states by state code, 0xRRGGBB. */
  readonly stateColours: readonly number[];
  /** Draw a soft shadow on the floor under each agent: one more draw of the same agents. */
  readonly shadows?: boolean;
}

/**
 * The buffers on the graphics card with room for `capacity` agents. The layer
 * owns them; the meshes only hold views of them (VertexBuffer), which own nothing.
 */
interface AgentBuffers {
  readonly capacity: number;
  readonly segments: Buffer;
  readonly states: Buffer;
  readonly ids: Buffer;
  /** The ids of a snapshot as Float32, refilled for each upload rather than made anew. */
  readonly idsFloat32: Float32Array;
}

/**
 * The agents of one population: upload a snapshot, then draw frames at any
 * time after it (setSince); the shader leads each agent along its segment.
 */
export class AgentLayer {
  readonly #engine: AbstractEngine;
  readonly #agents: Mesh;
  readonly #shadows: Mesh | undefined;
  readonly #materials: ShaderMaterial[];
  readonly #contextRestored: Observer<AbstractEngine>;
  #buffers: AgentBuffers | undefined;
  #size = 0;

  constructor(scene: Scene, options: AgentLayerOptions) {
    this.#engine = scene.getEngine();
    this.#agents = meshOf('agents', options.mesh, scene);
    const agentMaterial = shaderMaterial('agents', scene, AGENT_VERTEX, AGENT_FRAGMENT, {
      attributes: ['position', 'normal', 'fromTo', 'times', 'state', 'agentId'],
      uniforms: ['viewProjection', 'since', 'stateColours', 'lightDirection'],
    });
    agentMaterial.setVector3('lightDirection', new Vector3(...LIGHT_DIRECTION));
    this.#agents.material = agentMaterial;
    this.#materials = [agentMaterial];
    if (options.shadows === true) {
      const disc = floorDisc();
      this.#shadows = meshOf('agent shadows', disc.mesh, scene);
      const shadowMaterial = shaderMaterial('agent shadows', scene, SHADOW_VERTEX, SHADOW_FRAGMENT, {
        attributes: ['position', 'fromTo', 'times'],
        uniforms: ['viewProjection', 'since', 'shadowRadius'],
        needAlphaBlending: true,
      });
      shadowMaterial.setFloat('shadowRadius', disc.radius);
      shadowMaterial.alphaMode = Constants.ALPHA_COMBINE;
      // Shadows of people close together add up, as they do under a crowd.
      shadowMaterial.disableDepthWrite = true;
      this.#shadows.material = shadowMaterial;
      this.#materials.push(shadowMaterial);
    }
    this.setStateColours(options.stateColours);
    this.#grow(1024);
    // A lost WebGL context comes back with empty buffers of the same size: draw nothing until the next snapshot.
    this.#contextRestored = this.#engine.onContextRestoredObservable.add(() => {
      this.clear();
    });
  }

  /** Number of agents drawn: the size of the snapshot uploaded last. */
  get size(): number {
    return this.#size;
  }

  /** Colours of the states by state code, 0xRRGGBB, as a model's legend has them. */
  setStateColours(colours: readonly number[]): void {
    this.#materials[0]?.setArray3('stateColours', stateColourTable(colours));
  }

  /** Model time of the frame minus that of the snapshot uploaded last: where the shader puts the agents. */
  setSince(since: number): void {
    for (const material of this.#materials) material.setFloat('since', since);
  }

  /**
   * Uploads the columns of a snapshot to the graphics card, straight from its
   * buffer. Once this returns, the snapshot may go back to the kernel: the
   * uploads name how many agents they write, so Babylon keeps no reference
   * to the snapshot's memory (it would rebuild a lost context from it).
   */
  upload(snapshot: PopulationSnapshot): void {
    const size = snapshot.size;
    if (this.#buffers === undefined || size > this.#buffers.capacity) this.#grow(capacityFor(size));
    const buffers = this.#buffers;
    if (buffers !== undefined && size > 0) {
      buffers.segments.updateDirectly(snapshot.segments, 0, size);
      buffers.states.updateDirectly(snapshot.states, 0, size);
      // Float64 ids become Float32 here: exact up to 2²⁴, enough for a look (agent-look.ts).
      const ids = buffers.idsFloat32.subarray(0, size);
      ids.set(snapshot.ids);
      buffers.ids.updateDirectly(ids, 0, size);
    }
    this.#show(size);
  }

  /** Draws no agents until the next upload, e.g. while a model is built anew. */
  clear(): void {
    this.#show(0);
  }

  dispose(): void {
    this.#engine.onContextRestoredObservable.remove(this.#contextRestored);
    this.#agents.dispose();
    this.#shadows?.dispose();
    for (const material of this.#materials) material.dispose();
    this.#disposeBuffers();
  }

  #show(size: number): void {
    this.#size = size;
    for (const mesh of this.#meshes()) {
      mesh.forcedInstanceCount = size;
      // No agents: draw nothing (forcedInstanceCount 0 would draw the mesh once).
      mesh.isVisible = size > 0;
    }
  }

  #meshes(): Mesh[] {
    return this.#shadows === undefined ? [this.#agents] : [this.#agents, this.#shadows];
  }

  /** New buffers with room for `capacity` agents; the old ones go. */
  #grow(capacity: number): void {
    this.#disposeBuffers();
    const engine = this.#engine;
    // Buffer(engine, data, updatable, stride, postponeInternalCreation, instanced, useBytes).
    const segments = new Buffer(engine, new Float32Array(SEGMENT_WIDTH * capacity), true, SEGMENT_WIDTH, false, true);
    const states = new Buffer(engine, new Uint16Array(capacity), true, Uint16Array.BYTES_PER_ELEMENT, false, true, true);
    const ids = new Buffer(engine, new Float32Array(capacity), true, 1, false, true);
    // The type of a view follows the data its buffer was made with: unsigned shorts for the states.
    const views: VertexBuffer[] = [
      segments.createVertexBuffer('fromTo', 0, 4),
      segments.createVertexBuffer('times', 4, 2),
      states.createVertexBuffer('state', 0, 1, Uint16Array.BYTES_PER_ELEMENT, true, true),
      ids.createVertexBuffer('agentId', 0, 1),
    ];
    for (const view of views) this.#agents.setVerticesBuffer(view);
    // The shadows need the segments only.
    for (const view of views.slice(0, 2)) this.#shadows?.setVerticesBuffer(view);
    this.#buffers = { capacity, segments, states, ids, idsFloat32: new Float32Array(capacity) };
  }

  #disposeBuffers(): void {
    const buffers = this.#buffers;
    if (buffers === undefined) return;
    buffers.segments.dispose();
    buffers.states.dispose();
    buffers.ids.dispose();
    this.#buffers = undefined;
  }
}

/** Room for `size` agents and more: the next power of two from 1 024, as snapshots grow. */
export function capacityFor(size: number): number {
  let capacity = 1024;
  while (capacity < size) capacity *= 2;
  return capacity;
}

/**
 * A material of our own GLSL. Our meshes are counter-clockwise seen from
 * outside (person-geometry.ts), as is usual in a right-handed scene; Babylon's
 * default is clockwise, which would cull the outside and show the inside.
 */
function shaderMaterial(
  name: string,
  scene: Scene,
  vertexSource: string,
  fragmentSource: string,
  options: Partial<IShaderMaterialOptions>,
): ShaderMaterial {
  const material = new ShaderMaterial(name, scene, { vertexSource, fragmentSource }, options);
  material.sideOrientation = Constants.MATERIAL_CounterClockWiseSideOrientation;
  return material;
}

/** A mesh of `data`, drawn wherever its agents are: no bounds to cull it by. */
function meshOf(name: string, data: MeshData, scene: Scene): Mesh {
  const mesh = new Mesh(name, scene);
  const vertices = new VertexData();
  vertices.positions = data.positions;
  vertices.normals = data.normals;
  vertices.indices = data.indices;
  vertices.applyToMesh(mesh);
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.isPickable = false;
  return mesh;
}
