/** The benchmark scene on three.js (see stage.ts). */
import type { PopulationSnapshot } from '@mozaika/kernel';
import {
  BufferAttribute,
  Color,
  DirectionalLight,
  DynamicDrawUsage,
  GLSL3,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RawShaderMaterial,
  Scene,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { AGENT_GLSL, LIGHT_DIRECTION, MAX_STATE_COLOURS, SHADE_GLSL, stateColourTable } from '../scene/agent-look.js';
import type { MeshData } from '../scene/person-geometry.js';
import { type BenchStage, type BenchStageOptions, capacityFor, rendererName } from './stage.js';

const VERTEX = /* glsl */ `
precision highp float;
precision highp int;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform float since;
uniform vec3 stateColours[${String(MAX_STATE_COLOURS)}];
in vec3 position;
in vec3 normal;
in vec4 fromTo;
in vec2 times;
in float state;
in float agentId;
out vec3 vColour;
out vec3 vNormal;
${AGENT_GLSL}
void main() {
  vec2 look = agentLook(agentId);
  vec3 world = agentOffset(fromTo, times, since) + position * vec3(1.0, look.x, 1.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  vColour = stateColour(state) * look.y;
  vNormal = normal;
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
uniform vec3 lightDirection;
in vec3 vColour;
in vec3 vNormal;
out vec4 fragColour;
${SHADE_GLSL}
void main() {
  fragColour = vec4(shade(vColour, vNormal), 1.0);
}
`;

/** The agents: one instanced mesh, its attributes per agent filled from snapshots. */
class Agents {
  readonly mesh: Mesh<InstancedBufferGeometry, RawShaderMaterial>;
  #segments: InstancedInterleavedBuffer;
  #states: InstancedBufferAttribute;
  #ids: InstancedBufferAttribute;
  #capacity = 0;
  readonly #mesh: MeshData;

  constructor(stateColours: readonly number[], mesh: MeshData) {
    this.#mesh = mesh;
    const material = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        since: { value: 0 },
        stateColours: { value: new Float32Array(stateColourTable(stateColours)) },
        lightDirection: { value: [...LIGHT_DIRECTION] },
      },
    });
    this.#segments = new InstancedInterleavedBuffer(new Float32Array(0), 6);
    this.#states = new InstancedBufferAttribute(new Uint16Array(0), 1);
    this.#ids = new InstancedBufferAttribute(new Float32Array(0), 1);
    this.mesh = new Mesh(this.#geometry(1024), material);
    // The agents are wherever their segments take them: no bounds to cull by.
    this.mesh.frustumCulled = false;
  }

  upload(snapshot: PopulationSnapshot): void {
    if (snapshot.size > this.#capacity) {
      this.mesh.geometry.dispose();
      this.mesh.geometry = this.#geometry(capacityFor(snapshot.size));
    }
    const size = snapshot.size;
    this.#segments.array.set(snapshot.segments);
    this.#segments.clearUpdateRanges();
    this.#segments.addUpdateRange(0, 6 * size);
    this.#segments.needsUpdate = true;
    this.#states.array.set(snapshot.states);
    this.#states.clearUpdateRanges();
    this.#states.addUpdateRange(0, size);
    this.#states.needsUpdate = true;
    this.#ids.array.set(snapshot.ids);
    this.#ids.clearUpdateRanges();
    this.#ids.addUpdateRange(0, size);
    this.#ids.needsUpdate = true;
    this.mesh.geometry.instanceCount = size;
  }

  set since(value: number) {
    const uniform = this.mesh.material.uniforms.since;
    if (uniform !== undefined) uniform.value = value;
  }

  #geometry(capacity: number): InstancedBufferGeometry {
    const person = this.#mesh;
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(person.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(person.normals, 3));
    geometry.setIndex(new BufferAttribute(person.indices, 1));
    this.#segments = new InstancedInterleavedBuffer(new Float32Array(6 * capacity), 6).setUsage(DynamicDrawUsage);
    geometry.setAttribute('fromTo', new InterleavedBufferAttribute(this.#segments, 4, 0));
    geometry.setAttribute('times', new InterleavedBufferAttribute(this.#segments, 2, 4));
    this.#states = new InstancedBufferAttribute(new Uint16Array(capacity), 1).setUsage(DynamicDrawUsage);
    geometry.setAttribute('state', this.#states);
    this.#ids = new InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(DynamicDrawUsage);
    geometry.setAttribute('agentId', this.#ids);
    geometry.instanceCount = 0;
    this.#capacity = capacity;
    return geometry;
  }
}

export function createStage(canvas: HTMLCanvasElement, options: BenchStageOptions): BenchStage {
  const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new Scene();
  scene.background = new Color(0xdfe3e8);
  const { side } = options;
  const centre = { x: side / 2, z: -side / 2 };

  const floor = new Mesh(new PlaneGeometry(side, side), new MeshStandardMaterial({ color: 0xc9c4b8, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(centre.x, 0, centre.z);
  scene.add(floor, new HemisphereLight(0xffffff, 0x8a8478, 1.6));
  const sun = new DirectionalLight(0xffffff, 1.4);
  sun.position.set(...LIGHT_DIRECTION);
  scene.add(sun);

  const agents = new Agents(options.stateColours, options.mesh);
  scene.add(agents.mesh);

  const camera = new PerspectiveCamera(45, 1, 0.5, side * 6);
  camera.position.set(centre.x, side * 0.55, centre.z + side * 0.75);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(centre.x, 0, centre.z);
  controls.maxPolarAngle = Math.PI / 2 - 0.05;
  controls.update();

  return {
    renderer: rendererName(renderer.getContext() as WebGL2RenderingContext),
    upload: (snapshot) => {
      agents.upload(snapshot);
    },
    render: (since) => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== Math.floor(width * renderer.getPixelRatio())) {
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      }
      agents.since = since;
      renderer.render(scene, camera);
    },
  };
}
