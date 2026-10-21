/**
 * The agents of one population in the 3D scene (docs/ARCHITECTURE.md,
 * "Показ"): one mesh drawn once per agent by instancing, its attributes per
 * agent uploaded straight from the columns of a snapshot — the segment, the
 * state code and the id — and the position of each agent computed in the
 * vertex shader from its segment at the frame's time. Optionally, a soft
 * shadow on the floor under each agent, drawn from the same buffers.
 */
import type { PopulationSnapshot } from '@mozaika/kernel';
import { Buffer, VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import { type IShaderMaterialOptions, ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import type { Scene } from '@babylonjs/core/scene.js';

import { AGENT_GLSL, LIGHT_DIRECTION, MAX_STATE_COLOURS, SHADE_GLSL, stateColourTable } from './agent-look.js';
import { floorDisc, type MeshData } from './person-geometry.js';

/** Numbers per agent in the segments of a snapshot. */
const SEGMENT = 6;

/** The attributes per agent, as the shaders name them. */
const AGENT_ATTRIBUTES = ['fromTo', 'times', 'state', 'agentId'];

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
${AGENT_GLSL}
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
precision highp int;
uniform mat4 viewProjection;
uniform float since;
uniform vec3 stateColours[${String(MAX_STATE_COLOURS)}];
attribute vec3 position;
attribute vec4 fromTo;
attribute vec2 times;
varying vec2 vLocal;
${AGENT_GLSL}
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

export interface AgentLayerOptions {
  /** The mesh of one agent, standing at the origin. */
  readonly mesh: MeshData;
  /** Colours of the states by state code, 0xRRGGBB. */
  readonly stateColours: readonly number[];
  /** Draw a soft shadow on the floor under each agent: one more draw of the same agents. */
  readonly shadows?: boolean;
}

export class AgentLayer {
  readonly #engine: AbstractEngine;
  readonly #meshes: Mesh[];
  readonly #materials: ShaderMaterial[];
  #segments: Buffer | undefined;
  #states: VertexBuffer | undefined;
  #ids: VertexBuffer | undefined;
  /** The ids of a snapshot as Float32, for the graphics card; kept to be refilled, not made anew. */
  #idsFloat32 = new Float32Array(0);
  #capacity = 0;
  #size = 0;

  constructor(scene: Scene, options: AgentLayerOptions) {
    this.#engine = scene.getEngine();
    const agents = meshOf('agents', options.mesh, scene);
    const agentMaterial = shaderMaterial('agents', scene, AGENT_VERTEX, AGENT_FRAGMENT, {
      attributes: ['position', 'normal', ...AGENT_ATTRIBUTES],
      uniforms: ['viewProjection', 'since', 'stateColours', 'lightDirection'],
    });
    agentMaterial.setVector3('lightDirection', new Vector3(...LIGHT_DIRECTION));
    agents.material = agentMaterial;
    this.#meshes = [agents];
    this.#materials = [agentMaterial];
    if (options.shadows === true) {
      const disc = floorDisc();
      const shadows = meshOf('agent shadows', disc.mesh, scene);
      const shadowMaterial = shaderMaterial('agent shadows', scene, SHADOW_VERTEX, SHADOW_FRAGMENT, {
        attributes: ['position', 'fromTo', 'times'],
        uniforms: ['viewProjection', 'since', 'stateColours', 'shadowRadius'],
        needAlphaBlending: true,
      });
      shadowMaterial.setFloat('shadowRadius', disc.radius);
      shadowMaterial.alphaMode = Constants.ALPHA_COMBINE;
      // Shadows of people close together add up, as they do under a crowd.
      shadowMaterial.disableDepthWrite = true;
      shadows.material = shadowMaterial;
      this.#meshes.push(shadows);
      this.#materials.push(shadowMaterial);
    }
    this.stateColours = options.stateColours;
    this.#grow(1024);
  }

  /** Number of agents drawn: the size of the snapshot uploaded last. */
  get size(): number {
    return this.#size;
  }

  /** Colours of the states by state code, 0xRRGGBB; a model's own legend sets them. */
  set stateColours(colours: readonly number[]) {
    const table = stateColourTable(colours);
    for (const material of this.#materials) material.setArray3('stateColours', table);
  }

  /** Model time of the frame minus that of the snapshot uploaded last: where the shader puts the agents. */
  set since(value: number) {
    for (const material of this.#materials) material.setFloat('since', value);
  }

  /**
   * Uploads the columns of a snapshot to the graphics card, straight from its
   * buffer. Once this returns, the snapshot may go back to the kernel.
   */
  upload(snapshot: PopulationSnapshot): void {
    const size = snapshot.size;
    if (size > this.#capacity) this.#grow(capacityFor(size));
    if (size > 0) {
      this.#segments?.updateDirectly(snapshot.segments, 0, size);
      this.#states?.updateDirectly(snapshot.states, 0);
      // Float64 ids become Float32 here: exact up to 2²⁴, enough for a look (agent-look.ts).
      const ids = this.#idsFloat32.subarray(0, size);
      ids.set(snapshot.ids);
      this.#ids?.updateDirectly(ids, 0);
    }
    this.#size = size;
    for (const mesh of this.#meshes) mesh.forcedInstanceCount = size;
    // No agents: nothing to draw (forcedInstanceCount 0 would draw the mesh once).
    for (const mesh of this.#meshes) mesh.isVisible = size > 0;
  }

  /** Draws no agents until the next upload, e.g. while a model is built anew. */
  clear(): void {
    this.#size = 0;
    for (const mesh of this.#meshes) mesh.isVisible = false;
  }

  dispose(): void {
    for (const mesh of this.#meshes) mesh.dispose();
    for (const material of this.#materials) material.dispose();
    this.#disposeBuffers();
  }

  /** New buffers on the graphics card, with room for `capacity` agents, shared by the meshes. */
  #grow(capacity: number): void {
    this.#disposeBuffers();
    const engine = this.#engine;
    const segments = new Buffer(engine, new Float32Array(SEGMENT * capacity), true, SEGMENT, false, true);
    const states = new VertexBuffer(engine, new Uint16Array(capacity), 'state', {
      updatable: true,
      instanced: true,
      size: 1,
      stride: 1,
      type: VertexBuffer.UNSIGNED_SHORT,
      normalized: false,
    });
    const ids = new VertexBuffer(engine, new Float32Array(capacity), 'agentId', {
      updatable: true,
      instanced: true,
      size: 1,
      stride: 1,
    });
    for (const mesh of this.#meshes) {
      mesh.setVerticesBuffer(segments.createVertexBuffer('fromTo', 0, 4), false);
      mesh.setVerticesBuffer(segments.createVertexBuffer('times', 4, 2), false);
      mesh.setVerticesBuffer(states, false);
      mesh.setVerticesBuffer(ids, false);
    }
    this.#segments = segments;
    this.#states = states;
    this.#ids = ids;
    this.#idsFloat32 = new Float32Array(capacity);
    this.#capacity = capacity;
  }

  #disposeBuffers(): void {
    this.#segments?.dispose();
    this.#states?.dispose();
    this.#ids?.dispose();
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
function shaderMaterial(name: string, scene: Scene, vertexSource: string, fragmentSource: string, options: Partial<IShaderMaterialOptions>): ShaderMaterial {
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
