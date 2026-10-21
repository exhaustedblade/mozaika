import './style.css';

import { PACKAGE_NAME as KERNEL_PACKAGE_NAME } from '@mozaika/kernel';

import { detectLocale, type Locale, MESSAGES } from './i18n.js';
import { MotionCheck } from './motion-check.js';

const LANG_PARAM = 'lang';

function element(tag: string, text: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className !== undefined) {
    node.className = className;
  }
  return node;
}

function infoRow(label: string, value: string): HTMLElement {
  const row = document.createElement('div');
  row.append(element('dt', label), element('dd', value));
  return row;
}

/** The pages of the preview with a scene: a link to each and what it shows, in the page's language. */
function pageLinks(locale: Locale): HTMLElement {
  const t = MESSAGES[locale];
  const section = document.createElement('section');
  section.className = 'pages';
  section.append(element('h2', t.pagesTitle));
  const list = document.createElement('ul');
  const pages: [string, string, string][] = [
    ['demo.html', t.demoLink, t.demoLinkAbout],
    ['bench.html', t.benchLink, t.benchLinkAbout],
  ];
  for (const [href, title, about] of pages) {
    const link = document.createElement('a');
    link.href = `${href}?${LANG_PARAM}=${locale}`;
    link.textContent = title;
    const item = document.createElement('li');
    item.append(link, element('p', about));
    list.append(item);
  }
  section.append(list);
  return section;
}

function render(root: HTMLElement, locale: Locale, motion: MotionCheck): void {
  const t = MESSAGES[locale];
  const other: Locale = locale === 'ru' ? 'en' : 'ru';
  const commit = import.meta.env.VITE_COMMIT_SHA?.slice(0, 7) ?? t.localBuild;

  document.documentElement.lang = locale;
  document.title = t.title;

  const toggle = element('button', t.switchLanguage, 'lang-toggle');
  toggle.setAttribute('type', 'button');
  toggle.setAttribute('lang', other);
  toggle.addEventListener('click', () => {
    const url = new URL(window.location.href);
    url.searchParams.set(LANG_PARAM, other);
    window.history.replaceState(null, '', url);
    render(root, other, motion);
  });

  const info = document.createElement('dl');
  info.append(infoRow(t.kernel, KERNEL_PACKAGE_NAME), infoRow(t.build, commit));

  motion.translate(t);
  root.replaceChildren(
    toggle,
    element('h1', t.title),
    element('p', t.subtitle, 'subtitle'),
    element('p', t.status),
    info,
    pageLinks(locale),
    motion.element,
  );
}

const root = document.getElementById('app');
if (root !== null) {
  const requested = new URLSearchParams(window.location.search).get(LANG_PARAM);
  const languages = requested === null ? navigator.languages : [requested, ...navigator.languages];
  const locale = detectLocale(languages);
  render(root, locale, new MotionCheck(MESSAGES[locale]));
}
