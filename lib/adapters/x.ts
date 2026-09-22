import type {
  DebugKind,
  PlatformAdapter,
  RadarBadgeState,
  TriageCardActions,
  TriagePageRef,
  TriageRecommend,
  TriageResult,
} from '@/lib/types';
import { RADAR_PRIMARY_FLOOR } from '@/lib/radar';
import { TRIAGE_OFFLINE_HINT } from '@/lib/triage';

// All X-specific (and inherently brittle) DOM knowledge is confined here.

const PLACEHOLDER_ATTR = 'data-xff-placeholder';
const DEBUG_ATTR = 'data-xff-debug';
const DEBUG_SLOT_ATTR = 'data-xff-debug-slot';
const ER_ATTR = 'data-xff-er';
const ER_SLOT_ATTR = 'data-xff-er-slot';
const RADAR_ATTR = 'data-xff-radar';
const CARD_ATTR = 'data-xff-triage';

/** X-native accent colors so the badge reads as part of the action row. */
const DEBUG_COLORS: Record<DebugKind, string> = {
  pending: 'rgb(255, 212, 0)',
  kept: 'rgb(0, 186, 124)',
  hidden: 'rgb(249, 24, 128)',
  blocked: 'rgb(120, 86, 255)',
  skipped: 'rgb(113, 118, 123)',
};

/** Extension brand accents — shared with the popup's signal palette. */
const ER_SIGNAL = '#e85d04';
const ER_SIGNAL_INK = '#fff7f0';
const ER_STEEL = 'rgb(113, 118, 123)';
const ER_STEEL_SOFT = 'rgba(113, 118, 123, 0.14)';
const ER_STEEL_LINE = 'rgba(113, 118, 123, 0.35)';

let erStylesInjected = false;

/** Once-per-page keyframes + base ER chip chrome. */
function ensureErStyles() {
  if (erStylesInjected || document.getElementById('xff-er-styles')) {
    erStylesInjected = true;
    return;
  }
  const style = document.createElement('style');
  style.id = 'xff-er-styles';
  style.textContent = `
    @keyframes xff-er-in {
      from { opacity: 0; transform: translateY(3px) scale(0.96); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes xff-er-hot-glow {
      0%, 100% { box-shadow: 0 0 0 0 rgba(232, 93, 4, 0); }
      40%      { box-shadow: 0 0 0 3px rgba(232, 93, 4, 0.28); }
    }
    [data-xff-er] {
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 22px;
      max-width: 120px;
      margin: 0;
      padding: 0 8px 0 0;
      border: 1px solid ${ER_STEEL_LINE};
      border-radius: 3px;
      background: ${ER_STEEL_SOFT};
      color: ${ER_STEEL};
      cursor: help;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 12px;
      font-weight: 600;
      line-height: 1;
      letter-spacing: 0.01em;
      white-space: nowrap;
      overflow: hidden;
      vertical-align: middle;
      animation: xff-er-in 220ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    [data-xff-er]::before {
      content: "";
      align-self: stretch;
      width: 3px;
      flex: none;
      background: ${ER_STEEL};
      opacity: 0.55;
    }
    [data-xff-er][data-xff-er-high="true"] {
      border-color: transparent;
      background: ${ER_SIGNAL};
      color: ${ER_SIGNAL_INK};
      animation:
        xff-er-in 220ms cubic-bezier(0.22, 1, 0.36, 1) both,
        xff-er-hot-glow 1.1s ease-out 180ms 1;
    }
    [data-xff-er][data-xff-er-high="true"]::before {
      background: ${ER_SIGNAL_INK};
      opacity: 0.85;
    }
    [data-xff-er] [data-xff-er-kicker] {
      font-family: "Arial Narrow", "Helvetica Neue", ui-sans-serif, system-ui, sans-serif;
      font-size: 9px;
      font-weight: 800;
      font-stretch: condensed;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      opacity: 0.78;
      padding-left: 7px;
    }
    [data-xff-er][data-xff-er-high="true"] [data-xff-er-kicker] {
      opacity: 1;
    }
    [data-xff-er] [data-xff-er-value] {
      font-variant-numeric: tabular-nums;
      font-weight: 700;
      font-size: 12px;
      letter-spacing: -0.02em;
      padding-right: 2px;
    }
    @media (prefers-reduced-motion: reduce) {
      [data-xff-er],
      [data-xff-er][data-xff-er-high="true"] {
        animation: none;
      }
    }
  `;
  document.documentElement.appendChild(style);
  erStylesInjected = true;
}

/** Build / refresh the ER chip's inner label structure. */
function paintErBadge(badge: HTMLElement, ratePct: number, high: boolean, detail: string) {
  ensureErStyles();

  const rounded =
    ratePct >= 10 ? ratePct.toFixed(0) : ratePct >= 1 ? ratePct.toFixed(1) : ratePct.toFixed(2);

  badge.dataset.xffTip = detail;
  badge.dataset.xffErHigh = high ? 'true' : 'false';
  badge.setAttribute('aria-label', high ? `Hot engagement ${rounded}%` : `Engagement rate ${rounded}%`);
  badge.replaceChildren();

  const kicker = document.createElement('span');
  kicker.setAttribute('data-xff-er-kicker', 'true');
  kicker.textContent = high ? 'Hot' : 'ER';

  const value = document.createElement('span');
  value.setAttribute('data-xff-er-value', 'true');
  value.textContent = `${rounded}%`;

  badge.append(kicker, value);
}

/**
 * The reply/repost/like row for this article. Skips buttons that live inside a
 * quoted/nested tweet so we don't hang the badge on the wrong group.
 */
function findActionBar(article: HTMLElement): HTMLElement | null {
  for (const reply of article.querySelectorAll('[data-testid="reply"]')) {
    const nested = reply.closest('article[data-testid="tweet"], [data-testid="quoteTweet"]');
    if (nested && nested !== article) continue;
    const group = reply.closest<HTMLElement>('[role="group"]');
    if (group && article.contains(group)) return group;
  }
  return null;
}

/** Style the badge for an action-bar slot (or the collapsed placeholder). */
function styleBadge(badge: HTMLElement, kind: DebugKind) {
  const color = DEBUG_COLORS[kind];
  badge.style.cssText =
    'box-sizing:border-box;display:inline-flex;align-items:center;' +
    'max-width:168px;height:20px;padding:0 4px;margin:0;border:none;' +
    'border-radius:4px;background:transparent;cursor:help;font-family:inherit;' +
    'font-size:13px;font-weight:700;line-height:16px;white-space:nowrap;' +
    `overflow:hidden;text-overflow:ellipsis;color:${color};`;
}

/** Flex-none wrapper so X's equal-width action slots don't stretch the badge. */
function mountInActionBar(
  actionBar: HTMLElement,
  badge: HTMLElement,
  slotAttr: string = DEBUG_SLOT_ATTR,
) {
  let slot = actionBar.querySelector<HTMLElement>(`:scope > [${slotAttr}]`);
  if (!slot) {
    slot = document.createElement('div');
    slot.setAttribute(slotAttr, 'true');
    slot.style.cssText =
      'display:flex;align-items:center;justify-content:flex-end;' +
      'flex:0 0 auto;min-width:0;align-self:center;padding:0 4px;';
    actionBar.appendChild(slot);
  }
  slot.appendChild(badge);
}

/** Parse abbreviated counts like "1.2K", "3.4M", or "1,234". */
function parseCount(raw: string): number {
  const s = raw.replace(/,/g, '').trim().toUpperCase();
  if (!s) return 0;
  const m = s.match(/^([\d.]+)\s*([KMB])?$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return 0;
  const mult = m[2] === 'K' ? 1e3 : m[2] === 'M' ? 1e6 : m[2] === 'B' ? 1e9 : 1;
  return Math.round(n * mult);
}

/**
 * Pull a numeric count from an action button. Prefers aria-label ("123 Likes",
 * "1.2K views") then falls back to visible text inside the control.
 */
function countFromControl(el: Element | null): number {
  if (!el) return 0;
  // Prefer the element's own aria-label; some counts live on a child/parent.
  const labels = [
    el.getAttribute('aria-label'),
    ...Array.from(el.querySelectorAll('[aria-label]')).map((n) => n.getAttribute('aria-label')),
    el.parentElement?.getAttribute('aria-label'),
  ].filter((s): s is string => !!s);

  for (const aria of labels) {
    // "7656 Likes. Like", "14.5K views. View post analytics", "1204 reposts. Repost"
    const m =
      aria.match(/([\d.,]+)\s*([KMB])?\s*(?:views?|likes?|replies|reposts?|retweets?)/i) ??
      aria.match(/([\d.,]+)\s*([KMB])?/i);
    if (m) {
      const n = parseCount(`${m[1]}${m[2] ?? ''}`);
      if (n > 0 || /^0\b/.test(m[1])) return n;
    }
  }
  // Visible count spans often sit next to the icon.
  for (const span of el.querySelectorAll('span')) {
    const t = (span.textContent ?? '').trim();
    if (/^[\d.,]+\s*[KMB]?$/i.test(t)) return parseCount(t);
  }
  return 0;
}

/** True when a control lives inside a quoted/nested tweet, not this article. */
function isNestedControl(article: HTMLElement, el: Element): boolean {
  const nested = el.closest('article[data-testid="tweet"], [data-testid="quoteTweet"]');
  return !!(nested && nested !== article);
}

// --- Fast custom tooltip -----------------------------------------------------
// The native `title` attribute takes ~1.5s to appear and can't be styled. This
// is a single shared, instantly-shown tooltip reused by every debug badge.
let tipEl: HTMLElement | null = null;

function ensureTip(): HTMLElement {
  if (tipEl) return tipEl;
  const el = document.createElement('div');
  el.setAttribute('data-xff-tip', 'true');
  el.style.cssText =
    'position:fixed;z-index:2147483647;pointer-events:none;max-width:300px;' +
    'padding:8px 10px;border-radius:8px;background:rgb(21,24,28);color:rgb(231,233,234);' +
    'font-family:system-ui,-apple-system,sans-serif;font-size:12px;line-height:1.45;' +
    'white-space:normal;box-shadow:0 4px 20px rgba(0,0,0,0.55);' +
    'border:1px solid rgb(47,51,54);opacity:0;transition:opacity 80ms ease;';
  document.body.appendChild(el);
  tipEl = el;
  return el;
}

function showTip(badge: HTMLElement, text: string) {
  if (!text) return;
  const el = ensureTip();
  // ER tips use " · " separators — render as a stacked readout.
  if (badge.hasAttribute(ER_ATTR) && text.includes(' · ')) {
    el.replaceChildren();
    const standout = badge.dataset.xffErStandout || '';
    const lines = text.split(' → ');
    const counts = (lines[0] ?? '').split(' · ');
    const grid = document.createElement('div');
    grid.style.cssText =
      'display:grid;grid-template-columns:auto auto;gap:2px 10px;font-variant-numeric:tabular-nums;';
    for (const part of counts) {
      const m = part.trim().match(/^(\S+)\s+(.+)$/);
      if (!m) continue;
      // The disproportionately-high metric (e.g. a ratio'd reply count) is
      // painted in the signal accent so it reads at a glance.
      const hot = standout !== '' && m[2] === standout;
      const n = document.createElement('span');
      n.textContent = hot ? `${m[1]} ▲` : m[1];
      n.style.fontWeight = hot ? '800' : '700';
      n.style.color = hot ? ER_SIGNAL : 'rgb(231,233,234)';
      const l = document.createElement('span');
      l.textContent = m[2];
      l.style.color = hot ? ER_SIGNAL : 'rgb(113,118,123)';
      l.style.fontWeight = hot ? '700' : '400';
      grid.append(n, l);
    }
    el.appendChild(grid);
    if (lines[1]) {
      const rate = document.createElement('div');
      rate.textContent = lines[1].trim();
      rate.style.cssText =
        'margin-top:8px;padding-top:8px;border-top:1px solid rgb(47,51,54);' +
        'font-weight:700;font-variant-numeric:tabular-nums;color:rgb(232,93,4);';
      el.appendChild(rate);
    }
  } else {
    el.textContent = text;
  }
  el.style.opacity = '1';
  const b = badge.getBoundingClientRect();
  const left = Math.max(
    8,
    Math.min(b.right - el.offsetWidth, window.innerWidth - el.offsetWidth - 8),
  );
  el.style.left = `${left}px`;
  // Prefer below; flip above when the action bar sits near the viewport bottom.
  const below = b.bottom + 6;
  const tipH = el.offsetHeight || 40;
  el.style.top =
    below + tipH > window.innerHeight - 8
      ? `${Math.max(8, b.top - tipH - 6)}px`
      : `${below}px`;
}

function hideTip() {
  if (tipEl) tipEl.style.opacity = '0';
}

function extractId(node: HTMLElement): string {
  // The tweet's canonical permalink is the status link wrapping its timestamp.
  // Prefer it over the first `/status/` anchor, which may point at an embedded
  // quote tweet or reply link and can reorder between renders — an unstable id
  // would defeat the verdict cache and cause the post to be reclassified.
  const timeAnchor = node.querySelector('a[href*="/status/"] time')?.parentElement;
  const href =
    timeAnchor?.getAttribute('href') ??
    node.querySelector('a[href*="/status/"]')?.getAttribute('href') ??
    '';
  const m = href.match(/status\/(\d+)/);
  return m ? m[1] : '';
}

const CELL_SELECTOR = '[data-testid="cellInnerDiv"]';

/** The timeline cell wrapping a post node (or the node itself if none). */
function cellOf(node: HTMLElement): HTMLElement {
  return (node.closest<HTMLElement>(CELL_SELECTOR)) ?? node;
}

/** Lowercased @handle of the post in a node, or '' if none found. */
function handleOf(node: HTMLElement): string {
  const userName = node.querySelector('[data-testid="User-Name"]');
  const m = userName?.textContent?.match(/@(\w{1,15})/);
  return m ? m[1].toLowerCase() : '';
}

const articleIn = (cell: HTMLElement): HTMLElement | null =>
  cell.querySelector<HTMLElement>('article[data-testid="tweet"]');

// --- Ingest radar ------------------------------------------------------------
// Two pieces of chrome: a small badge pinned to a candidate post's top-right
// corner (left of X's caret menu), and the triage card that opens under the
// post once the local service has judged it. Neither ever hides anything — the
// radar only ever adds.

const RADAR_INK = '#fff7f0';
const RADAR_GREEN = 'rgb(0, 186, 124)';
const RADAR_AMBER = 'rgb(224, 138, 0)';
const RADAR_STEEL = 'rgb(113, 118, 123)';
const RADAR_RED = 'rgb(249, 24, 128)';

/** Card accent per recommendation — also the badge color once triaged. */
const RECOMMEND_COLORS: Record<TriageRecommend, string> = {
  ingest: RADAR_GREEN,
  review: RADAR_AMBER,
  skip: RADAR_STEEL,
};

const RECOMMEND_LABELS: Record<TriageRecommend, string> = {
  ingest: '建议入库',
  review: '建议复核',
  skip: '建议跳过',
};

let radarStylesInjected = false;

function ensureRadarStyles() {
  if (radarStylesInjected || document.getElementById('xff-radar-styles')) {
    radarStylesInjected = true;
    return;
  }
  const style = document.createElement('style');
  style.id = 'xff-radar-styles';
  style.textContent = `
    @keyframes xff-radar-in {
      from { opacity: 0; transform: translateY(-3px) scale(0.94); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes xff-radar-pulse {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0.55; }
    }
    @keyframes xff-card-in {
      from { opacity: 0; transform: translateY(-4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    [${RADAR_ATTR}] {
      position: absolute;
      top: 6px;
      right: 52px;
      z-index: 3;
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 22px;
      max-width: 200px;
      padding: 0 9px;
      border: none;
      border-radius: 999px;
      background: ${ER_SIGNAL};
      color: ${RADAR_INK};
      cursor: pointer;
      font-family: inherit;
      font-size: 12px;
      font-weight: 700;
      line-height: 1;
      letter-spacing: 0.01em;
      white-space: nowrap;
      overflow: hidden;
      animation: xff-radar-in 200ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    [${RADAR_ATTR}]:hover { filter: brightness(1.08); }
    [${RADAR_ATTR}][data-xff-radar-kind="busy"] {
      background: ${RADAR_STEEL};
      cursor: progress;
      animation: xff-radar-pulse 1.1s ease-in-out infinite;
    }
    [${RADAR_ATTR}][data-xff-radar-kind="failed"] { background: ${RADAR_RED}; }
    [${RADAR_ATTR}] [data-xff-radar-note] {
      font-weight: 600;
      opacity: 0.82;
      font-size: 11px;
    }
    [${CARD_ATTR}] {
      box-sizing: border-box;
      margin: 0 16px 12px;
      padding: 12px 14px;
      border: 1px solid rgba(113, 118, 123, 0.35);
      border-left: 3px solid ${RADAR_STEEL};
      border-radius: 8px;
      background: rgba(113, 118, 123, 0.08);
      color: inherit;
      font-family: inherit;
      font-size: 13px;
      line-height: 1.5;
      animation: xff-card-in 180ms cubic-bezier(0.22, 1, 0.36, 1) both;
    }
    [${CARD_ATTR}] [data-xff-card-head] {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 6px;
    }
    [${CARD_ATTR}] [data-xff-card-rec] {
      padding: 2px 8px;
      border-radius: 4px;
      color: ${RADAR_INK};
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.02em;
    }
    [${CARD_ATTR}] [data-xff-card-meta] {
      color: ${RADAR_STEEL};
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    [${CARD_ATTR}] [data-xff-card-summary] {
      margin: 0 0 8px;
      font-size: 14px;
      line-height: 1.5;
    }
    [${CARD_ATTR}] [data-xff-card-rows] {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 3px 10px;
      margin-bottom: 10px;
      font-size: 12.5px;
    }
    [${CARD_ATTR}] [data-xff-card-key] {
      color: ${RADAR_STEEL};
      font-weight: 700;
      white-space: nowrap;
    }
    [${CARD_ATTR}] [data-xff-card-val] { min-width: 0; }
    [${CARD_ATTR}] [data-xff-card-val][data-xff-card-warn] {
      color: ${RADAR_RED};
      font-weight: 700;
    }
    [${CARD_ATTR}] [data-xff-card-path] {
      color: ${RADAR_STEEL};
      font-size: 11.5px;
    }
    [${CARD_ATTR}] [data-xff-card-foot] {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    [${CARD_ATTR}] button {
      flex: none;
      padding: 5px 12px;
      border: 1px solid transparent;
      border-radius: 999px;
      cursor: pointer;
      font-family: inherit;
      font-size: 13px;
      font-weight: 700;
      line-height: 16px;
    }
    [${CARD_ATTR}] [data-xff-card-ingest] {
      background: ${ER_SIGNAL};
      color: ${RADAR_INK};
    }
    [${CARD_ATTR}] [data-xff-card-ingest]:disabled {
      background: rgba(113, 118, 123, 0.3);
      color: ${RADAR_STEEL};
      cursor: default;
    }
    [${CARD_ATTR}] [data-xff-card-close] {
      background: none;
      border-color: rgba(113, 118, 123, 0.45);
      color: ${RADAR_STEEL};
    }
    [${CARD_ATTR}] [data-xff-card-error] {
      color: ${RADAR_RED};
      font-weight: 600;
    }
    @media (prefers-reduced-motion: reduce) {
      [${RADAR_ATTR}], [${CARD_ATTR}] { animation: none; }
      [${RADAR_ATTR}][data-xff-radar-kind="busy"] { animation: none; }
    }
  `;
  document.documentElement.appendChild(style);
  radarStylesInjected = true;
}

/** Click handler per badge, so re-painting never stacks listeners. */
const radarHandlers = new WeakMap<HTMLElement, () => void>();

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Badge text and color for each state. */
function radarFace(state: RadarBadgeState): { text: string; note: string; color: string } {
  if (state.kind === 'busy') return { text: '⏳ 判定中…', note: '', color: RADAR_STEEL };
  if (state.kind === 'failed') return { text: '⚠ 判定失败 · 重试', note: '', color: RADAR_RED };
  if (state.kind === 'done') {
    return {
      text: `📥 ${RECOMMEND_LABELS[state.recommend]}`,
      note: '',
      color: RECOMMEND_COLORS[state.recommend],
    };
  }
  return {
    text: `📥 候选 · ${pct(state.signals.substantive)}`,
    note: state.signals.primary >= RADAR_PRIMARY_FLOOR ? '一手' : '',
    color: ER_SIGNAL,
  };
}

/** One "页名 92% · path" row value, with the path dimmed. */
function pageRefLine(ref: TriagePageRef): HTMLElement {
  const span = document.createElement('span');
  span.textContent = `${ref.page} ${pct(ref.prob)}`;
  if (ref.path) {
    const path = document.createElement('span');
    path.setAttribute('data-xff-card-path', 'true');
    path.textContent = ` · ${ref.path}`;
    span.appendChild(path);
  }
  return span;
}

function cardRow(rows: HTMLElement, key: string, value: Node, warn = false) {
  const k = document.createElement('span');
  k.setAttribute('data-xff-card-key', 'true');
  k.textContent = key;
  const v = document.createElement('span');
  v.setAttribute('data-xff-card-val', 'true');
  if (warn) v.setAttribute('data-xff-card-warn', 'true');
  v.appendChild(value);
  rows.append(k, v);
}

/**
 * Stack several refs in one value cell, one per line. A separator string won't
 * do: HTML collapses runs of spaces, so "页 A 92% 页 B 74%" would read as one
 * sentence — and each ref may already carry its own " · path" tail.
 */
function stackNodes(nodes: HTMLElement[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const node of nodes) {
    node.style.display = 'block';
    frag.appendChild(node);
  }
  return frag;
}

function textNode(text: string): Text {
  return document.createTextNode(text);
}

/** The card body for a service that answered. */
function buildVerdictCard(card: HTMLElement, result: Extract<TriageResult, { ok: true }>) {
  const { verdict } = result;
  const accent = RECOMMEND_COLORS[verdict.recommend];
  card.style.borderLeftColor = accent;

  const head = document.createElement('div');
  head.setAttribute('data-xff-card-head', 'true');

  const rec = document.createElement('span');
  rec.setAttribute('data-xff-card-rec', 'true');
  rec.style.background = accent;
  rec.textContent = RECOMMEND_LABELS[verdict.recommend];

  const value = document.createElement('span');
  value.setAttribute('data-xff-card-meta', 'true');
  const valueBits = [
    `价值 L${verdict.value.level}`,
    verdict.value.label,
    `评分 ${verdict.value.score}`,
    `置信 ${pct(verdict.value.confidence)}`,
  ].filter(Boolean);
  value.textContent = valueBits.join(' · ');

  head.append(rec, value);
  card.appendChild(head);

  if (verdict.summary_zh) {
    const summary = document.createElement('p');
    summary.setAttribute('data-xff-card-summary', 'true');
    summary.textContent = verdict.summary_zh;
    card.appendChild(summary);
  }

  const rows = document.createElement('div');
  rows.setAttribute('data-xff-card-rows', 'true');

  if (verdict.redundant_with.length > 0) {
    cardRow(rows, '冗余页', stackNodes(verdict.redundant_with.map(pageRefLine)));
  }
  if (verdict.contradicts.length > 0) {
    cardRow(rows, '⚠ 矛盾页', stackNodes(verdict.contradicts.map(pageRefLine)), true);
  }
  if (verdict.links.length > 0) {
    const links = verdict.links.map((l) => {
      const span = document.createElement('span');
      span.textContent = `${l.page} ${pct(l.prob)}${l.relation ? `（${l.relation}）` : ''}`;
      return span;
    });
    cardRow(rows, '建议关联', stackNodes(links));
  }
  if (verdict.tags.length > 0) {
    cardRow(rows, '建议标签', textNode(verdict.tags.map((t) => `#${t}`).join(' ')));
  }
  if (verdict.section) cardRow(rows, '归入章节', textNode(verdict.section));
  cardRow(rows, '一手来源', textNode(pct(verdict.primary_source)));
  if (rows.childElementCount > 0) card.appendChild(rows);

  const foot = document.createElement('div');
  foot.setAttribute('data-xff-card-foot', 'true');

  const ingest = document.createElement('button');
  ingest.setAttribute('data-xff-card-ingest', 'true');
  ingest.type = 'button';
  ingest.textContent = '入库队列';

  const close = document.createElement('button');
  close.setAttribute('data-xff-card-close', 'true');
  close.type = 'button';
  close.textContent = '收起';

  const meta = document.createElement('span');
  meta.setAttribute('data-xff-card-meta', 'true');
  const usd = verdict.usage?.usd ?? 0;
  meta.textContent =
    `比对 ${verdict.candidates_considered} 页` +
    (verdict.usage?.input_tokens ? ` · ${verdict.usage.input_tokens} tok` : '') +
    (usd ? ` · $${usd.toFixed(5)}` : '');

  foot.append(ingest, close, meta);
  card.appendChild(foot);
  return { ingest, close };
}

/** The card body for a service that never answered. */
function buildErrorCard(card: HTMLElement, result: Extract<TriageResult, { ok: false }>) {
  card.style.borderLeftColor = RADAR_RED;

  const msg = document.createElement('p');
  msg.setAttribute('data-xff-card-summary', 'true');
  msg.setAttribute('data-xff-card-error', 'true');
  msg.textContent = result.offline ? TRIAGE_OFFLINE_HINT : `判定失败：${result.error}`;
  card.appendChild(msg);

  if (result.offline && result.error) {
    const detail = document.createElement('div');
    detail.setAttribute('data-xff-card-meta', 'true');
    detail.style.marginBottom = '10px';
    detail.textContent = result.error;
    card.appendChild(detail);
  }

  const foot = document.createElement('div');
  foot.setAttribute('data-xff-card-foot', 'true');
  const close = document.createElement('button');
  close.setAttribute('data-xff-card-close', 'true');
  close.type = 'button';
  close.textContent = '收起';
  foot.appendChild(close);
  card.appendChild(foot);
  return { close };
}

export const xAdapter: PlatformAdapter = {
  name: 'x',

  findPosts(root) {
    return Array.from(root.querySelectorAll<HTMLElement>('article[data-testid="tweet"]'));
  },

  findThread(node) {
    // X renders a self-thread as consecutive timeline cells authored by the
    // same account. Walk siblings both ways collecting that same-author run.
    const cell = cellOf(node);
    const author = handleOf(node);
    if (!author || !cell.matches(CELL_SELECTOR)) return [node];

    // On the author's own profile every cell is same-author, so the sibling
    // walk below would swallow the whole page as one "thread". Skip it there.
    const pageHandle = location.pathname.split('/')[1]?.toLowerCase() ?? '';
    if (pageHandle === author) return [node];

    const cells: HTMLElement[] = [cell];
    const sameAuthorArticle = (sib: Element | null): HTMLElement | null => {
      if (!(sib instanceof HTMLElement) || !sib.matches(CELL_SELECTOR)) return null;
      const art = articleIn(sib);
      return art && handleOf(art) === author ? art : null;
    };

    for (let p = cell.previousElementSibling; sameAuthorArticle(p); p = p!.previousElementSibling) {
      cells.unshift(p as HTMLElement);
    }
    for (let n = cell.nextElementSibling; sameAuthorArticle(n); n = n!.nextElementSibling) {
      cells.push(n as HTMLElement);
    }

    return cells.map(articleIn).filter((a): a is HTMLElement => a !== null);
  },

  extractPost(node) {
    const textNodes = node.querySelectorAll('[data-testid="tweetText"]');
    const text = Array.from(textNodes)
      .map((n) => n.textContent ?? '')
      .join('\n')
      .trim();

    const userName = node.querySelector('[data-testid="User-Name"]');
    const handleMatch = userName?.textContent?.match(/@(\w{1,15})/);
    const author = handleMatch ? handleMatch[1] : '';

    if (!text && !author) return null;
    return { id: extractId(node) || `${author}:${text.slice(0, 24)}`, author, text };
  },

  extractMetrics(node) {
    const pick = (...sels: string[]): Element | null => {
      for (const sel of sels) {
        for (const el of node.querySelectorAll(sel)) {
          if (!isNestedControl(node, el)) return el;
        }
      }
      return null;
    };

    // Liked/reposted posts flip testid to unlike/unretweet.
    const replies = countFromControl(pick('[data-testid="reply"]'));
    const reposts = countFromControl(pick('[data-testid="retweet"]', '[data-testid="unretweet"]'));
    const likes = countFromControl(pick('[data-testid="like"]', '[data-testid="unlike"]'));

    // Views live on the analytics link (or a sibling control labeled "views").
    let views = 0;
    const viewCandidates: Element[] = [];
    for (const a of node.querySelectorAll('a[href*="/analytics"]')) {
      if (!isNestedControl(node, a)) viewCandidates.push(a);
    }
    for (const el of node.querySelectorAll('[aria-label]')) {
      if (isNestedControl(node, el)) continue;
      const label = el.getAttribute('aria-label') ?? '';
      if (/\bviews?\b/i.test(label) && !/\b(like|reply|repost|retweet|bookmark)\b/i.test(label)) {
        viewCandidates.push(el);
      }
    }
    for (const el of viewCandidates) {
      views = countFromControl(el);
      if (views > 0) break;
    }
    // Last resort: abbreviated count text next to the analytics link.
    if (views === 0) {
      for (const a of viewCandidates) {
        for (const span of a.querySelectorAll('span')) {
          const t = (span.textContent ?? '').trim();
          if (/^[\d.,]+\s*[KMB]?$/i.test(t)) {
            views = parseCount(t);
            if (views > 0) break;
          }
        }
        if (views > 0) break;
      }
    }
    // Action-bar fallback: the views control is usually the only remaining
    // numbered slot that isn't reply/repost/like/bookmark.
    if (views === 0) {
      const bar = findActionBar(node);
      if (bar) {
        for (const child of Array.from(bar.children)) {
          if (
            child.querySelector(
              '[data-testid="reply"],[data-testid="retweet"],[data-testid="unretweet"],' +
                '[data-testid="like"],[data-testid="unlike"],[data-testid="bookmark"],' +
                '[data-testid="removeBookmark"],[data-xff-debug],[data-xff-er],' +
                `[${DEBUG_SLOT_ATTR}],[${ER_SLOT_ATTR}]`,
            )
          ) {
            continue;
          }
          const n = countFromControl(child);
          if (n > 0) {
            views = n;
            break;
          }
          for (const span of child.querySelectorAll('span')) {
            const t = (span.textContent ?? '').trim();
            if (/^[\d.,]+\s*[KMB]?$/i.test(t)) {
              views = parseCount(t);
              if (views > 0) break;
            }
          }
          if (views > 0) break;
        }
      }
    }

    return { replies, reposts, likes, views };
  },

  collapse(node, reason, title = '可能的垃圾信息 · 已折叠') {
    if (node.dataset.xffCollapsed === 'true' || node.dataset.xffRevealed === 'true') return;
    node.dataset.xffCollapsed = 'true';

    // Detach the debug badge before hiding children so we can remount it on
    // the placeholder (it usually lives inside the action bar).
    const badge = node.querySelector<HTMLElement>(`[${DEBUG_ATTR}]`);
    badge?.remove();

    for (const child of Array.from(node.children)) {
      (child as HTMLElement).style.display = 'none';
    }

    const ph = document.createElement('div');
    ph.setAttribute(PLACEHOLDER_ATTR, 'true');
    // Flat, full-width row that reads as part of the timeline rather than a
    // floating card: inherits X's font, no border/radius, muted color.
    ph.style.cssText =
      'box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;' +
      'gap:12px;width:100%;padding:12px 16px;' +
      'font-family:inherit;font-size:15px;line-height:20px;color:rgb(113,118,123);';

    // Two stacked lines: the headline says what happened, the badge line names
    // the rule that matched. Both inherit the muted placeholder color so the
    // row reads the same in X's light and dark themes.
    const label = document.createElement('div');
    label.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;';

    const head = document.createElement('span');
    head.textContent = title;
    head.style.cssText =
      'font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

    const why = document.createElement('span');
    why.textContent = `已折叠: ${reason}`;
    why.style.cssText =
      'font-size:13px;line-height:16px;opacity:0.85;' +
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

    label.append(head, why);

    const trailing = document.createElement('div');
    trailing.style.cssText = 'display:flex;align-items:center;gap:8px;flex:none;';

    const btn = document.createElement('button');
    btn.textContent = '显示这条';
    // Subtle inline text link, matching X's accent, not a filled pill.
    btn.style.cssText =
      'flex:none;cursor:pointer;border:none;background:none;padding:0;' +
      'color:rgb(29,155,240);font-size:15px;font-weight:600;line-height:20px;';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      xAdapter.restore(node);
    });

    trailing.append(btn);
    ph.append(label, trailing);
    node.appendChild(ph);

    // Remount an existing badge next to Show (annotate may also place a fresh one).
    if (badge) {
      styleBadge(badge, (badge.dataset.xffKind as DebugKind) || 'hidden');
      trailing.insertBefore(badge, btn);
    }
  },

  restore(node) {
    const badge = node.querySelector<HTMLElement>(`[${DEBUG_ATTR}]`);
    badge?.remove();
    const erBadge = node.querySelector<HTMLElement>(`[${ER_ATTR}]`);
    erBadge?.remove();

    node.querySelectorAll(`:scope > [${PLACEHOLDER_ATTR}]`).forEach((el) => el.remove());
    for (const child of Array.from(node.children)) {
      (child as HTMLElement).style.display = '';
    }
    delete node.dataset.xffCollapsed;
    node.dataset.xffRevealed = 'true';

    // Put the badge back on the action bar once the post is visible again.
    const bar = findActionBar(node);
    if (badge) {
      const kind = (badge.dataset.xffKind as DebugKind) || 'kept';
      styleBadge(badge, kind);
      if (bar) mountInActionBar(bar, badge);
      else node.appendChild(badge);
    }
    if (erBadge) {
      if (bar) mountInActionBar(bar, erBadge, ER_SLOT_ATTR);
      else node.appendChild(erBadge);
    }
  },

  annotate(node, label, kind, detail, confidence) {
    let badge = node.querySelector<HTMLElement>(`[${DEBUG_ATTR}]`);
    if (!badge) {
      badge = document.createElement('div');
      badge.setAttribute(DEBUG_ATTR, 'true');
      badge.setAttribute('role', 'status');
      badge.setAttribute('aria-label', 'Filter outcome');
      badge.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      badge.addEventListener('mouseenter', () => showTip(badge!, badge!.dataset.xffTip || ''));
      badge.addEventListener('mouseleave', hideTip);
    }

    badge.dataset.xffKind = kind;
    badge.dataset.xffTip = detail || label;
    badge.replaceChildren();

    const text = document.createElement('span');
    text.textContent = label;
    badge.appendChild(text);

    if (confidence != null && confidence > 0) {
      const conf = document.createElement('span');
      conf.textContent = `${Math.round(confidence)}%`;
      conf.style.cssText = 'margin-left:5px;font-weight:500;opacity:0.72;';
      badge.appendChild(conf);
    }

    styleBadge(badge, kind);

    const collapsed = node.dataset.xffCollapsed === 'true';
    const placeholder = node.querySelector<HTMLElement>(`:scope > [${PLACEHOLDER_ATTR}]`);
    const actionBar = findActionBar(node);

    if (collapsed && placeholder) {
      // Sit beside the Show control on the placeholder row.
      const trailing = placeholder.lastElementChild;
      if (trailing instanceof HTMLElement) {
        trailing.insertBefore(badge, trailing.firstChild);
      } else {
        placeholder.appendChild(badge);
      }
    } else if (actionBar) {
      mountInActionBar(actionBar, badge);
    } else {
      // Tweet chrome not ready yet — keep a discreet inline fallback.
      badge.style.position = 'absolute';
      badge.style.bottom = '8px';
      badge.style.right = '12px';
      badge.style.zIndex = '2';
      if (getComputedStyle(node).position === 'static') node.style.position = 'relative';
      node.appendChild(badge);
    }
  },

  clearAnnotations(root) {
    root.querySelectorAll(`[${DEBUG_ATTR}]`).forEach((el) => el.remove());
    root.querySelectorAll(`[${DEBUG_SLOT_ATTR}]`).forEach((el) => el.remove());
    hideTip();
  },

  annotateEngagement(node, ratePct, high, detail, standout) {
    let badge = node.querySelector<HTMLElement>(`[${ER_ATTR}]`);
    const isNew = !badge;
    if (!badge) {
      badge = document.createElement('div');
      badge.setAttribute(ER_ATTR, 'true');
      badge.setAttribute('role', 'status');
      badge.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      badge.addEventListener('mouseenter', () => showTip(badge!, badge!.dataset.xffTip || ''));
      badge.addEventListener('mouseleave', hideTip);
    }

    badge.dataset.xffErStandout = standout ?? '';
    paintErBadge(badge, ratePct, high, detail);
    // Re-trigger enter animation only when the chip is first mounted or flips Hot.
    if (!isNew && high && badge.dataset.xffErAnimated !== 'hot') {
      badge.style.animation = 'none';
      // Force reflow so the hot glow can replay.
      void badge.offsetWidth;
      badge.style.animation = '';
    }
    if (high) badge.dataset.xffErAnimated = 'hot';
    else delete badge.dataset.xffErAnimated;

    const collapsed = node.dataset.xffCollapsed === 'true';
    const placeholder = node.querySelector<HTMLElement>(`:scope > [${PLACEHOLDER_ATTR}]`);
    const actionBar = findActionBar(node);

    if (collapsed && placeholder) {
      const trailing = placeholder.lastElementChild;
      if (trailing instanceof HTMLElement) {
        trailing.insertBefore(badge, trailing.firstChild);
      } else {
        placeholder.appendChild(badge);
      }
    } else if (actionBar) {
      mountInActionBar(actionBar, badge, ER_SLOT_ATTR);
    } else {
      badge.style.position = 'absolute';
      badge.style.bottom = '8px';
      badge.style.right = '12px';
      badge.style.zIndex = '2';
      if (getComputedStyle(node).position === 'static') node.style.position = 'relative';
      node.appendChild(badge);
    }
  },

  clearEngagement(root) {
    root.querySelectorAll(`[${ER_ATTR}]`).forEach((el) => el.remove());
    root.querySelectorAll(`[${ER_SLOT_ATTR}]`).forEach((el) => el.remove());
    hideTip();
  },

  radarBadge(node, state, onClick) {
    ensureRadarStyles();

    let badge = node.querySelector<HTMLButtonElement>(`:scope > [${RADAR_ATTR}]`);
    if (!badge) {
      badge = document.createElement('button');
      badge.setAttribute(RADAR_ATTR, 'true');
      badge.type = 'button';
      // X's own click handler opens the post; this badge must not.
      badge.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const handler = radarHandlers.get(badge!);
        if (handler) handler();
      });
      // The badge is absolutely positioned inside the article.
      if (getComputedStyle(node).position === 'static') node.style.position = 'relative';
      node.appendChild(badge);
    }
    radarHandlers.set(badge, onClick);

    const face = radarFace(state);
    badge.dataset.xffRadarKind = state.kind;
    badge.style.background = face.color;
    badge.disabled = state.kind === 'busy';
    badge.setAttribute('aria-label', face.text);
    badge.replaceChildren();

    const text = document.createElement('span');
    text.textContent = face.text;
    badge.appendChild(text);

    if (face.note) {
      const note = document.createElement('span');
      note.setAttribute('data-xff-radar-note', 'true');
      note.textContent = `· ${face.note}`;
      badge.appendChild(note);
    }
  },

  triageCard(node, result, actions) {
    ensureRadarStyles();

    node.querySelectorAll(`:scope > [${CARD_ATTR}]`).forEach((el) => el.remove());

    const card = document.createElement('div');
    card.setAttribute(CARD_ATTR, 'true');
    // Clicks inside the card must not open the post.
    card.addEventListener('click', (e) => e.stopPropagation());

    let close: HTMLButtonElement;
    if (result.ok) {
      const built = buildVerdictCard(card, result);
      close = built.close;
      const { ingest } = built;
      // One reusable error slot, so retrying never stacks messages.
      const err = document.createElement('span');
      err.setAttribute('data-xff-card-error', 'true');
      ingest.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        err.remove();
        ingest.disabled = true;
        ingest.textContent = '入队中…';
        const res = await actions.onIngest();
        if (res.ok) {
          ingest.textContent = `已入队 · 队列 ${res.count}`;
          return;
        }
        ingest.disabled = false;
        ingest.textContent = '重试入队';
        err.textContent = res.error;
        ingest.parentElement?.appendChild(err);
      });
    } else {
      close = buildErrorCard(card, result).close;
    }

    close.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      card.remove();
    });

    node.appendChild(card);
  },

  clearRadar(root) {
    root.querySelectorAll(`[${RADAR_ATTR}]`).forEach((el) => el.remove());
    root.querySelectorAll(`[${CARD_ATTR}]`).forEach((el) => el.remove());
  },
};
