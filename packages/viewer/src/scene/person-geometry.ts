/**
 * The mesh of one person, drawn once per agent by instancing: a low-poly
 * figure of revolution about the vertical axis — feet, hips, shoulders, neck
 * and head — about 1.75 m tall, standing on the floor at the origin. It is
 * our own few numbers rather than a model file: at 100 000 people every
 * vertex counts (docs/ARCHITECTURE.md, "Показ").
 */

/** Positions, normals (three numbers per vertex) and triangles (three indices each). */
export interface MeshData {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint16Array;
}

/** The outline of the figure, bottom to top: radius and height in metres. */
const PROFILE: readonly (readonly [radius: number, height: number])[] = [
  [0.12, 0],
  [0.15, 0.5],
  [0.19, 0.92],
  [0.17, 1.12],
  [0.23, 1.36],
  [0.13, 1.5],
  [0.07, 1.53],
  [0.11, 1.62],
  [0.09, 1.72],
  [0, 1.76],
];

/** Sides around the axis: a hexagon reads as round at the size a person takes on screen. */
const SIDES = 6;

/** The person: a ring of SIDES vertices per point of the profile, with a cap under the feet. */
export function personMesh(): MeshData {
  const rings = PROFILE.length;
  const vertices = rings * SIDES + 1;
  const positions = new Float32Array(3 * vertices);
  const normals = new Float32Array(3 * vertices);
  PROFILE.forEach(([radius, height], ring) => {
    const [normalRadial, normalUp] = profileNormal(ring);
    for (let side = 0; side < SIDES; side++) {
      const angle = (2 * Math.PI * side) / SIDES;
      const vertex = ring * SIDES + side;
      positions.set([radius * Math.cos(angle), height, radius * Math.sin(angle)], 3 * vertex);
      normals.set([normalRadial * Math.cos(angle), normalUp, normalRadial * Math.sin(angle)], 3 * vertex);
    }
  });
  // The centre of the cap under the feet, facing down.
  const bottom = rings * SIDES;
  normals.set([0, -1, 0], 3 * bottom);

  const indices: number[] = [];
  for (let ring = 0; ring + 1 < rings; ring++) {
    for (let side = 0; side < SIDES; side++) {
      const a = ring * SIDES + side;
      const b = ring * SIDES + ((side + 1) % SIDES);
      const c = a + SIDES;
      const d = b + SIDES;
      // Counter-clockwise seen from outside: the front face in a right-handed scene.
      indices.push(a, c, b, b, c, d);
    }
  }
  for (let side = 0; side < SIDES; side++) indices.push(bottom, side, (side + 1) % SIDES);
  return { positions, normals, indices: Uint16Array.from(indices) };
}

/**
 * The normal of the surface at a point of the profile: perpendicular to the
 * outline there, from the neighbouring points; as (radial, up), of length one.
 */
function profileNormal(ring: number): [number, number] {
  const [belowRadius, belowHeight] = PROFILE[Math.max(0, ring - 1)] ?? [0, 0];
  const [aboveRadius, aboveHeight] = PROFILE[Math.min(PROFILE.length - 1, ring + 1)] ?? [0, 0];
  const radial = aboveHeight - belowHeight;
  const up = belowRadius - aboveRadius;
  const length = Math.hypot(radial, up);
  return [radial / length, up / length];
}

/** A flat disc on the floor under a person, for its soft shadow: a fan of triangles, facing up. */
export function floorDisc(): { mesh: MeshData; radius: number } {
  const radius = 0.4;
  const sides = 12;
  // Above the floor by as much as the depth buffer tells apart from the farthest zoom of a scene.
  const height = 0.02;
  const positions = new Float32Array(3 * (sides + 1));
  const normals = new Float32Array(3 * (sides + 1));
  positions.set([0, height, 0], 0);
  normals.set([0, 1, 0], 0);
  for (let side = 0; side < sides; side++) {
    const angle = (2 * Math.PI * side) / sides;
    positions.set([radius * Math.cos(angle), height, radius * Math.sin(angle)], 3 * (side + 1));
    normals.set([0, 1, 0], 3 * (side + 1));
  }
  const indices: number[] = [];
  // Counter-clockwise seen from above.
  for (let side = 0; side < sides; side++) indices.push(0, ((side + 1) % sides) + 1, side + 1);
  return { mesh: { positions, normals, indices: Uint16Array.from(indices) }, radius };
}
