/**
 * The formula of the vertex shader on a graphics card (Ф0-6б): the GLSL of
 * segment-shader.ts runs in WebGL 2 with transform feedback, which hands back
 * what the shader computed, and must agree with its twin in TypeScript —
 * which the unit tests hold to positionsAt and to the kernel's positions.
 */
import { expect, test } from '@playwright/test';

import { SEGMENT_POSITION_GLSL, SEGMENT_WIDTH as SEGMENT, shaderPositions } from '../src/scene/segment-shader.js';

/** Segments of every kind: walking, standing, not begun yet, of no duration, far from the origin. */
function segments(count: number): Float32Array {
  // A small generator of our own: the test must give the same segments on every run.
  let state = 20_261_021;
  const next = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
  const out = new Float32Array(SEGMENT * count);
  for (let agent = 0; agent < count; agent++) {
    const scale = agent % 7 === 0 ? 10_000 : 100;
    const from = [next() * scale, next() * scale];
    const to = agent % 5 === 0 ? from : [next() * scale, next() * scale];
    const start = (next() - 0.7) * 10;
    const arrival = agent % 11 === 0 ? start : start + next() * 10;
    out.set([from[0] ?? 0, from[1] ?? 0, to[0] ?? 0, to[1] ?? 0, start, arrival], SEGMENT * agent);
  }
  return out;
}

test('the shader puts agents where its twin in TypeScript does, to the precision of Float32', async ({ page }) => {
  const count = 5_000;
  const input = segments(count);
  const moments = [-8, -1, 0, 0.25, 1.5, 3, 7.75, 20];
  await page.goto('./');
  const fromGpu = await page.evaluate(
    ({ glsl, data, count, moments }) => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (gl === null) throw new Error('no WebGL 2');
      const compile = (type: number, source: string): WebGLShader => {
        const shader = gl.createShader(type);
        if (shader === null) throw new Error('no shader');
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) throw new Error(String(gl.getShaderInfoLog(shader)));
        return shader;
      };
      const program = gl.createProgram();
      gl.attachShader(
        program,
        compile(
          gl.VERTEX_SHADER,
          `#version 300 es
          precision highp float;
          in vec4 fromTo;
          in vec2 times;
          uniform float since;
          out vec2 position;
          ${glsl}
          void main() {
            position = segmentPosition(fromTo, times, since);
            gl_Position = vec4(0.0);
          }`,
        ),
      );
      gl.attachShader(
        program,
        compile(gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float;\nout vec4 colour;\nvoid main() { colour = vec4(0.0); }'),
      );
      gl.transformFeedbackVaryings(program, ['position'], gl.INTERLEAVED_ATTRIBS);
      gl.linkProgram(program);
      if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) throw new Error(String(gl.getProgramInfoLog(program)));
      gl.useProgram(program);

      const input = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, input);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
      // The same layout as the instanced attributes of the scene: one buffer, 24 bytes per agent.
      const fromTo = gl.getAttribLocation(program, 'fromTo');
      const times = gl.getAttribLocation(program, 'times');
      gl.enableVertexAttribArray(fromTo);
      gl.vertexAttribPointer(fromTo, 4, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(times);
      gl.vertexAttribPointer(times, 2, gl.FLOAT, false, 24, 16);

      const output = gl.createBuffer();
      const feedback = gl.createTransformFeedback();
      gl.enable(gl.RASTERIZER_DISCARD);
      const results: number[][] = [];
      for (const since of moments) {
        gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, output);
        gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, 8 * count, gl.STREAM_READ);
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, feedback);
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, output);
        gl.uniform1f(gl.getUniformLocation(program, 'since'), since);
        gl.beginTransformFeedback(gl.POINTS);
        gl.drawArrays(gl.POINTS, 0, count);
        gl.endTransformFeedback();
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
        const positions = new Float32Array(2 * count);
        gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, output);
        gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, positions);
        results.push([...positions]);
      }
      return results;
    },
    { glsl: SEGMENT_POSITION_GLSL, data: [...input], count, moments },
  );

  moments.forEach((since, index) => {
    const twin = new Float32Array(2 * count);
    shaderPositions(input, count, since, twin);
    const gpu = fromGpu[index] ?? [];
    expect(gpu).toHaveLength(2 * count);
    let worst = 0;
    twin.forEach((expected, cell) => {
      // A few units in the last place of Float32 at the size of the segment's ends, not of the result: a
      // graphics card may fuse a multiplication and an addition, or divide by a reciprocal, and where
      // the result cancels (from 9 000 towards 10 gives about 100) the error is that of the larger numbers.
      const row = Math.floor(cell / 2);
      const axis = cell % 2;
      const operands = Math.max(
        1,
        Math.abs(input[SEGMENT * row + axis] ?? 0),
        Math.abs(input[SEGMENT * row + 2 + axis] ?? 0),
      );
      const ulp = 2 ** -23 * operands;
      worst = Math.max(worst, Math.abs((gpu[cell] ?? Number.NaN) - expected) / ulp);
    });
    expect(worst, `since = ${String(since)}: the largest difference, in units in the last place`).toBeLessThanOrEqual(8);
  });
});
