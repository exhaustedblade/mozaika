/**
 * Whether the browser can draw the scene: it needs WebGL 2 (docs/ARCHITECTURE.md,
 * "Показ"). Without it the page shows a message in place of the scene.
 */

/** True if a WebGL 2 context can be made; the test context is let go at once. */
export function canDrawScene(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return gl !== null;
  } catch {
    return false;
  }
}

/** The message shown in place of the scene. */
export function sceneUnavailable(text: string): HTMLElement {
  const message = document.createElement('p');
  message.className = 'scene-unavailable';
  message.setAttribute('role', 'alert');
  message.textContent = text;
  return message;
}
