import type { LabeledCriterion, PostData, Verdict } from './types';

// Request/response shaping for TypeSafe's Jev — a "System One" model that takes
// typed questions over structured state instead of a chat prompt. This module is
// the Jev equivalent of prompt.ts: pure, DOM-free, network-only, and deliberately
// free of runtime imports so scripts/jev-smoke.mjs can exercise it under plain
// node. See https://docs.typesafe.ai/api and https://docs.typesafe.ai/primitives/noul.

export const DEFAULT_JEV_BASE_URL = 'https://api.typesafe.ai';
export const JEV_MODEL = 'jev-latest';

/**
 * The System One endpoint under a configured base URL. Pointing this anywhere
 * but api.typesafe.ai also needs a matching manifest host permission.
 */
export function jevEndpoint(baseUrl?: string): string {
  const base = (baseUrl || DEFAULT_JEV_BASE_URL).trim().replace(/\/+$/, '');
  return `${base}/v1/systemone`;
}

/** Noul probability at or above which a criterion counts as matched. */
export const DEFAULT_JEV_THRESHOLD = 0.75;

/**
 * Jev has no "abstain" answer: an empty or near-empty post still gets a
 * confident probability for whatever it is asked. Posts with less than this many
 * characters of real content (URLs and @-mentions stripped) are kept without a
 * request — cheaper and safer than trusting a judgment about nothing.
 */
export const MIN_SUBSTANCE_CHARS = 20;

// jev-1.13 allows 64k tokens for state + all questions, and 32k for state plus
// the single longest question. Budgets below sit well under both; ~4 chars per
// token is the usual rough estimate for English.
const CHARS_PER_TOKEN = 4;
const MAX_STATE_TOKENS = 28_000;
const MAX_REQUEST_TOKENS = 56_000;

const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
const DEFAULT_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_BACKOFF_MS = 600;

/** Explicit URLs, plus the bare `domain.tld/path` form X renders links as. */
const URL_RE = /\bhttps?:\/\/[^\s]+|\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\/[^\s]*/gi;
const MENTION_RE = /@\w{1,15}\b/g;

/** One post as Jev sees it — named fields, not a rendered prompt. */
export interface JevPost {
  index: number;
  author: string;
  text: string;
  link_domains: string[];
  /** True when X rendered this post as part of a same-author thread. */
  in_self_thread: boolean;
  engagement?: { replies: number; reposts: number; likes: number; views: number };
}

export interface JevNoulQuestion {
  type: 'noul';
  instructions: {
    criterion: string;
    matches_when?: string;
    does_not_match_when?: string;
    question: string;
  };
}

export interface JevRequestBody {
  state: { posts: JevPost[] };
  model: string;
  questions: Record<string, JevNoulQuestion>;
}

export interface JevResponse {
  model?: string;
  answers?: Record<string, { type?: string; noul?: number } | undefined>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Question id for post `p` against criterion `r`; answers come back under it. */
export function questionId(p: number, r: number): string {
  return `p${p}_r${r}`;
}

/** Post text with URLs and @-mentions removed, whitespace collapsed. */
export function postSubstance(text: string): string {
  return text.replace(URL_RE, ' ').replace(MENTION_RE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * True when a post carries too little judgeable content to send. Catches
 * link-only posts, pure emoji/punctuation, and bare @-replies.
 */
export function isTooThin(text: string): boolean {
  const substance = postSubstance(text);
  if (substance.length < MIN_SUBSTANCE_CHARS) return true;
  // Emoji and punctuation only — no letters or digits anywhere.
  return !/[\p{L}\p{N}]/u.test(substance);
}

/** Unique hostnames linked from a post, lowercased and stripped of `www.`. */
export function linkDomains(text: string): string[] {
  const domains = new Set<string>();
  for (const raw of text.match(URL_RE) ?? []) {
    const host = raw
      .replace(/^https?:\/\//i, '')
      .split('/')[0]
      .toLowerCase()
      .replace(/^www\./, '');
    if (host.includes('.')) domains.add(host);
  }
  return [...domains];
}

export function toJevPost(post: PostData, index: number): JevPost {
  const jev: JevPost = {
    index,
    author: post.author ? `@${post.author}` : 'unknown',
    text: post.text,
    link_domains: linkDomains(post.text),
    in_self_thread: post.inThread === true,
  };
  if (post.metrics) {
    const { replies, reposts, likes, views } = post.metrics;
    jev.engagement = { replies, reposts, likes, views };
  }
  return jev;
}

function buildQuestion(index: number, criterion: LabeledCriterion): JevNoulQuestion {
  return {
    type: 'noul',
    instructions: {
      criterion: criterion.description,
      // Present only on presets that carry the true/false hints; a custom rule
      // is just its own sentence.
      ...(criterion.matchesWhen ? { matches_when: criterion.matchesWhen } : {}),
      ...(criterion.notMatchesWhen ? { does_not_match_when: criterion.notMatchesWhen } : {}),
      question:
        `Judging only the X (Twitter) post at \`posts[${index}]\` and nothing else in the state, ` +
        'does that post match `criterion`?',
    },
  };
}

/**
 * One request covering every post × criterion pair. Jev reads the state once and
 * answers all questions in parallel, so batching is what makes this cheap.
 */
export function buildJevRequest(
  posts: PostData[],
  criteria: LabeledCriterion[],
  model: string = JEV_MODEL,
): JevRequestBody {
  const questions: Record<string, JevNoulQuestion> = {};
  posts.forEach((_, p) => {
    criteria.forEach((criterion, r) => {
      questions[questionId(p, r)] = buildQuestion(p, criterion);
    });
  });
  return { state: { posts: posts.map(toJevPost) }, model, questions };
}

const estimateTokens = (value: unknown): number =>
  Math.ceil(JSON.stringify(value).length / CHARS_PER_TOKEN);

/** Split posts so no single request can exceed Jev's context budgets. */
export function chunkPosts(posts: PostData[], criteria: LabeledCriterion[]): PostData[][] {
  const chunks: PostData[][] = [];
  let current: PostData[] = [];
  let stateTokens = 0;
  let questionTokens = 0;

  for (const post of posts) {
    const postTokens = estimateTokens(toJevPost(post, 0));
    const askTokens = criteria.reduce((sum, c) => sum + estimateTokens(buildQuestion(0, c)), 0);
    const overState = stateTokens + postTokens > MAX_STATE_TOKENS;
    const overTotal = stateTokens + postTokens + questionTokens + askTokens > MAX_REQUEST_TOKENS;
    if (current.length > 0 && (overState || overTotal)) {
      chunks.push(current);
      current = [];
      stateTokens = 0;
      questionTokens = 0;
    }
    current.push(post);
    stateTokens += postTokens;
    questionTokens += askTokens;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Keep a rule readable inside the collapsed-post placeholder. */
function shortLabel(label: string): string {
  const one = label.replace(/\s+/g, ' ').trim();
  return one.length > 48 ? `${one.slice(0, 47)}…` : one;
}

/** A keep verdict for a post that never went to Jev. */
export function thinPostVerdict(): Verdict {
  return { hide: false, reason: '正文太短，未发给 Jev 判断', confidence: 0 };
}

/**
 * Turn noul probabilities into one Verdict per post. A post is hidden when its
 * strongest criterion reaches `threshold`; anything below keeps it (fail-open),
 * as does a missing or malformed answer.
 */
export function verdictsFromJev(
  answers: JevResponse['answers'],
  posts: PostData[],
  criteria: LabeledCriterion[],
  threshold: number,
): Verdict[] {
  return posts.map((_, p) => {
    let best: { label: string; noul: number } | null = null;
    for (let r = 0; r < criteria.length; r++) {
      const noul = answers?.[questionId(p, r)]?.noul;
      if (typeof noul !== 'number' || !Number.isFinite(noul)) continue;
      if (!best || noul > best.noul) best = { label: criteria[r].label, noul };
    }
    if (!best) {
      return { hide: false, reason: 'Jev 未返回可用的判定', confidence: 0 };
    }
    const pct = Math.round(best.noul * 100);
    if (best.noul >= threshold) {
      return { hide: true, reason: `${shortLabel(best.label)} (${pct}%)`, confidence: pct };
    }
    return {
      hide: false,
      reason:
        `最接近的规则「${shortLabel(best.label)}」${pct}%，` +
        `低于 ${Math.round(threshold * 100)}% 阈值`,
      confidence: Math.round((1 - best.noul) * 100),
    };
  });
}

/** Clamp a stored threshold into a usable probability. */
export function normalizeThreshold(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return DEFAULT_JEV_THRESHOLD;
  return n;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function backoffMs(attempt: number, retryAfter: string | null): number {
  const secs = Number(retryAfter);
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 30_000);
  const base = DEFAULT_BACKOFF_MS * 2 ** attempt;
  return base + Math.random() * base;
}

export interface CallJevOptions {
  retries?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Overrides the default TypeSafe base URL. */
  baseUrl?: string;
}

/**
 * POST one request to Jev, retrying 429/529/5xx and network failures with
 * exponential backoff. Throws on a non-retryable error or once retries run out;
 * callers fail open. The API key is only ever sent in the Authorization header.
 */
export async function callJev(
  body: JevRequestBody,
  apiKey: string,
  options: CallJevOptions = {},
): Promise<JevResponse> {
  const {
    retries = DEFAULT_RETRIES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
    baseUrl,
  } = options;
  const endpoint = jevEndpoint(baseUrl);
  const payload = JSON.stringify(body);

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(backoffMs(attempt, null));
      continue;
    }

    if (res.ok) return (await res.json()) as JevResponse;

    const detail = (await res.text().catch(() => '')).slice(0, 200);
    if (!RETRY_STATUSES.has(res.status) || attempt >= retries) {
      throw new Error(`TypeSafe API ${res.status}: ${detail}`);
    }
    await sleep(backoffMs(attempt, res.headers.get('retry-after')));
  }
}
