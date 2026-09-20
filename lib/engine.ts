import { filterConfig, DEFAULT_CONFIG, normalizeConfig } from '@/lib/storage';
import { getAdapter } from '@/lib/adapters';
import type { DebugKind, FilterConfig, PostData, PostMetrics, Verdict } from '@/lib/types';

/** A cached, DOM-independent verdict for a post, keyed by its stable id. */
type Decision =
  | { kind: 'hide'; reason: string; confidence: number }
  | { kind: 'keep'; reason: string; confidence: number }
  | { kind: 'block'; author: string };

/** Engagement rate as a percent, or null when views are missing/zero. */
function engagementRate(m: PostMetrics): number | null {
  if (!m.views || m.views <= 0) return null;
  return ((m.likes + m.replies + m.reposts) / m.views) * 100;
}

/** Typical share each metric takes of a healthy post's total engagement. */
const ENGAGEMENT_MIX = { likes: 0.6, reposts: 0.22, replies: 0.18 } as const;
type EngagementKey = keyof typeof ENGAGEMENT_MIX;

/** Metric names as the engagement tooltip prints them. */
const METRIC_LABELS: Record<EngagementKey, string> = {
  likes: '点赞',
  replies: '回复',
  reposts: '转推',
};

/**
 * Which of likes/replies/reposts is disproportionately high for this post — the
 * metric whose share of total engagement most exceeds the typical mix — or null
 * when nothing stands out. Comparing *shares* (not raw counts) is what makes it
 * useful: raw likes almost always dominate, so this instead surfaces a ratio'd
 * post (replies), a viral one (reposts), or a discussion-free one (pure likes).
 */
function standoutMetric(m: PostMetrics): EngagementKey | null {
  const total = m.likes + m.replies + m.reposts;
  if (total < 10) return null; // too little engagement to read anything into
  let best: EngagementKey | null = null;
  let bestRatio = 1.5; // require ≥1.5× the metric's typical share to flag
  for (const key of ['likes', 'replies', 'reposts'] as EngagementKey[]) {
    const ratio = m[key] / total / ENGAGEMENT_MIX[key];
    if (ratio >= bestRatio) {
      bestRatio = ratio;
      best = key;
    }
  }
  return best;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

function metricsKey(m: PostMetrics): string {
  return `${m.replies}:${m.reposts}:${m.likes}:${m.views}`;
}

/**
 * Generic, platform-independent content-script engine: observes the feed,
 * extracts posts via the active adapter, applies deterministic filters
 * (author blocklist, low engagement) locally, and defers topic/rule
 * matching to the background LLM.
 */
export function startEngine() {
  const adapter = getAdapter(location.hostname);
  if (!adapter) {
    console.warn('[XFF] no adapter for host', location.hostname, '- engine not started');
    return;
  }
  console.log('[XFF] engine started with adapter:', adapter.name);

  let config: FilterConfig = DEFAULT_CONFIG;

  // Verdicts cached by stable post id, NOT by DOM node — X virtualizes the
  // timeline, so a post that scrolls out and back returns as a brand-new node.
  // Caching by id means we never re-ask the model for a post we've already
  // judged.
  const decisions = new Map<string, Decision>();

  // `config generation`: bumped whenever the filter config meaningfully changes,
  // so cached decisions and per-node bookkeeping are invalidated wholesale.
  let gen = 0;
  const NO_POST = '__nopost__';
  // What post id (+ generation) each live node currently reflects, so repeated
  // scans of an unchanged node do no work.
  const applied = new WeakMap<HTMLElement, string>();
  const stamp = (id: string) => `${gen}:${id}`;

  // Remember every post's latest outcome so the debug toggle can paint badges
  // onto posts already on screen — even ones processed while debug was off.
  const outcomes = new WeakMap<
    HTMLElement,
    { label: string; kind: DebugKind; detail: string; confidence?: number }
  >();
  const debug = (
    node: HTMLElement,
    label: string,
    kind: DebugKind,
    detail = label,
    confidence?: number,
  ) => {
    outcomes.set(node, { label, kind, detail, confidence });
    if (config.debug) adapter!.annotate(node, label, kind, detail, confidence);
  };

  // Last metrics fingerprint (+ threshold) painted on each node, so late-hydrated
  // view counts update the badge without thrashing the DOM every scan.
  const erApplied = new WeakMap<HTMLElement, string>();

  const updateEngagement = (node: HTMLElement) => {
    if (!config.enabled || !config.showEngagement) return;
    const metrics = adapter!.extractMetrics(node);
    if (!metrics) return;
    const rate = engagementRate(metrics);
    if (rate == null) {
      // Views not ready yet — clear a stale badge and wait for a later scan.
      if (erApplied.has(node)) {
        const badge = node.querySelector('[data-xff-er]');
        badge?.remove();
        erApplied.delete(node);
      }
      return;
    }
    const threshold = config.engagementHighPct;
    const standout = standoutMetric(metrics);
    const key = `${metricsKey(metrics)}@${threshold}#${standout ?? ''}`;
    const existing = node.querySelector('[data-xff-er]');
    if (erApplied.get(node) === key && existing) return;
    erApplied.set(node, key);
    const high = rate >= threshold;
    const detail =
      `${formatCount(metrics.likes)} 点赞 · ${formatCount(metrics.replies)} 回复 · ` +
      `${formatCount(metrics.reposts)} 转推 · ${formatCount(metrics.views)} 浏览` +
      ` → ${rate.toFixed(2)}%` +
      (high ? `（热门 ≥ ${threshold}%）` : '');
    adapter!.annotateEngagement(node, rate, high, detail, standout && METRIC_LABELS[standout]);
  };

  // Threads that have been hidden, remembered per-node so late-loading siblings
  // (X virtualizes the timeline — thread posts stream in over time) inherit the
  // hide instead of being classified fresh and shown.
  const threadHidden = new WeakSet<HTMLElement>();
  const threadReason = new WeakMap<HTMLElement, string>();
  const threadConfidence = new WeakMap<HTMLElement, number>();

  const markThreadHidden = (node: HTMLElement, why: string, confidence?: number) => {
    threadHidden.add(node);
    threadReason.set(node, why);
    if (confidence != null) threadConfidence.set(node, confidence);
  };

  // Collapse a matched post AND the rest of its thread, so hiding one post in a
  // self-thread hides the whole thread. Every sibling's hide is cached by id so
  // it survives virtualization too.
  const hideThread = (
    node: HTMLElement,
    shortWhy: string,
    detail: string,
    confidence?: number,
    title?: string,
  ) => {
    const thread = adapter!.findThread(node);
    for (const n of thread) {
      adapter!.collapse(n, shortWhy, title);
      markThreadHidden(n, shortWhy, confidence);
      if (n === node) {
        debug(n, `✕ ${shortWhy}`, 'hidden', detail, confidence);
      } else {
        const sib = adapter!.extractPost(n);
        if (sib) {
          decisions.set(sib.id, {
            kind: 'hide',
            reason: shortWhy,
            confidence: confidence ?? 0,
          });
          applied.set(n, stamp(sib.id));
        }
        debug(
          n,
          '✕ 同一推文串',
          'hidden',
          `同一推文串里另一条命中规则，整串一起折叠：${shortWhy}`,
          confidence,
        );
      }
    }
  };

  /**
   * Deterministic low-engagement hide. Returns true when the post was (or is
   * already) hidden for low ER. Waits for views to hydrate before deciding —
   * call on every scan so late view counts can still trigger a hide.
   */
  const tryHideLowEngagement = (node: HTMLElement, post: PostData): boolean => {
    if (!config.hideLowEngagement) return false;
    const metrics = adapter!.extractMetrics(node);
    if (!metrics) return false;
    const rate = engagementRate(metrics);
    if (rate == null) return false; // views not ready yet
    const threshold = config.hideLowEngagementPct;
    if (rate >= threshold) return false;

    const existing = decisions.get(post.id);
    if (existing?.kind === 'block') return false;
    if (existing?.kind === 'hide') {
      applyDecision(node, existing);
      return true;
    }

    const shortWhy = `互动率低于 ${threshold}%`;
    const detail =
      `已折叠 — 互动率 ${rate.toFixed(2)}% 低于你设的 ${threshold}% 下限` +
      `（${formatCount(metrics.likes)} 点赞 · ${formatCount(metrics.replies)} 回复 · ` +
      `${formatCount(metrics.reposts)} 转推 · ${formatCount(metrics.views)} 浏览）。`;
    const d: Decision = { kind: 'hide', reason: shortWhy, confidence: 100 };
    decisions.set(post.id, d);
    hideThread(node, shortWhy, detail, 100, '互动率过低 · 已折叠');
    return true;
  };

  // If any currently-rendered sibling of this post is a hidden thread, collapse
  // this post too before spending an LLM call. Returns the reason, or null.
  const inheritThreadHide = (node: HTMLElement): string | null => {
    const thread = adapter!.findThread(node);
    if (thread.length < 2) return null;
    const hiddenSib = thread.find((n) => n !== node && threadHidden.has(n));
    if (!hiddenSib) return null;
    const why = threadReason.get(hiddenSib) ?? '同一推文串里另一条命中规则';
    const confidence = threadConfidence.get(hiddenSib);
    adapter!.collapse(node, why);
    markThreadHidden(node, why, confidence);
    debug(
      node,
      '✕ 同一推文串',
      'hidden',
      `同一推文串里另一条命中规则，整串一起折叠：${why}`,
      confidence,
    );
    return why;
  };

  // Re-apply a cached verdict to a (possibly brand-new) node — no LLM call.
  const applyDecision = (node: HTMLElement, d: Decision) => {
    if (d.kind === 'hide') {
      const confNote =
        d.confidence > 0 ? `（置信度 ${d.confidence}%）` : '';
      hideThread(
        node,
        d.reason,
        `已折叠${confNote} — 模型判定：${d.reason}`,
        d.confidence || undefined,
      );
    } else if (d.kind === 'block') {
      adapter!.collapse(node, `屏蔽作者 @${d.author}`, '已屏蔽作者 · 已折叠');
      debug(
        node,
        `⛔ 已屏蔽 @${d.author}`,
        'blocked',
        `@${d.author} 在你的屏蔽作者名单里，直接折叠（不走模型）。`,
      );
    } else {
      const confNote =
        d.confidence > 0 ? `（置信度 ${d.confidence}%）` : '';
      debug(
        node,
        '✓ 保留',
        'kept',
        `已保留${confNote} — 模型判定：${d.reason}`,
        d.confidence || undefined,
      );
    }
  };

  // --- Batch classification scheduler ---------------------------------------
  // Rather than one round-trip per post, buffer posts that need the LLM and send
  // them in batches: it amortizes the fixed system-prompt cost and slashes API
  // cost/latency. Posts flush when the buffer fills or after a short debounce.
  // `inflight` dedupes by post id so the same post never rides two batches.
  const BATCH_SIZE = 8;
  const BATCH_DEBOUNCE_MS = 120;
  const pending: PostData[] = [];
  const resolvers = new Map<string, (v: Verdict | null) => void>();
  const inflight = new Map<string, Promise<Verdict | null>>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flushNow() {
    if (flushTimer != null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pending.length === 0) return;
    const batch = pending.splice(0, BATCH_SIZE);
    console.log('[XFF] sending batch of', batch.length, 'post(s) for classification');
    browser.runtime
      .sendMessage({ type: 'classifyBatch', posts: batch })
      .then((verdicts?: Verdict[]) => {
        batch.forEach((post, i) => resolvers.get(post.id)?.(verdicts?.[i] ?? null));
      })
      .catch((err) => {
        console.warn('[XFF] batch classify failed, leaving posts visible:', err);
        batch.forEach((post) => resolvers.get(post.id)?.(null));
      });
    if (pending.length > 0) scheduleFlush();
  }

  function scheduleFlush() {
    if (pending.length >= BATCH_SIZE) {
      flushNow();
      return;
    }
    if (flushTimer == null) flushTimer = setTimeout(flushNow, BATCH_DEBOUNCE_MS);
  }

  // Jev judges structured state rather than a prompt, so it gets the extra
  // signals the adapter already exposes (engagement counts, thread context).
  // The prompt-based providers only read author/text, so skip the DOM work.
  const enrich = (node: HTMLElement, post: PostData): PostData =>
    config.provider === 'jev'
      ? {
          ...post,
          metrics: adapter!.extractMetrics(node) ?? undefined,
          inThread: adapter!.findThread(node).length > 1,
        }
      : post;

  // Request a verdict for a post via the batch queue. Returns null on error
  // (fail open). Dedupes concurrent requests for the same post id.
  const requestVerdict = (post: PostData): Promise<Verdict | null> => {
    const existing = inflight.get(post.id);
    if (existing) return existing;
    const p = new Promise<Verdict | null>((resolve) => resolvers.set(post.id, resolve));
    inflight.set(post.id, p);
    void p.finally(() => {
      inflight.delete(post.id);
      resolvers.delete(post.id);
    });
    pending.push(post);
    scheduleFlush();
    return p;
  };

  async function processPost(node: HTMLElement) {
    if (!config.enabled) return;

    const post = adapter!.extractPost(node);
    if (!post) {
      if (applied.get(node) === stamp(NO_POST)) return;
      applied.set(node, stamp(NO_POST));
      debug(node, '? 无法解析', 'skipped', '没能从这个节点里取出正文/作者 — 可能不是真的推文，或者 X 的 DOM 变了。');
      return;
    }

    // Low-ER check runs before the applied early-return so late-hydrated view
    // counts can still hide a post that was kept while views were missing.
    if (tryHideLowEngagement(node, post)) {
      applied.set(node, stamp(post.id));
      return;
    }

    // This exact node already reflects this post under the current config.
    if (applied.get(node) === stamp(post.id)) return;

    // Fast path: we've already judged this post id (even on another node).
    const cached = decisions.get(post.id);
    if (cached) {
      applyDecision(node, cached);
      applied.set(node, stamp(post.id));
      return;
    }
    console.log('[XFF] extracted post', { id: post.id, author: post.author, text: post.text.slice(0, 60) });

    // Inherit a hide from a thread sibling that was already hidden.
    const inherited = inheritThreadHide(node);
    if (inherited) {
      decisions.set(post.id, {
        kind: 'hide',
        reason: inherited,
        confidence: threadConfidence.get(node) ?? 0,
      });
      applied.set(node, stamp(post.id));
      return;
    }

    // Deterministic author blocklist — no LLM needed.
    if (post.author) {
      const handle = post.author.toLowerCase();
      const blocked = config.blockedAuthors.some(
        (h) => h.replace(/^@/, '').toLowerCase() === handle,
      );
      if (blocked) {
        const d: Decision = { kind: 'block', author: post.author };
        decisions.set(post.id, d);
        applyDecision(node, d);
        applied.set(node, stamp(post.id));
        return;
      }
    }

    // LLM filters (rules + categories) — skip the round-trip if none are active.
    const hasLlmFilters =
      config.rules.some((r) => r.trim()) || Object.values(config.categories).some(Boolean);
    if (!hasLlmFilters) {
      applied.set(node, stamp(post.id));
      debug(node, '— 未启用过滤', 'skipped', '没有启用任何预设话题或自定义规则，没东西可匹配，直接保留。去设置页打开几个。');
      return;
    }

    // Mark this node handled NOW, before the (slow) await. Otherwise the
    // MutationObserver-driven re-scans that fire every frame while we wait for
    // the model would re-enter processPost for this same node again and again.
    applied.set(node, stamp(post.id));

    // Classify via the batch queue (dedupes by post id under the hood).
    debug(node, '… 判定中', 'pending', '已发给模型 — 等待判定结果。');
    const requestGen = gen;
    const verdict = await requestVerdict(enrich(node, post));

    // Config changed while we waited — this verdict is stale; a re-scan will
    // re-evaluate under the new generation (the stamp above is now outdated).
    if (requestGen !== gen) return;
    if (!verdict) {
      // Fail open and allow a later retry.
      applied.delete(node);
      debug(node, '⚠ 判定失败', 'skipped', '判定出错，按 fail-open 保留这条。');
      return;
    }
    const decision: Decision = verdict.hide
      ? {
          kind: 'hide',
          reason: verdict.reason || '命中了某条规则',
          confidence: verdict.confidence,
        }
      : {
          kind: 'keep',
          reason: verdict.reason || '未命中任何启用的规则',
          confidence: verdict.confidence,
        };
    decisions.set(post.id, decision);
    applyDecision(node, decision);
  }

  let scheduled = false;
  function scan() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const posts = adapter!.findPosts(document);
      console.log('[XFF] scan found', posts.length, 'post node(s) in DOM');
      for (const node of posts) {
        void processPost(node);
        updateEngagement(node);
      }
    });
  }

  filterConfig.getValue().then((c) => {
    config = normalizeConfig(c);
    console.log('[XFF] config loaded', config);
    scan();
  });
  // Signature of everything that affects a verdict (i.e. everything but the
  // debug flag). When it changes, cached decisions are stale.
  const filterSig = (c: FilterConfig) =>
    JSON.stringify({
      enabled: c.enabled,
      rules: c.rules,
      categories: c.categories,
      blockedAuthors: c.blockedAuthors,
      hideLowEngagement: c.hideLowEngagement,
      hideLowEngagementPct: c.hideLowEngagementPct,
      provider: c.provider,
      apiBaseUrl: c.apiBaseUrl,
      apiKey: c.apiKey,
      apiModel: c.apiModel,
      jevApiKey: c.jevApiKey,
      jevBaseUrl: c.jevBaseUrl,
      jevThreshold: c.jevThreshold,
    });

  filterConfig.watch((raw) => {
    const c = normalizeConfig(raw);
    const wasDebug = config.debug;
    const wasEngagement = config.showEngagement;
    const wasHighPct = config.engagementHighPct;
    const filtersChanged = filterSig(config) !== filterSig(c);
    config = c;
    console.log('[XFF] config changed', { filtersChanged, c });

    if (filtersChanged) {
      // Invalidate every cached verdict and drain any in-flight batch so
      // waiters fail open under the old generation (processPost checks gen).
      gen++;
      decisions.clear();
      if (flushTimer != null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      pending.length = 0;
      for (const resolve of resolvers.values()) resolve(null);
      resolvers.clear();
      inflight.clear();
      if (!c.enabled || !c.showEngagement) {
        adapter!.clearEngagement(document);
      }
      scan();
      return;
    }

    // Debug-only toggle: no reclassification. Strip badges when off, repaint
    // from the remembered outcomes when on.
    if (wasDebug && !c.debug) {
      adapter!.clearAnnotations(document);
    } else if (!wasDebug && c.debug) {
      for (const node of adapter!.findPosts(document)) {
        const o = outcomes.get(node);
        if (o) adapter!.annotate(node, o.label, o.kind, o.detail, o.confidence);
      }
    }

    // Engagement toggle / threshold: clear or re-paint without touching LLM state.
    if (wasEngagement && !c.showEngagement) {
      adapter!.clearEngagement(document);
      // WeakMap can't be cleared wholesale; fingerprints are overwritten on next on.
    } else if (c.showEngagement && (!wasEngagement || wasHighPct !== c.engagementHighPct)) {
      for (const node of adapter!.findPosts(document)) {
        erApplied.delete(node);
        updateEngagement(node);
      }
    }
  });

  new MutationObserver(() => scan()).observe(document.body, {
    childList: true,
    subtree: true,
  });
  scan();
}
