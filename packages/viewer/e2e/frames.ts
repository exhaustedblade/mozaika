/** What a screenshot of a scene shows, to tell a drawn frame from an empty one. */
import type { BrowserContext, Page } from '@playwright/test';

export interface FrameStats {
  readonly width: number;
  readonly height: number;
  /** Colours in the picture, each channel rounded to 16 levels. */
  readonly colours: number;
  /** Share of the pixels in the commonest colour: the background, in an empty frame all of them. */
  readonly commonest: number;
}

/**
 * Counts the colours of a PNG screenshot. The browser decodes it, so the
 * tests need no image library: a blank page of its own draws it on a canvas
 * kept in memory and reads it back — away from the graphics card, which a
 * scene may keep busy for seconds a frame in CI.
 */
export async function frameStats(context: BrowserContext, png: Buffer): Promise<FrameStats> {
  const page = await context.newPage();
  const stats = await page.evaluate(async (base64) => {
    const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
    const image = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(image.width, image.height);
    const drawing = canvas.getContext('2d', { willReadFrequently: true });
    if (drawing === null) throw new Error('no 2D canvas to decode the screenshot on');
    drawing.drawImage(image, 0, 0);
    const { data } = drawing.getImageData(0, 0, image.width, image.height);
    const counts = new Map<number, number>();
    for (let i = 0; i < data.length; i += 4) {
      const colour = ((data[i] ?? 0) >> 4) * 256 + ((data[i + 1] ?? 0) >> 4) * 16 + ((data[i + 2] ?? 0) >> 4);
      counts.set(colour, (counts.get(colour) ?? 0) + 1);
    }
    const pixels = image.width * image.height;
    return {
      width: image.width,
      height: image.height,
      colours: counts.size,
      commonest: Math.max(...counts.values()) / pixels,
    };
  }, png.toString('base64'));
  await page.close();
  return stats;
}

/** Errors a page reports, from its scripts and its console, to check that there are none. */
export function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}
