/** The benchmark scene on Babylon.js (see stage.ts). */
import type { PopulationSnapshot } from '@mozaika/kernel';
import { Buffer, VertexBuffer } from '@babylonjs/core/Buffers/buffer.js';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { Engine } from '@babylonjs/core/Engines/engine.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';
import { Scene } from '@babylonjs/core/scene.js';

import { AGENT_GLSL, LIGHT_DIRECTION, MAX_STATE_COLOURS, SHADE_GLSL, stateColourTable } from '../scene/agent-look.js';
import type { MeshData } from '../scene/person-geometry.js';
import { type BenchStage, type BenchStageOptions, capacityFor, rendererName } from './stage.js';

// Babylon's GLSL: it turns attribute and varying into WebGL 2's in and out itself.
const VERTEX = /* glsl */ `
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

const FRAGMENT = /* glsl */ `
precision highp float;
uniform vec3 lightDirection;
varying vec3 vColour;
varying vec3 vNormal;
${SHADE_GLSL}
void main() {
  gl_FragColor = vec4(shade(vColour, vNormal), 1.0);
}
`;

/** The agents: one mesh drawn `forcedInstanceCount` times, its attributes per agent filled from snapshots. */
class Agents {
  readonly mesh: Mesh;
  readonly #engine: Engine;
  #segments: Buffer | undefined;
  #states: VertexBuffer | undefined;
  #ids: VertexBuffer | undefined;
  #capacity = 0;
  readonly #material: ShaderMaterial;

  constructor(scene: Scene, engine: Engine, stateColours: readonly number[], person: MeshData) {
    this.#engine = engine;
    this.mesh = new Mesh('agents', scene);
    const data = new VertexData();
    data.positions = person.positions;
    data.normals = person.normals;
    data.indices = person.indices;
    data.applyToMesh(this.mesh);
    this.#material = new ShaderMaterial(
      'agents',
      scene,
      { vertexSource: VERTEX, fragmentSource: FRAGMENT },
      {
        attributes: ['position', 'normal', 'fromTo', 'times', 'state', 'agentId'],
        uniforms: ['viewProjection', 'since', 'stateColours', 'lightDirection'],
      },
    );
    this.#material.setArray3('stateColours', stateColourTable(stateColours));
    this.#material.setVector3('lightDirection', new Vector3(...LIGHT_DIRECTION));
    this.mesh.material = this.#material;
    // The agents are wherever their segments take them: no bounds to cull by.
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.#grow(1024);
  }

  upload(snapshot: PopulationSnapshot): void {
    if (snapshot.size > this.#capacity) this.#grow(capacityFor(snapshot.size));
    const size = snapshot.size;
    this.#segments?.updateDirectly(snapshot.segments, 0, size);
    this.#states?.updateDirectly(snapshot.states, 0);
    const ids = new Float32Array(size);
    ids.set(snapshot.ids);
    this.#ids?.updateDirectly(ids, 0);
    this.mesh.forcedInstanceCount = size;
  }

  set since(value: number) {
    this.#material.setFloat('since', value);
  }

  #grow(capacity: number): void {
    this.#segments?.dispose();
    this.#states?.dispose();
    this.#ids?.dispose();
    const engine = this.#engine;
    this.#segments = new Buffer(engine, new Float32Array(6 * capacity), true, 6, false, true);
    this.mesh.setVerticesBuffer(this.#segments.createVertexBuffer('fromTo', 0, 4));
    this.mesh.setVerticesBuffer(this.#segments.createVertexBuffer('times', 4, 2));
    this.#states = new VertexBuffer(engine, new Uint16Array(capacity), 'state', {
      updatable: true,
      instanced: true,
      size: 1,
      stride: 1,
      type: VertexBuffer.UNSIGNED_SHORT,
      normalized: false,
    });
    this.mesh.setVerticesBuffer(this.#states);
    this.#ids = new VertexBuffer(engine, new Float32Array(capacity), 'agentId', {
      updatable: true,
      instanced: true,
      size: 1,
      stride: 1,
    });
    this.mesh.setVerticesBuffer(this.#ids);
    this.mesh.forcedInstanceCount = 0;
    this.#capacity = capacity;
  }
}

export function createStage(canvas: HTMLCanvasElement, options: BenchStageOptions): BenchStage {
  const engine = new Engine(canvas, true, { powerPreference: 'high-performance' }, false);
  engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio, 2));
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  scene.clearColor = new Color4(0xdf / 255, 0xe3 / 255, 0xe8 / 255, 1);
  const { side } = options;
  const centre = new Vector3(side / 2, 0, -side / 2);

  const floor = CreateGround('floor', { width: side, height: side }, scene);
  floor.position = centre.clone();
  const floorMaterial = new StandardMaterial('floor', scene);
  floorMaterial.diffuseColor = Color3.FromHexString('#c9c4b8');
  floorMaterial.specularColor = Color3.Black();
  floor.material = floorMaterial;
  const light = new HemisphericLight('sky', new Vector3(...LIGHT_DIRECTION), scene);
  light.groundColor = Color3.FromHexString('#8a8478');

  const agents = new Agents(scene, engine, options.stateColours, options.mesh);

  const camera = new ArcRotateCamera('camera', Math.PI / 2, 0.92, side * 0.93, centre, scene);
  camera.minZ = 0.5;
  camera.maxZ = side * 6;
  camera.upperBetaLimit = Math.PI / 2 - 0.05;
  camera.attachControl(canvas, true);

  return {
    renderer: rendererName(engine._gl as WebGL2RenderingContext),
    upload: (snapshot) => {
      agents.upload(snapshot);
    },
    render: (since) => {
      engine.resize();
      agents.since = since;
      scene.render();
    },
  };
}
