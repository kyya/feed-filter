import { filterConfig, DEFAULT_CONFIG, normalizeConfig } from '@/lib/storage';
import { getAdapter } from '@/lib/adapters';
import { toTriageItem } from '@/lib/radar';
import type {
  DebugKind,
  FilterConfig,
  InboxResult,
  PostData,
  PostMetrics,
  RadarBadgeState,
  RadarVerdict,
  TriageResult,
  Verdict,
} from '@/lib/types';

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

  // --- Batch scheduler -------------------------------------------------------
  // Rather than one round-trip per post, buffer posts that need a model and send
  // them in batches: it amortizes the fixed system-prompt cost and slashes API
  // cost/latency. Posts flush when the buffer fills or after a short debounce.
  // `inflight` dedupes by post id so the same post never rides two batches.
  const BATCH_SIZE = 8;
  const BATCH_DEBOUNCE_MS = 120;

  /**
   * One queue per background message type. The filter and the radar each get
   * their own instance, so a slow prescreen never delays a collapse decision
   * and a batch of one never waits on the other's debounce.
   */
  function makeBatchQueue<R>(type: string) {
    const pending: PostData[] = [];
    const resolvers = new Map<string, (v: R | null) => void>();
    const inflight = new Map<string, Promise<R | null>>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    function flushNow() {
      if (flushTimer != null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (pending.length === 0) return;
      const batch = pending.splice(0, BATCH_SIZE);
      console.log('[XFF] sending batch of', batch.length, 'post(s) to', type);
      browser.runtime
        .sendMessage({ type, posts: batch })
        .then((results?: R[]) => {
          batch.forEach((post, i) => resolvers.get(post.id)?.(results?.[i] ?? null));
        })
        .catch((err) => {
          console.warn(`[XFF] ${type} failed, leaving posts untouched:`, err);
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

    return {
      /** Queue a post; resolves null on error so callers can fail open. */
      request(post: PostData): Promise<R | null> {
        const existing = inflight.get(post.id);
        if (existing) return existing;
        const p = new Promise<R | null>((resolve) => resolvers.set(post.id, resolve));
        inflight.set(post.id, p);
        void p.finally(() => {
          // Identity check: `drain()` clears both maps synchronously while this
          // callback is still a pending microtask, so by the time it runs the
          // slot may already belong to a newer request for the same post.
          if (inflight.get(post.id) !== p) return;
          inflight.delete(post.id);
          resolvers.delete(post.id);
        });
        pending.push(post);
        scheduleFlush();
        return p;
      },
      /** Drop everything queued and resolve every waiter with null. */
      drain() {
        if (flushTimer != null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        pending.length = 0;
        for (const resolve of resolvers.values()) resolve(null);
        resolvers.clear();
        inflight.clear();
      },
    };
  }

  const verdictQueue = makeBatchQueue<Verdict>('classifyBatch');
  const radarQueue = makeBatchQueue<RadarVerdict>('radarBatch');

  // Jev judges structured state rather than a prompt, so it gets the extra
  // signals the adapter already exposes (engagement counts, thread context).
  // The prompt-based providers only read author/text, so skip the DOM work.
  // The radar deliberately sends neither: its three questions are about the
  // text alone, and every extra field is billed on every post.
  const enrich = (node: HTMLElement, post: PostData): PostData =>
    config.provider === 'jev'
      ? {
          ...post,
          metrics: adapter!.extractMetrics(node) ?? undefined,
          inThread: adapter!.findThread(node).length > 1,
        }
      : post;

  // --- Ingest radar ----------------------------------------------------------
  // Prescreen verdicts are cached by post id like filter decisions are, so a
  // virtualized post that scrolls back gets its badge without a round trip.
  // Triage results are cached too, and for a harder reason: they cost real
  // money, so re-opening a card must never re-run the judgement.
  const radarVerdicts = new Map<string, RadarVerdict>();
  const triageResults = new Map<string, Extract<TriageResult, { ok: true }>>();
  /** Triage round trips in flight, so a recycled node can't buy a second one. */
  const triageInflight = new Map<string, Promise<TriageResult>>();
  const radarApplied = new WeakMap<HTMLElement, string>();
  const radarNoted = new WeakMap<HTMLElement, string>();

  // The radar has its own generation counter. Moving the radar threshold must
  // repaint every badge, but it says nothing about what should be collapsed —
  // bumping `gen` for it would throw away paid-for filter verdicts.
  let radarGen = 0;
  const radarStamp = (id: string) => `${radarGen}:${id}`;

  /**
   * Fold the prescreen numbers into this node's debug tooltip. Non-candidates
   * show nothing on screen at all unless debug labels are on, which is the
   * point: the radar adds one badge to the posts worth a look, not noise to
   * every post.
   */
  const noteRadarDebug = (node: HTMLElement, post: PostData, note: string) => {
    if (radarNoted.get(node) === radarStamp(post.id)) return;
    radarNoted.set(node, radarStamp(post.id));
    const seen = outcomes.get(node);
    if (seen) debug(node, seen.label, seen.kind, `${seen.detail}\n雷达：${note}`, seen.confidence);
    else debug(node, '◦ 雷达', 'skipped', `雷达：${note}`);
  };

  const showCard = (node: HTMLElement, post: PostData, result: TriageResult) => {
    adapter!.triageCard(node, result, {
      onIngest: async (): Promise<InboxResult> => {
        if (!result.ok) return { ok: false, error: '没有可入库的判定' };
        try {
          return (await browser.runtime.sendMessage({
            type: 'inbox',
            item: toTriageItem(post),
            verdict: result.verdict,
          })) as InboxResult;
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    });
  };

  const badgeFor = (post: PostData, verdict: RadarVerdict): RadarBadgeState => {
    const done = triageResults.get(post.id);
    if (done) return { kind: 'done', recommend: done.verdict.recommend };
    return { kind: 'candidate', signals: verdict.signals! };
  };

  async function requestTriage(post: PostData): Promise<TriageResult> {
    try {
      return (await browser.runtime.sendMessage({
        type: 'triage',
        item: toTriageItem(post),
      })) as TriageResult;
    } catch (err) {
      return {
        ok: false,
        offline: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async function onRadarClick(node: HTMLElement, post: PostData, verdict: RadarVerdict) {
    // Already judged: re-open the card from cache rather than paying again.
    const done = triageResults.get(post.id);
    if (done) {
      showCard(node, post, done);
      return;
    }

    adapter!.radarBadge(node, { kind: 'busy' }, () => {});
    // Dedupe by post id, not by badge: X recycles timeline nodes, and a fresh
    // node paints a fresh (clickable) badge while the first request is still
    // out. `disabled` alone would let that second click buy a second judgement.
    let inflight = triageInflight.get(post.id);
    if (!inflight) {
      inflight = requestTriage(post);
      triageInflight.set(post.id, inflight);
      void inflight.finally(() => triageInflight.delete(post.id));
    }
    const result = await inflight;

    // Only successes are cached — a failure has to stay retryable.
    if (result.ok) triageResults.set(post.id, result);
    adapter!.radarBadge(
      node,
      result.ok ? { kind: 'done', recommend: result.verdict.recommend } : { kind: 'failed' },
      () => void onRadarClick(node, post, verdict),
    );
    showCard(node, post, result);
  }

  const paintRadar = (node: HTMLElement, post: PostData, verdict: RadarVerdict) => {
    if (verdict.signals) noteRadarDebug(node, post, verdict.reason);
    if (!verdict.candidate || !verdict.signals) return;
    adapter!.radarBadge(node, badgeFor(post, verdict), () =>
      void onRadarClick(node, post, verdict),
    );
  };

  async function runRadar(node: HTMLElement, post: PostData) {
    // `extractPost` synthesizes an id from author+text when it can't find a
    // status link. There is no permalink to ingest in that case, and sending
    // one would put a fabricated URL into the knowledge base.
    if (!/^\d+$/.test(post.id)) return;
    if (radarApplied.get(node) === radarStamp(post.id)) return;

    const cached = radarVerdicts.get(post.id);
    if (cached) {
      radarApplied.set(node, radarStamp(post.id));
      paintRadar(node, post, cached);
      return;
    }

    // Claim the node before the await, same reason as the filter pass does.
    radarApplied.set(node, radarStamp(post.id));
    const requestGen = radarGen;
    const verdict = await radarQueue.request(post);
    if (requestGen !== radarGen) return;
    if (!verdict) {
      // No prescreen, no badge — and allow a later scan to retry.
      radarApplied.delete(node);
      return;
    }
    radarVerdicts.set(post.id, verdict);
    paintRadar(node, post, verdict);
  }

  /**
   * The collapse pipeline. Its return value is what gates the radar in `both`
   * mode, so it has three outcomes, not two: `pending` means this pass reached
   * no conclusion (a verdict is still in flight on another scan, or the config
   * moved under us). Treating that as `keep` would prescreen — and bill for —
   * every post a moment before the filter collapses it.
   */
  type FilterOutcome = 'hide' | 'keep' | 'pending';

  async function runFilter(node: HTMLElement, post: PostData): Promise<FilterOutcome> {
    // Low-ER check runs before the applied early-return so late-hydrated view
    // counts can still hide a post that was kept while views were missing.
    if (tryHideLowEngagement(node, post)) {
      applied.set(node, stamp(post.id));
      return 'hide';
    }

    const hidden = (d: Decision): FilterOutcome => (d.kind !== 'keep' ? 'hide' : 'keep');

    // This exact node already reflects this post under the current config —
    // but `applied` is stamped *before* the await below, so a missing decision
    // here means another scan is still waiting on the model, not that the post
    // was kept.
    if (applied.get(node) === stamp(post.id)) {
      const settled = decisions.get(post.id);
      return settled ? hidden(settled) : 'pending';
    }

    // Fast path: we've already judged this post id (even on another node).
    const cached = decisions.get(post.id);
    if (cached) {
      applyDecision(node, cached);
      applied.set(node, stamp(post.id));
      return hidden(cached);
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
      return 'hide';
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
        return 'hide';
      }
    }

    // LLM filters (rules + categories) — skip the round-trip if none are active.
    const hasLlmFilters =
      config.rules.some((r) => r.trim()) || Object.values(config.categories).some(Boolean);
    if (!hasLlmFilters) {
      applied.set(node, stamp(post.id));
      debug(node, '— 未启用过滤', 'skipped', '没有启用任何预设话题或自定义规则，没东西可匹配，直接保留。去设置页打开几个。');
      return 'keep';
    }

    // Mark this node handled NOW, before the (slow) await. Otherwise the
    // MutationObserver-driven re-scans that fire every frame while we wait for
    // the model would re-enter processPost for this same node again and again.
    applied.set(node, stamp(post.id));

    // Classify via the batch queue (dedupes by post id under the hood).
    debug(node, '… 判定中', 'pending', '已发给模型 — 等待判定结果。');
    const requestGen = gen;
    const verdict = await verdictQueue.request(enrich(node, post));

    // Config changed while we waited — this verdict is stale; a re-scan will
    // re-evaluate under the new generation (the stamp above is now outdated).
    if (requestGen !== gen) return 'pending';
    if (!verdict) {
      // Fail open and allow a later retry. The post stays visible, but we
      // don't know whether it would have been collapsed, so the radar waits
      // for the retry rather than spending on it now.
      applied.delete(node);
      debug(node, '⚠ 判定失败', 'skipped', '判定出错，按 fail-open 保留这条。');
      return 'pending';
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
    return verdict.hide ? 'hide' : 'keep';
  }

  async function processPost(node: HTMLElement) {
    if (!config.enabled) return;

    const post = adapter!.extractPost(node);
    if (!post) {
      if (applied.get(node) === stamp(NO_POST)) return;
      applied.set(node, stamp(NO_POST));
      debug(node, '? 无法解析', 'skipped', '没能从这个节点里取出正文/作者 — 可能不是真的推文，或者 X 的 DOM 变了。');
      return;
    }

    if (config.mode !== 'radar') {
      // Only a post the filter settled on and kept reaches the radar: a
      // collapsed post is one you decided not to read, and an undecided one
      // may be about to become one.
      if ((await runFilter(node, post)) !== 'keep') return;
    } else {
      applied.set(node, stamp(post.id));
    }

    if (config.mode !== 'filter') void runRadar(node, post);
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
  // Signature of everything that affects a collapse verdict. When it changes,
  // cached decisions are stale. Radar-only settings are deliberately absent:
  // they can't change what gets collapsed, and invalidating here would re-bill
  // the whole visible feed for a pass that has no persistent cache under the
  // on-device and OpenAI providers.
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

  /** What the radar pass depends on, beyond everything the filter does. */
  const radarSig = (c: FilterConfig) =>
    JSON.stringify({ mode: c.mode, radarThreshold: c.radarThreshold });

  filterConfig.watch((raw) => {
    const c = normalizeConfig(raw);
    const wasDebug = config.debug;
    const wasEngagement = config.showEngagement;
    const wasHighPct = config.engagementHighPct;
    const filtersChanged = filterSig(config) !== filterSig(c);
    // Anything that invalidates the filter (the API key, the master switch)
    // invalidates the prescreen too; the reverse is not true.
    const radarChanged = filtersChanged || radarSig(config) !== radarSig(c);
    config = c;
    console.log('[XFF] config changed', { filtersChanged, radarChanged, c });

    if (filtersChanged) {
      // Invalidate every cached verdict and drain any in-flight batch so
      // waiters fail open under the old generation (processPost checks gen).
      gen++;
      decisions.clear();
      verdictQueue.drain();
    }

    if (radarChanged) {
      // Prescreen verdicts bake in the threshold, so they go too. Triage
      // results don't depend on any of this and are paid for — they stay.
      radarGen++;
      radarVerdicts.clear();
      radarQueue.drain();
      // Badges and cards would otherwise linger with stale numbers; a re-scan
      // repaints whatever is still a candidate.
      adapter!.clearRadar(document);
    }

    if (filtersChanged || radarChanged) {
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
