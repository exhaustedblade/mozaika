/**
 * The pages with a scene, in a real browser (Ф0-6б): the demo draws its hall
 * and people and keeps its laws, the benchmark measures its crowd, and a
 * browser without WebGL 2 gets a message. Screenshots go to e2e/results.
 */
import { expect, type Page, test } from '@playwright/test';

import type { BenchResult } from '../src/bench/result.js';
import { frameStats, pageErrors } from './frames.js';
import { kilobytes, loadedScripts, RESULTS, saveResult, scriptSize, summarise } from './report.js';

/** Agents of the benchmark in CI; BENCH_AGENTS=100000,1000000 measures a million too. */
const BENCH_AGENTS = (process.env.BENCH_AGENTS ?? '100000').split(',').map(Number);

/** The figures of the demo's panel, by their label in Russian. */
async function figure(page: Page, label: string): Promise<number> {
  const text = await page.locator('.figures div', { hasText: label }).locator('dd').textContent();
  return Number((text ?? '').replace(/\s/g, '').replace(',', '.'));
}

/** Checks that the canvas shows a drawn scene, not an empty frame, and saves a screenshot of the page. */
async function expectDrawn(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${RESULTS}${name}.png` });
  const stats = await frameStats(page.context(), await page.locator('canvas.scene-canvas').screenshot());
  saveResult(`${name}-frame`, stats);
  expect(stats.colours, `colours in the frame of ${name}`).toBeGreaterThan(40);
  expect(stats.commonest, `share of the commonest colour in ${name}`).toBeLessThan(0.8);
}

test('the home page links to the demo and to the benchmark', async ({ page }) => {
  await page.goto('./?lang=ru');
  await expect(page.getByRole('link', { name: 'Демо: пункт обслуживания' })).toHaveAttribute('href', 'demo.html?lang=ru');
  await expect(page.getByRole('link', { name: 'Замер сцены' })).toHaveAttribute('href', 'bench.html?lang=ru');
});

test('the demo draws the hall with people in it, and the model keeps its laws', async ({ page }) => {
  const errors = pageErrors(page);
  const scripts = loadedScripts(page);
  await page.goto('demo.html?lang=ru');
  // Faster model time, so that people come in and the line forms within the test.
  await page.locator('input[name="minutesPerSecond"]').fill('2');
  await page.locator('input[name="arrivalsPerMinute"]').fill('2.4');
  await expect.poll(() => figure(page, 'Людей в зале'), { timeout: 90_000 }).toBeGreaterThan(12);
  await expect.poll(() => figure(page, 'Обслужено'), { timeout: 60_000 }).toBeGreaterThan(5);
  await expect(page.locator('.law-mark.holds')).toHaveCount(3);
  await expect(page.locator('.law-mark.broken')).toHaveCount(0);
  await expectDrawn(page, 'demo');
  expect(errors).toEqual([]);
  const size = scriptSize(scripts);
  saveResult('demo-scripts', { ...size, scripts: [...scripts] });
  summarise(
    [
      '### Демо «пункт обслуживания»',
      '',
      `Скрипты страницы вместе с Worker: ${String(size.files)} файлов, ${kilobytes(size.bytes)} КБ, gzip ${kilobytes(size.gzipBytes)} КБ.`,
      '',
    ].join('\n'),
  );
});

test('the demo builds the model anew with another number of windows', async ({ page }) => {
  const errors = pageErrors(page);
  await page.goto('demo.html?lang=ru');
  await page.locator('input[name="minutesPerSecond"]').fill('2');
  await expect.poll(() => figure(page, 'Обслужено'), { timeout: 60_000 }).toBeGreaterThan(0);
  await page.locator('input[name="windows"]').fill('2');
  await expect(page.locator('.figures div', { hasText: 'Занято окон' }).locator('dd')).toHaveText(/\/ 2$/, {
    timeout: 30_000,
  });
  expect(errors).toEqual([]);
});

test('a browser without WebGL 2 gets a message in place of the scene', async ({ page }) => {
  await page.addInitScript(() => {
    // The browser of this test has WebGL 2; the page must believe it has none.
    const getContext: unknown = Reflect.get(HTMLCanvasElement.prototype, 'getContext');
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      value(this: HTMLCanvasElement, type: string, ...rest: unknown[]): unknown {
        return type === 'webgl2' ? null : Reflect.apply(getContext as (...args: unknown[]) => unknown, this, [type, ...rest]);
      },
    });
  });
  await page.goto('demo.html?lang=ru');
  await expect(page.getByRole('alert')).toContainText('WebGL 2');
  await page.goto('bench.html?lang=en');
  await expect(page.getByRole('alert')).toContainText('WebGL 2');
});

for (const agents of BENCH_AGENTS) {
  test(`the benchmark measures ${String(agents)} walking agents`, async ({ page }) => {
    const errors = pageErrors(page);
    const scripts = loadedScripts(page);
    await page.goto(`bench.html?agents=${String(agents)}&seconds=10&lang=ru`);
    await page.waitForFunction(() => window.mozaikaBench !== undefined, null, { timeout: 200_000 });
    const result: BenchResult | undefined = await page.evaluate(() => window.mozaikaBench);
    expect(result?.agents).toBe(agents);
    await expectDrawn(page, `bench-${String(agents)}`);
    expect(errors).toEqual([]);
    const size = scriptSize(scripts);
    saveResult(`bench-${String(agents)}`, { result, scripts: { ...size, list: [...scripts] } });
    if (result === undefined) return;
    const ms = (value: number): string => value.toFixed(2);
    summarise(
      [
        `### Замер сцены: ${agents.toLocaleString('ru-RU')} идущих агентов`,
        '',
        `Видеокарта: ${result.renderer}. Холст ${result.canvas.join('×')}. В CI видеокарта программная: кадры — только ориентир.`,
        '',
        '| Что | Медиана | 95 % |',
        '|---|---|---|',
        `| Кадров в секунду | ${result.framesPerSecond.toFixed(2)} | |`,
        `| Интервал кадров, мс | ${ms(result.frameInterval.median)} | ${ms(result.frameInterval.p95)} |`,
        `| Работа кадра в главном потоке, мс | ${ms(result.frameWork.median)} | ${ms(result.frameWork.p95)} |`,
        `| Снимок в Worker, мс | ${ms(result.snapshotInWorker.median)} | ${ms(result.snapshotInWorker.p95)} |`,
        `| Прогон ядра до кадра в Worker, мс | ${ms(result.runInWorker.median)} | ${ms(result.runInWorker.p95)} |`,
        `| Загрузка снимка на видеокарту, мс | ${ms(result.upload.median)} | ${ms(result.upload.p95)} |`,
        '',
        `Скрипты страницы вместе с Worker: ${String(size.files)} файлов, ${kilobytes(size.bytes)} КБ, gzip ${kilobytes(size.gzipBytes)} КБ.`,
        '',
      ].join('\n'),
    );
  });
}
