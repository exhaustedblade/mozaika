/**
 * The hall of the demo in the 3D scene: the street around it, the floor,
 * walls with the entrance and the exit, the counters of the windows — open
 * ones with a clerk behind — and the posts and ropes of the serpentine line.
 * Simple primitives of our own, placed by the layout the model walks people
 * by (models/service-point-layout.ts).
 */
import type { Point } from '@mozaika/kernel';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder.js';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder.js';
import { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js';

import { counterOf, DOORS, HALL, lineRows, MAX_WINDOWS } from '../models/service-point-layout.js';
import { personMesh } from '../scene/person-geometry.js';
import { type Stage, toWorld } from '../scene/stage.js';

const WALL = { height: 2.6, thickness: 0.2, front: 0.45 } as const;
const COUNTER = { width: 2.1, depth: 0.7, height: 1.05 } as const;
const ROPE = { height: 0.9, thickness: 0.05 } as const;

/** Colours of the hall, '#rrggbb'. */
const COLOURS = {
  street: '#b5b0a5',
  floor: '#dcd7cd',
  wall: '#f1eee8',
  counterOpen: '#8f6b4e',
  counterClosed: '#b3afa7',
  clerk: '#4f5d6b',
  rope: '#7a2e3a',
  post: '#55585e',
  mat: '#6f6b63',
} as const;

export class Hall {
  readonly #stage: Stage;
  readonly #materials: Record<keyof typeof COLOURS, StandardMaterial>;
  /** The counters and clerks, made anew when the number of open windows changes. */
  #windows: Mesh[] = [];

  constructor(stage: Stage) {
    this.#stage = stage;
    this.#materials = Object.fromEntries(
      Object.entries(COLOURS).map(([name, colour]) => [name, stage.matte(name, colour)]),
    ) as Record<keyof typeof COLOURS, StandardMaterial>;
    this.#ground();
    this.#walls();
    this.#line();
  }

  /** Shows `open` windows open, from the left: a counter with a clerk; the others closed. */
  openWindows(open: number): void {
    for (const mesh of this.#windows) mesh.dispose();
    this.#windows = [];
    for (let window = 0; window < MAX_WINDOWS; window++) {
      const { counter, clerk } = counterOf(window);
      const isOpen = window < open;
      this.#windows.push(
        this.#box(
          `counter ${String(window)}`,
          counter,
          { x: COUNTER.width, y: COUNTER.depth, height: COUNTER.height },
          isOpen ? 'counterOpen' : 'counterClosed',
        ),
      );
      if (isOpen) this.#windows.push(this.#clerk(window, clerk));
    }
  }

  #ground(): void {
    const scene = this.#stage.scene;
    const centre = { x: HALL.width / 2, y: HALL.depth / 2 };
    const street = CreateGround('street', { width: HALL.width + 60, height: HALL.depth + 40 }, scene);
    street.position = toWorld(centre, -0.02);
    street.material = this.#materials.street;
    const floor = CreateGround('floor', { width: HALL.width, height: HALL.depth }, scene);
    floor.position = toWorld(centre);
    floor.material = this.#materials.floor;
    const entrance = (DOORS.entrance.from + DOORS.entrance.to) / 2;
    const exit = (DOORS.exit.from + DOORS.exit.to) / 2;
    this.#box('entrance mat', { x: 0.7, y: entrance }, { x: 1.4, y: 2, height: 0.01 }, 'mat');
    this.#box('exit mat', { x: HALL.width - 0.7, y: exit }, { x: 1.4, y: 2, height: 0.01 }, 'mat');
  }

  /** Full walls behind and at the sides, with the doors; a low one in front, so the camera sees in. */
  #walls(): void {
    const { width, depth } = HALL;
    const t = WALL.thickness;
    this.#wallAlongX('back wall', depth, -t / 2, width + t / 2, WALL.height);
    this.#wallAlongX('front wall', 0, -t / 2, width + t / 2, WALL.front);
    this.#wallAlongY('left wall', 0, 0, DOORS.entrance.from);
    this.#wallAlongY('left wall', 0, DOORS.entrance.to, depth);
    this.#wallAlongY('right wall', width, 0, DOORS.exit.from);
    this.#wallAlongY('right wall', width, DOORS.exit.to, depth);
    // Partitions between the windows, from the counters back to the wall.
    for (let window = 0; window <= MAX_WINDOWS; window++) {
      const { counter } = counterOf(window);
      const x = counter.x - COUNTER.width / 2 - 0.2;
      const fromY = counter.y - COUNTER.depth / 2;
      this.#box(`partition ${String(window)}`, { x, y: (fromY + depth) / 2 }, { x: 0.08, y: depth - fromY, height: 1.7 }, 'wall');
    }
  }

  /**
   * Ropes below each row of the serpentine, open at the end where the row
   * turns into the next — for the last row, where people join the line — and
   * one above the top row, open where its head leaves for the windows.
   */
  #line(): void {
    const rows = lineRows();
    const turn = 0.45;
    rows.forEach((row, index) => {
      const next = rows[index + 1];
      const y = next === undefined ? row.y - 0.6 : (row.y + next.y) / 2;
      // Row 0 runs right to left, so it turns into row 1 at the left end; row 1 at the right; and so on.
      const turnsLeft = index % 2 === 0;
      const fromX = turnsLeft ? row.fromX + turn : row.fromX - 0.5;
      const toX = turnsLeft ? row.toX + 0.5 : row.toX - turn;
      this.#rope(index, y, fromX, toX);
    });
    const top = rows[0];
    if (top !== undefined) this.#rope(-1, top.y + 0.6, top.fromX - 0.5, top.toX - turn);
  }

  #rope(index: number, y: number, fromX: number, toX: number): void {
    const name = `rope ${String(index)}`;
    this.#box(name, { x: (fromX + toX) / 2, y }, { x: toX - fromX, y: ROPE.thickness, height: ROPE.thickness }, 'rope', ROPE.height - 0.05);
    for (const x of [fromX, toX]) {
      const post = CreateCylinder(`${name} post`, { height: ROPE.height, diameter: 0.07, tessellation: 8 }, this.#stage.scene);
      post.position = toWorld({ x, y }, ROPE.height / 2);
      post.material = this.#materials.post;
    }
  }

  #wallAlongX(name: string, y: number, fromX: number, toX: number, height: number): void {
    this.#box(name, { x: (fromX + toX) / 2, y }, { x: toX - fromX, y: WALL.thickness, height }, 'wall');
  }

  #wallAlongY(name: string, x: number, fromY: number, toY: number): void {
    this.#box(name, { x, y: (fromY + toY) / 2 }, { x: WALL.thickness, y: toY - fromY, height: WALL.height }, 'wall');
  }

  /** A box standing on the floor (or `lifted` above it), its centre over `at`, sized along the model's x and y. */
  #box(
    name: string,
    at: Point,
    size: { x: number; y: number; height: number },
    colour: keyof typeof COLOURS,
    lifted = 0,
  ): Mesh {
    const box = CreateBox(name, { width: size.x, depth: size.y, height: size.height }, this.#stage.scene);
    box.position = toWorld(at, lifted + size.height / 2);
    box.material = this.#materials[colour];
    box.isPickable = false;
    return box;
  }

  #clerk(window: number, at: Point): Mesh {
    const person = personMesh();
    const clerk = new Mesh(`clerk ${String(window)}`, this.#stage.scene);
    const data = new VertexData();
    data.positions = person.positions;
    data.normals = person.normals;
    data.indices = person.indices;
    data.applyToMesh(clerk);
    clerk.position = toWorld(at);
    const material = this.#materials.clerk;
    // Our meshes are counter-clockwise seen from outside (person-geometry.ts).
    material.sideOrientation = Constants.MATERIAL_CounterClockWiseSideOrientation;
    clerk.material = material;
    return clerk;
  }
}
