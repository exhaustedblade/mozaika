/**
 * The side panel of the demo: what the model is, the legend of the states,
 * the parameters (sent to the kernel with `set`, or a new build for the
 * windows), the figures of the moment, the self-check of the model's laws
 * and the place of the charts. It shows what it is given and tells the page
 * what the viewer changes; it holds no model state.
 */
import type { Snapshot } from '@mozaika/kernel';

import type { Messages } from '../i18n.js';
import type { ServicePointParameters, ServicePointRecord } from '../models/service-point.js';
import { MAX_WINDOWS } from '../models/service-point-layout.js';
import { checkLaws, type LawName } from '../models/service-point-laws.js';
import { LEGEND } from './person-states.js';

/** A slider and what it changes: a parameter of the model, or the page's time scale. */
interface Slider {
  readonly key: keyof ServicePointParameters | 'minutesPerSecond';
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly digits: number;
}

const SLIDERS: readonly Slider[] = [
  { key: 'arrivalsPerMinute', min: 0.2, max: 6, step: 0.1, digits: 1 },
  { key: 'serviceMinutes', min: 0.5, max: 10, step: 0.1, digits: 1 },
  { key: 'windows', min: 1, max: MAX_WINDOWS, step: 1, digits: 0 },
  { key: 'minutesPerSecond', min: 0.05, max: 3, step: 0.05, digits: 2 },
];

const LAWS: readonly { readonly law: LawName; readonly text: keyof Messages }[] = [
  { law: 'balance', text: 'lawBalance' },
  { law: 'little', text: 'lawLittle' },
  { law: 'utilization', text: 'lawUtilization' },
];

/** What the viewer does on the panel, for the page to act on. */
export interface PanelEvents {
  /** A parameter the model reads while it runs. */
  readonly onParameter: (name: 'arrivalsPerMinute' | 'serviceMinutes', value: number) => void;
  /** The number of windows, which needs the model built anew. */
  readonly onWindows: (value: number) => void;
  readonly onTimeScale: (minutesPerSecond: number) => void;
  readonly onPause: (paused: boolean) => void;
  readonly onRestart: () => void;
  readonly onLanguage: () => void;
}

/** What the panel shows of the moment: counted from the latest snapshot. */
export interface Moment {
  /** Model time, minutes. */
  readonly time: number;
  readonly people: number;
  readonly inLine: number;
  readonly atWindows: number;
  /** Windows open in the model, by its latest record; undefined before the first. */
  readonly windows: number | undefined;
}

/**
 * The side panel: it shows what the page gives it (the moment, the latest
 * record) and reports what the viewer changes through PanelEvents.
 */
export class DemoPanel {
  readonly element = document.createElement('aside');
  /** Where the page puts the charts. */
  readonly charts = document.createElement('section');
  readonly #texts = new Map<HTMLElement, keyof Messages>();
  readonly #figures = new Map<string, HTMLElement>();
  readonly #inputs = new Map<Slider['key'], { input: HTMLInputElement; output: HTMLOutputElement }>();
  readonly #laws = new Map<LawName, { mark: HTMLElement; detail: HTMLElement }>();
  readonly #load = document.createElement('p');
  readonly #error = document.createElement('p');
  readonly #pause = document.createElement('button');
  readonly #language = document.createElement('button');
  readonly #events: PanelEvents;
  #messages: Messages;
  /** Number formats by digits after the point, made once per language. */
  #numbers = new Map<number, Intl.NumberFormat>();
  #paused = false;
  #parameters: ServicePointParameters;

  constructor(messages: Messages, parameters: ServicePointParameters, minutesPerSecond: number, events: PanelEvents) {
    this.#messages = messages;
    this.#parameters = { ...parameters };
    this.#events = events;
    this.element.className = 'demo-panel';
    this.#error.className = 'demo-error';
    this.#error.setAttribute('role', 'alert');
    this.element.append(
      this.#header(),
      this.#legend(),
      this.#controls(minutesPerSecond),
      this.#moment(),
      this.#lawList(),
      this.#chartsSection(),
      this.#error,
    );
    this.translate(messages);
  }

  /** Shows the texts in another language. */
  translate(messages: Messages): void {
    this.#messages = messages;
    this.#numbers = new Map();
    for (const [node, key] of this.#texts) node.textContent = messages[key];
    this.#pause.textContent = this.#paused ? messages.resume : messages.pause;
    this.#language.textContent = messages.switchLanguage;
    this.#showLoad();
  }

  showMoment(moment: Moment): void {
    const number = this.#number(0);
    const hours = Math.floor(moment.time / 60);
    const minutes = Math.floor(moment.time % 60);
    this.#show('time', `${String(hours)}:${String(minutes).padStart(2, '0')}`);
    this.#show('people', number.format(moment.people));
    this.#show('inLine', number.format(moment.inLine));
    const windows = moment.windows === undefined ? '—' : number.format(moment.windows);
    this.#show('windowsBusy', `${number.format(moment.atWindows)} / ${windows}`);
  }

  /** The laws on the latest record, and what it counts since the start. */
  showRecord(record: Snapshot<ServicePointRecord>): void {
    this.#show('served', this.#number(0).format(record.data.left));
    for (const check of checkLaws(record)) {
      // People are counted in whole numbers; areas and times in minutes.
      const number = this.#number(check.law === 'balance' ? 0 : 2);
      const shown = this.#laws.get(check.law);
      if (shown === undefined) continue;
      shown.mark.textContent = check.holds ? '✓' : '✗';
      shown.mark.className = check.holds ? 'law-mark holds' : 'law-mark broken';
      shown.mark.setAttribute('aria-label', check.holds ? this.#messages.lawHolds : this.#messages.lawBroken);
      shown.detail.textContent =
        check.law === 'utilization'
          ? `${number.format(check.actual)} ≤ 1`
          : `${number.format(check.actual)} = ${number.format(check.expected)}`;
    }
  }

  showError(text: string): void {
    this.#error.textContent = text;
  }

  #header(): HTMLElement {
    const header = document.createElement('header');
    const top = document.createElement('div');
    top.className = 'demo-top';
    const home = this.#text('a', 'backHome') as HTMLAnchorElement;
    home.href = './';
    this.#language.type = 'button';
    this.#language.className = 'lang-toggle';
    this.#language.addEventListener('click', () => {
      this.#events.onLanguage();
    });
    top.append(home, this.#language);
    header.append(top, this.#text('h1', 'demoTitle'), this.#text('p', 'demoAbout'));
    return header;
  }

  #legend(): HTMLElement {
    const section = this.#section('demoLegend');
    const list = document.createElement('ul');
    list.className = 'legend';
    for (const entry of LEGEND) {
      const item = document.createElement('li');
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = `#${entry.colour.toString(16).padStart(6, '0')}`;
      item.append(swatch, this.#text('span', entry.name));
      list.append(item);
    }
    section.append(list);
    return section;
  }

  #controls(minutesPerSecond: number): HTMLElement {
    const section = this.#section('demoParameters');
    const form = document.createElement('form');
    form.className = 'controls';
    form.addEventListener('submit', (event) => {
      event.preventDefault();
    });
    for (const slider of SLIDERS) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      Object.assign(input, { type: 'range', name: slider.key, min: String(slider.min), max: String(slider.max) });
      input.step = String(slider.step);
      input.value = String(slider.key === 'minutesPerSecond' ? minutesPerSecond : this.#parameters[slider.key]);
      const output = document.createElement('output');
      output.textContent = this.#number(slider.digits).format(Number(input.value));
      // Live while dragging for what the model reads as it runs; a new build only once the windows are let go.
      input.addEventListener('input', () => {
        output.textContent = this.#number(slider.digits).format(Number(input.value));
        if (slider.key !== 'windows') this.#change(slider.key, Number(input.value));
      });
      input.addEventListener('change', () => {
        if (slider.key === 'windows') this.#change(slider.key, Number(input.value));
      });
      this.#inputs.set(slider.key, { input, output });
      label.append(this.#text('span', slider.key), input, output);
      form.append(label);
    }
    const note = this.#text('p', 'windowsNote');
    note.className = 'note';
    this.#load.className = 'load';
    this.#pause.type = 'button';
    this.#pause.addEventListener('click', () => {
      this.#paused = !this.#paused;
      this.#pause.textContent = this.#paused ? this.#messages.resume : this.#messages.pause;
      this.#events.onPause(this.#paused);
    });
    const restart = this.#text('button', 'restart') as HTMLButtonElement;
    restart.type = 'button';
    restart.addEventListener('click', () => {
      this.#events.onRestart();
    });
    const buttons = document.createElement('div');
    buttons.className = 'buttons';
    buttons.append(this.#pause, restart);
    form.append(note, this.#load, buttons);
    section.append(form);
    return section;
  }

  #change(key: Slider['key'], value: number): void {
    if (key === 'minutesPerSecond') {
      this.#events.onTimeScale(value);
      return;
    }
    this.#parameters[key] = value;
    this.#showLoad();
    if (key === 'windows') this.#events.onWindows(value);
    else this.#events.onParameter(key, value);
  }

  /** ρ = λ·s / c, and a warning when the windows cannot keep up. */
  #showLoad(): void {
    const { arrivalsPerMinute, serviceMinutes, windows } = this.#parameters;
    const load = (arrivalsPerMinute * serviceMinutes) / windows;
    const text = `${this.#messages.load} = ${this.#number(2).format(load)}`;
    this.#load.textContent = load >= 1 ? `${text} — ${this.#messages.overload}` : text;
    this.#load.classList.toggle('overload', load >= 1);
  }

  #moment(): HTMLElement {
    const section = this.#section('demoFigures');
    const list = document.createElement('dl');
    list.className = 'figures';
    const rows: [string, keyof Messages][] = [
      ['time', 'modelTime'],
      ['people', 'peopleInHall'],
      ['inLine', 'inLine'],
      ['windowsBusy', 'windowsBusy'],
      ['served', 'servedTotal'],
    ];
    for (const [figure, label] of rows) {
      const row = document.createElement('div');
      const value = document.createElement('dd');
      value.textContent = '—';
      this.#figures.set(figure, value);
      row.append(this.#text('dt', label), value);
      list.append(row);
    }
    section.append(list);
    return section;
  }

  #lawList(): HTMLElement {
    const section = this.#section('demoLaws');
    const list = document.createElement('ul');
    list.className = 'laws';
    for (const { law, text } of LAWS) {
      const item = document.createElement('li');
      const mark = document.createElement('span');
      mark.className = 'law-mark';
      mark.textContent = '…';
      const detail = document.createElement('span');
      detail.className = 'law-detail';
      const body = document.createElement('div');
      body.append(this.#text('span', text), detail);
      item.append(mark, body);
      this.#laws.set(law, { mark, detail });
      list.append(item);
    }
    section.append(list);
    return section;
  }

  #chartsSection(): HTMLElement {
    const section = this.#section('demoCharts');
    section.append(this.charts);
    return section;
  }

  #section(title: keyof Messages): HTMLElement {
    const section = document.createElement('section');
    section.append(this.#text('h2', title));
    return section;
  }

  #text(tag: string, key: keyof Messages): HTMLElement {
    const node = document.createElement(tag);
    this.#texts.set(node, key);
    return node;
  }

  #show(figure: string, text: string): void {
    const node = this.#figures.get(figure);
    if (node !== undefined) node.textContent = text;
  }

  #number(digits: number): Intl.NumberFormat {
    let format = this.#numbers.get(digits);
    if (format === undefined) {
      format = new Intl.NumberFormat(this.#messages.numberLocale, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
      this.#numbers.set(digits, format);
    }
    return format;
  }
}
