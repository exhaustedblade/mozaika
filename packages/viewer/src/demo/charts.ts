/**
 * The charts of the demo (ECharts): the length of the line, the utilization
 * of the windows and the time in the system, each over the last minute and
 * since the start, from the model's records (chart-series.ts). Colours are
 * slots 1 and 2 of the validated palette, stepped for light and dark.
 */
import { LineChart, type LineSeriesOption } from 'echarts/charts';
import {
  GridComponent,
  type GridComponentOption,
  LegendComponent,
  type LegendComponentOption,
  TooltipComponent,
  type TooltipComponentOption,
} from 'echarts/components';
import { type ComposeOption, type ECharts, init, use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';

import type { Messages } from '../i18n.js';
import type { ChartPoint, ChartPoints } from './chart-series.js';

use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

type ChartOption = ComposeOption<LineSeriesOption | GridComponentOption | LegendComponentOption | TooltipComponentOption>;

/** Most points a chart keeps: past them, the oldest go. Six hours of model time at a record a minute. */
const MOST_POINTS = 360;

/** The chart's colours: series by slot, text and chrome by role. */
interface ChartTheme {
  readonly series: readonly [string, string];
  readonly text: string;
  readonly muted: string;
  readonly grid: string;
  readonly axis: string;
  readonly surface: string;
}

const LIGHT: ChartTheme = {
  series: ['#2a78d6', '#eb6834'],
  text: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  surface: '#fcfcfb',
};

const DARK: ChartTheme = {
  series: ['#3987e5', '#d95926'],
  text: '#c3c2b7',
  muted: '#898781',
  grid: '#2c2c2a',
  axis: '#383835',
  surface: '#1a1a19',
};

type Measure = keyof ChartPoints;

interface MeasureChart {
  readonly measure: Measure;
  readonly title: keyof Messages;
  readonly digits: number;
  /** The top of the scale, if the measure has one: utilization is at most 1. */
  readonly max?: number;
}

const MEASURES: readonly MeasureChart[] = [
  { measure: 'queue', title: 'chartQueue', digits: 1 },
  { measure: 'utilization', title: 'chartUtilization', digits: 2, max: 1 },
  { measure: 'timeInSystem', title: 'chartTimeInSystem', digits: 2 },
];

/** One chart: a title above it and two lines. */
class Chart {
  readonly element = document.createElement('figure');
  readonly #title = document.createElement('figcaption');
  readonly #chart: ECharts;
  readonly #digits: number;
  readonly #max: number | undefined;
  readonly #lastInterval: [number, number | null][] = [];
  readonly #sinceStart: [number, number | null][] = [];

  constructor({ digits, max }: MeasureChart) {
    this.#digits = digits;
    this.#max = max;
    this.element.className = 'chart';
    const canvas = document.createElement('div');
    canvas.className = 'chart-canvas';
    this.element.append(this.#title, canvas);
    this.#chart = init(canvas, undefined, { renderer: 'canvas' });
  }

  add(point: ChartPoint): void {
    this.#lastInterval.push([point.time, point.lastInterval ?? null]);
    this.#sinceStart.push([point.time, point.sinceStart ?? null]);
    if (this.#lastInterval.length > MOST_POINTS) {
      this.#lastInterval.shift();
      this.#sinceStart.shift();
    }
  }

  clear(): void {
    this.#lastInterval.length = 0;
    this.#sinceStart.length = 0;
    this.redraw();
  }

  redraw(): void {
    this.#chart.setOption({ series: [{ data: this.#lastInterval }, { data: this.#sinceStart }] }, { lazyUpdate: true });
  }

  /** Sets everything but the data: texts and colours. */
  style(title: string, messages: Messages, theme: ChartTheme): void {
    this.#title.textContent = title;
    const number = new Intl.NumberFormat(messages.numberLocale, { maximumFractionDigits: this.#digits });
    const minute = new Intl.NumberFormat(messages.numberLocale, { maximumFractionDigits: 0 });
    const line = (name: string, colour: string): LineSeriesOption => ({
      type: 'line',
      name,
      showSymbol: false,
      symbolSize: 8,
      connectNulls: false,
      lineStyle: { width: 2, color: colour },
      itemStyle: { color: colour, borderColor: theme.surface, borderWidth: 2 },
      emphasis: { focus: 'series' },
      animation: false,
    });
    const option: ChartOption = {
      grid: { left: 44, right: 12, top: 30, bottom: 26 },
      legend: {
        top: 0,
        left: 0,
        icon: 'roundRect',
        itemWidth: 12,
        itemHeight: 4,
        textStyle: { color: theme.text, fontSize: 11 },
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: theme.axis } },
        backgroundColor: theme.surface,
        borderColor: theme.grid,
        textStyle: { color: theme.text, fontSize: 12 },
        valueFormatter: (value) => (typeof value === 'number' ? number.format(value) : '—'),
      },
      xAxis: {
        type: 'value',
        min: 'dataMin',
        max: 'dataMax',
        name: messages.chartTime,
        nameLocation: 'end',
        nameTextStyle: { color: theme.muted, fontSize: 10, align: 'right', verticalAlign: 'top', padding: [8, 0, 0, 0] },
        axisLine: { lineStyle: { color: theme.axis } },
        axisTick: { show: false },
        axisLabel: { color: theme.muted, fontSize: 10, formatter: (value: number) => minute.format(value) },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        min: 0,
        ...(this.#max === undefined ? {} : { max: this.#max }),
        axisLine: { show: false },
        axisLabel: { color: theme.muted, fontSize: 10, formatter: (value: number) => number.format(value) },
        splitLine: { lineStyle: { color: theme.grid, width: 1 } },
      },
      series: [
        { ...line(messages.seriesLastMinute, theme.series[0]), data: this.#lastInterval },
        { ...line(messages.seriesSinceStart, theme.series[1]), data: this.#sinceStart },
      ],
    };
    this.#chart.setOption(option, { notMerge: true });
  }

  resize(): void {
    this.#chart.resize();
  }
}

/** The three charts of the demo, in one element the panel shows. */
export class DemoCharts {
  readonly element = document.createElement('div');
  readonly #charts: ReadonlyMap<Measure, Chart>;
  readonly #titles: ReadonlyMap<Measure, keyof Messages>;
  readonly #dark = window.matchMedia('(prefers-color-scheme: dark)');
  #messages: Messages;

  constructor(messages: Messages) {
    this.#messages = messages;
    this.element.className = 'charts';
    this.#charts = new Map(MEASURES.map((chart) => [chart.measure, new Chart(chart)]));
    this.#titles = new Map(MEASURES.map(({ measure, title }) => [measure, title]));
    for (const chart of this.#charts.values()) this.element.append(chart.element);
    this.#dark.addEventListener('change', () => {
      this.#style();
    });
    new ResizeObserver(() => {
      for (const chart of this.#charts.values()) chart.resize();
    }).observe(this.element);
    this.#style();
  }

  /** Adds the points of new records and redraws. */
  add(points: readonly ChartPoints[]): void {
    if (points.length === 0) return;
    for (const point of points) {
      for (const [measure, chart] of this.#charts) chart.add(point[measure]);
    }
    for (const chart of this.#charts.values()) chart.redraw();
  }

  clear(): void {
    for (const chart of this.#charts.values()) chart.clear();
  }

  translate(messages: Messages): void {
    this.#messages = messages;
    this.#style();
  }

  #style(): void {
    const theme = this.#dark.matches ? DARK : LIGHT;
    for (const [measure, chart] of this.#charts) {
      const title = this.#titles.get(measure) ?? 'chartQueue';
      chart.style(this.#messages[title], this.#messages, theme);
    }
  }
}
