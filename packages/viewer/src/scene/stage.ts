/**
 * The 3D scene of a page (docs/ARCHITECTURE.md, "Показ"), on Babylon.js
 * (П-48): the engine on a canvas, a right-handed scene with y up, light, and
 * a camera that orbits a point, pans and zooms. The model's floor plane x, y
 * lies in the scene as x and −z (toWorld), as the agents' shader puts it.
 */
import type { Point } from '@mozaika/kernel';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera.js';
import { Engine } from '@babylonjs/core/Engines/engine.js';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { Scene } from '@babylonjs/core/scene.js';

import { LIGHT_DIRECTION } from './agent-look.js';

/** Where the camera looks from, around the point it looks at. */
export interface CameraView {
  /** The point on the model's floor the camera looks at. */
  readonly target: Point;
  /** Distance from it, in the model's units of length. */
  readonly distance: number;
  /** Angle from straight above, in radians: 0 looks down, π/2 along the floor. */
  readonly tilt: number;
  /** Nearest and farthest the camera may zoom to. */
  readonly closest: number;
  readonly farthest: number;
}

export interface StageOptions {
  /** Colour behind the scene, '#rrggbb'. */
  readonly background: string;
  readonly view: CameraView;
}

/** A point of the model's floor, `height` above it, in the coordinates of the scene. */
export function toWorld(point: Point, height = 0): Vector3 {
  return new Vector3(point.x, height, -point.y);
}

export class Stage {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly camera: ArcRotateCamera;
  readonly #canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement, options: StageOptions) {
    this.#canvas = canvas;
    this.engine = new Engine(canvas, true, { powerPreference: 'high-performance', stencil: false }, false);
    // Sharp on high-density screens, but not more than twice: past that pixels cost more than they show.
    this.engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio, 2));
    this.scene = new Scene(this.engine);
    this.scene.useRightHandedSystem = true;
    this.scene.clearColor = Color4.FromHexString(`${options.background}ff`);

    // Soft light from the sky and one from the side, as the agents' shader has it (agent-look.ts).
    const sky = new HemisphericLight('sky', new Vector3(0, 1, 0), this.scene);
    sky.intensity = 0.6;
    sky.groundColor = Color3.FromHexString('#6d665c');
    const sun = new DirectionalLight('sun', new Vector3(...LIGHT_DIRECTION).scale(-1), this.scene);
    sun.intensity = 0.45;

    const { view } = options;
    // Babylon's angle around the vertical: π/2 puts the camera on the side of smaller model y, facing towards larger.
    this.camera = new ArcRotateCamera('camera', Math.PI / 2, view.tilt, view.distance, toWorld(view.target), this.scene);
    this.camera.lowerRadiusLimit = view.closest;
    this.camera.upperRadiusLimit = view.farthest;
    this.camera.upperBetaLimit = Math.PI / 2 - 0.08;
    this.camera.minZ = Math.max(0.05, view.closest / 50);
    this.camera.maxZ = view.farthest * 4;
    this.camera.useNaturalPinchZoom = true;
    this.camera.wheelDeltaPercentage = 0.02;
    this.camera.attachControl(canvas, true);
    this.#followPanning();
  }

  /** The renderer, as the browser names the graphics card, if it tells. */
  get renderer(): string {
    const info = this.engine.getGlInfo();
    return info.renderer;
  }

  /** A plain matte material, '#rrggbb'. */
  matte(name: string, colour: string): StandardMaterial {
    const material = new StandardMaterial(name, this.scene);
    material.diffuseColor = Color3.FromHexString(colour);
    material.specularColor = Color3.Black();
    return material;
  }

  /** Draws a frame, at the canvas's current size. */
  render(): void {
    this.engine.resize();
    this.scene.render();
  }

  /** The canvas's size in pixels, as drawn. */
  get size(): readonly [number, number] {
    return [this.#canvas.width, this.#canvas.height];
  }

  dispose(): void {
    this.scene.dispose();
    this.engine.dispose();
  }

  /**
   * Panning in proportion to the distance, so that the floor follows the
   * cursor whether the camera is close or far: Babylon's sensibility is a
   * divisor of the pointer's movement.
   */
  #followPanning(): void {
    this.camera.onViewMatrixChangedObservable.add(() => {
      const pixels = Math.max(1, this.#canvas.clientHeight);
      const metresPerPixel = (2 * this.camera.radius * Math.tan(this.camera.fov / 2)) / pixels;
      this.camera.panningSensibility = 1 / metresPerPixel;
    });
    const pixels = Math.max(1, this.#canvas.clientHeight);
    this.camera.panningSensibility = pixels / (2 * this.camera.radius * Math.tan(this.camera.fov / 2));
  }
}
