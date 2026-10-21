/**
 * The GLSL of the agents' shaders (docs/ARCHITECTURE.md, "Показ"): where an
 * agent stands in the scene, and how it looks — its colour by state and a
 * shade and a height of its own, by id — and the light. agent-layer.ts builds
 * its shaders from these pieces.
 */
import { SEGMENT_POSITION_GLSL } from './segment-shader.js';

/** Most state colours the shader takes; a state beyond them gets the last one. */
export const MAX_STATE_COLOURS = 8;

/** Where the light comes from: from above, in front and to the left, normalised in the shader. */
export const LIGHT_DIRECTION = [-0.45, 0.8, 0.4] as const;

/**
 * GLSL ES: where an agent stands, from the attributes `fromTo` and `times`
 * (its segment in the snapshot) and the uniform `since` (frame time minus
 * snapshot time). The model's plane x, y is the floor: x to the right, y into
 * the scene, which is −z in a right-handed scene with y up.
 */
export const AGENT_POSITION_GLSL = /* glsl */ `
${SEGMENT_POSITION_GLSL}

vec3 agentOffset(vec4 fromTo, vec2 times, float since) {
  vec2 onFloor = segmentPosition(fromTo, times, since);
  return vec3(onFloor.x, 0.0, -onFloor.y);
}
`;

/**
 * GLSL ES: how an agent looks, from the attributes `state` (state code) and
 * `agentId`, and the uniform `stateColours`. The shade and the height come
 * from the id rather than the row, so they stay when rows change (П-30).
 * Floats keep ids exact up to 2²⁴; past that, looks repeat, which is no harm for a look.
 */
export const AGENT_LOOK_GLSL = /* glsl */ `
// A number in 0…1 from an id: the PCG hash (M. O'Neill), whole numbers only, so every graphics card agrees.
float agentHash(float id, uint salt) {
  uint h = uint(id) * 747796405u + salt * 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  h = (h >> 22u) ^ h;
  return float(h) / 4294967295.0;
}

// x: height factor, y: shade factor.
vec2 agentLook(float id) {
  return vec2(0.9 + 0.2 * agentHash(id, 1u), 0.85 + 0.3 * agentHash(id, 2u));
}

vec3 stateColour(float state) {
  return stateColours[int(min(state, ${String(MAX_STATE_COLOURS - 1)}.0))];
}
`;

/**
 * GLSL ES function of the fragment shader: a soft light from the sky and the
 * ground, and one direct light, by the normal; `lightDirection` is a uniform.
 */
export const SHADE_GLSL = /* glsl */ `
vec3 shade(vec3 colour, vec3 normal) {
  vec3 n = normalize(normal);
  float direct = max(dot(n, normalize(lightDirection)), 0.0);
  float sky = 0.5 + 0.5 * n.y;
  return colour * (0.3 + 0.35 * sky + 0.55 * direct);
}
`;

/** Colours of states, as numbers 0xRRGGBB, padded to MAX_STATE_COLOURS with grey: [r, g, b] in 0…1 each. */
export function stateColourTable(colours: readonly number[]): number[] {
  const table: number[] = [];
  for (let state = 0; state < MAX_STATE_COLOURS; state++) {
    const colour = colours[state] ?? 0x8a8a90;
    table.push(((colour >> 16) & 0xff) / 255, ((colour >> 8) & 0xff) / 255, (colour & 0xff) / 255);
  }
  return table;
}
