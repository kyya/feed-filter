// Shared types for the X Feed Filter extension.

/** Which backend classifies posts. */
export type Provider = 'on-device' | 'openai' | 'jev';

/**
 * Which pipelines run over the feed. `filter` collapses matched posts (the
 * original behaviour), `radar` only badges ingest candidates, `both` runs the
 * filter first and prescreens whatever survives it.
 */
export type FilterMode = 'filter' | 'radar' | 'both';

/** User-configurable filter settings, persisted in extension storage. */
export interface FilterConfig {
  /** Master on/off switch for the whole extension. */
  enabled: boolean;
  /** Which pipelines run: collapse-filtering, the ingest radar, or both. */
  mode: FilterMode;
  /** Free-text natural-language rules, each judged by the LLM. */
  rules: string[];
  /** Preset category id -> enabled. Judged by the LLM. */
  categories: Record<string, boolean>;
  /** Author handles to hide deterministically (stored without a leading "@"). */
  blockedAuthors: string[];
  /** Show per-post debug badges (kept/hidden/blocked/…) on the feed. */
  debug: boolean;
  /** Show engagement-rate badges on posts (likes+replies+reposts ÷ views). */
  showEngagement: boolean;
  /** ER % at or above which a post is marked "Hot". */
  engagementHighPct: number;
  /** Hide posts whose engagement rate is below hideLowEngagementPct. */
  hideLowEngagement: boolean;
  /** Minimum ER %; posts below this are hidden when hideLowEngagement is on. */
  hideLowEngagementPct: number;
  /** Which classifier backend to use. */
  provider: Provider;
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 (we append /chat/completions). */
  apiBaseUrl: string;
  /** API key for the OpenAI-compatible endpoint (stored unencrypted in local storage). */
  apiKey: string;
  /** Model name for the OpenAI-compatible endpoint, e.g. gpt-4o-mini. */
  apiModel: string;
  /** API key for TypeSafe Jev (stored unencrypted in local storage). */
  jevApiKey: string;
  /** TypeSafe API base URL; `/v1/systemone` is appended to it. */
  jevBaseUrl: string;
  /** Noul probability (0–1) at or above which a Jev rule counts as matched. */
  jevThreshold: number;
  /** Radar: noul probability at or above which a post reads as substantive. */
  radarThreshold: number;
}

/** A single post extracted from the page, sent to the background for judging. */
export interface PostData {
  id: string;
  author: string;
  text: string;
  /** Engagement counts, when the provider asks for them (Jev's typed state). */
  metrics?: PostMetrics;
  /** True when the post is part of a same-author thread. */
  inThread?: boolean;
}

/**
 * One active filter criterion: `description` is what the model judges, `label`
 * is the short name shown in the UI and in hide reasons.
 */
export interface LabeledCriterion {
  label: string;
  description: string;
  /** Jev only: what a *true* answer looks like, from the preset's noul criteria. */
  matchesWhen?: string;
  /** Jev only: what a *false* answer looks like. */
  notMatchesWhen?: string;
}

/** Engagement counts scraped from a post's action bar. */
export interface PostMetrics {
  replies: number;
  reposts: number;
  likes: number;
  /** Absent or 0 when X hasn't rendered view counts yet. */
  views: number;
}

/** The classification result for a post. */
export interface Verdict {
  hide: boolean;
  reason: string;
  /** Model confidence in the decision, 0–100. */
  confidence: number;
}

// --- Ingest radar ------------------------------------------------------------
// The radar is a second, independent pass: a cheap Jev prescreen that runs over
// posts the filter kept, and — on demand — a full judgement from a local triage
// service that can see the knowledge base.

/** The three prescreen probabilities for one post, 0–1. */
export interface RadarSignals {
  /** Carries real technical / product / research / business information. */
  substantive: number;
  /** The author is the primary source, not a relay of someone else. */
  primary: number;
  /** Primarily marketing or audience farming. */
  promo: number;
}

/** Prescreen outcome for one post. */
export interface RadarVerdict {
  /** True when the post is worth offering for a full triage. */
  candidate: boolean;
  /** Null when the post never reached Jev, or Jev answered unusably. */
  signals: RadarSignals | null;
  /** One-line zh explanation, shown in the debug tooltip. */
  reason: string;
}

/** What the radar badge shows right now. */
export type RadarBadgeState =
  | { kind: 'candidate'; signals: RadarSignals }
  | { kind: 'busy' }
  | { kind: 'done'; recommend: TriageRecommend }
  | { kind: 'failed' };

/** What the triage service suggests doing with a post. */
export type TriageRecommend = 'ingest' | 'review' | 'skip';

/** One post as the local triage service takes it (`POST /triage` body). */
export interface TriageItem {
  id: string;
  url: string;
  author: string;
  text: string;
  link_domains: string[];
  source_type: 'tweet';
}

/** A knowledge-base page the triage service matched, with its probability. */
export interface TriagePageRef {
  page: string;
  prob: number;
  /** Only redundancy hits carry the page's path. */
  path?: string;
}

/** A page the post should be linked to, and how. */
export interface TriageLinkRef {
  page: string;
  prob: number;
  relation: string;
}

/** The full judgement, normalized so every list is present. */
export interface TriageVerdict {
  recommend: TriageRecommend;
  value: { level: number; label: string; score: number; confidence: number };
  primary_source: number;
  section: string;
  redundant_with: TriagePageRef[];
  contradicts: TriagePageRef[];
  links: TriageLinkRef[];
  tags: string[];
  summary_zh: string;
  candidates_considered: number;
  usage?: { input_tokens?: number; usd?: number };
}

/** A triage round trip. `offline` marks a service that never answered. */
export type TriageResult =
  | { ok: true; verdict: TriageVerdict }
  | { ok: false; offline: boolean; error: string };

/** An enqueue round trip; `count` is the queue size the service reports. */
export type InboxResult = { ok: true; count: number } | { ok: false; error: string };

/** Health probe used by the popup to tell whether the service is up. */
export type TriageHealth =
  | { ok: true; kb: string; pages: number }
  | { ok: false; offline: boolean; error: string };

/** Card actions handed to the adapter, which owns the card's DOM. */
export interface TriageCardActions {
  /** Queue the post; the adapter renders whatever comes back on the button. */
  onIngest(): Promise<InboxResult>;
}

/** Message sent from the content script to the background classifier. */
export interface ClassifyMessage {
  type: 'classifyBatch';
  posts: PostData[];
}

/** Message asking the background for a radar prescreen of a batch. */
export interface RadarMessage {
  type: 'radarBatch';
  posts: PostData[];
}

/** Message asking the background to run one post past the triage service. */
export interface TriageMessage {
  type: 'triage';
  item: TriageItem;
}

/** Message asking the background to queue a triaged post for ingest. */
export interface InboxMessage {
  type: 'inbox';
  item: TriageItem;
  verdict: TriageVerdict;
}

/**
 * Platform-agnostic contract every social platform implements. Only the
 * platform-specific DOM knowledge (selectors, collapse UI) lives behind this;
 * the engine that drives it is generic.
 */
export interface PlatformAdapter {
  name: string;
  /** Find candidate post nodes within a DOM subtree. */
  findPosts(root: ParentNode): HTMLElement[];
  /**
   * Return every post node belonging to the same thread as `node` (including
   * `node` itself), in document order. For a standalone post this is just
   * `[node]`. Used so hiding one post in a thread hides the whole thread.
   */
  findThread(node: HTMLElement): HTMLElement[];
  /** Pull author + text out of a post node (null if it isn't a usable post). */
  extractPost(node: HTMLElement): PostData | null;
  /** Pull reply/repost/like/view counts from a post's action bar. */
  extractMetrics(node: HTMLElement): PostMetrics | null;
  /** Collapse a matched post into a thin placeholder with a reason + reveal. */
  collapse(node: HTMLElement, reason: string, title?: string): void;
  /** Undo a collapse (the "Show anyway" action). */
  restore(node: HTMLElement): void;
  /**
   * Debug-only: stamp a post with its classification outcome. `label` is the
   * short pill text; `detail` is the full explanation shown on hover.
   * `confidence` (0–100) is shown beside the label when the model provided one.
   */
  annotate(
    node: HTMLElement,
    label: string,
    kind: DebugKind,
    detail?: string,
    confidence?: number,
  ): void;
  /** Remove all debug badges from a DOM subtree. */
  clearAnnotations(root: ParentNode): void;
  /**
   * Stamp a post with its engagement rate. `ratePct` is (likes+replies+reposts)/views×100;
   * `high` switches to the Hot styling when at/above the user threshold. `standout`
   * is the metric name — spelled exactly as `detail` prints it — that is
   * disproportionately high for this post, so the hover readout can highlight
   * it, or null when none stands out.
   */
  annotateEngagement(
    node: HTMLElement,
    ratePct: number,
    high: boolean,
    detail: string,
    standout?: string | null,
  ): void;
  /** Remove all engagement-rate badges from a DOM subtree. */
  clearEngagement(root: ParentNode): void;
  /**
   * Radar: paint (or update in place) the ingest-candidate badge on a post.
   * `onClick` asks for the full triage; the adapter re-paints via later calls.
   */
  radarBadge(node: HTMLElement, state: RadarBadgeState, onClick: () => void): void;
  /** Radar: show (or replace) the triage result card under a post. */
  triageCard(node: HTMLElement, result: TriageResult, actions: TriageCardActions): void;
  /** Remove every radar badge and triage card from a DOM subtree. */
  clearRadar(root: ParentNode): void;
}

/** Outcome shown by the debug badge on each post. */
export type DebugKind = 'pending' | 'kept' | 'hidden' | 'blocked' | 'skipped';
