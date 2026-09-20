import type {
  InboxResult,
  TriageHealth,
  TriageItem,
  TriageLinkRef,
  TriagePageRef,
  TriageRecommend,
  TriageResult,
  TriageVerdict,
} from './types';

// Client for the local triage service — the half of the radar that can see the
// knowledge base. It runs on the user's own machine, so the extension never
// learns anything about the KB: it posts a tweet and gets a judgement back.
//
// Pure fetch, no storage, no DOM: called from the background service worker
// (content scripts can't reach 127.0.0.1 cross-origin) and from the popup's
// health check.

/** Fixed loopback endpoint; the manifest grants exactly this origin. */
export const TRIAGE_BASE_URL = 'http://127.0.0.1:9224';

/** Shown verbatim on the card when the service refuses the connection. */
export const TRIAGE_OFFLINE_HINT =
  'triage 服务未启动：在知识库目录运行 python3 scripts/jev_triage.py serve';

const TRIAGE_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 2_000;
const INBOX_TIMEOUT_MS = 10_000;

const num = (value: unknown, fallback = 0): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

const RECOMMENDS: TriageRecommend[] = ['ingest', 'review', 'skip'];

function pageRefs(value: unknown): TriagePageRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const rec = raw as { page?: unknown; prob?: unknown; path?: unknown };
    const page = str(rec?.page);
    if (!page) return [];
    const path = str(rec?.path);
    return [{ page, prob: num(rec?.prob), ...(path ? { path } : {}) }];
  });
}

function linkRefs(value: unknown): TriageLinkRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const rec = raw as { page?: unknown; prob?: unknown; relation?: unknown };
    const page = str(rec?.page);
    if (!page) return [];
    return [{ page, prob: num(rec?.prob), relation: str(rec?.relation) }];
  });
}

/**
 * Normalize a response so the card can render it without guarding every field.
 * An unknown `recommend` degrades to `review` rather than being trusted.
 */
export function normalizeVerdict(raw: unknown): TriageVerdict {
  const rec = (raw ?? {}) as Record<string, unknown>;
  const recommend = str(rec.recommend) as TriageRecommend;
  const value = (rec.value ?? {}) as Record<string, unknown>;
  const usage = (rec.usage ?? {}) as Record<string, unknown>;
  return {
    recommend: RECOMMENDS.includes(recommend) ? recommend : 'review',
    value: {
      level: num(value.level),
      label: str(value.label),
      score: num(value.score),
      confidence: num(value.confidence),
    },
    primary_source: num(rec.primary_source),
    section: str(rec.section),
    redundant_with: pageRefs(rec.redundant_with),
    contradicts: pageRefs(rec.contradicts),
    links: linkRefs(rec.links),
    tags: Array.isArray(rec.tags) ? rec.tags.filter((t): t is string => typeof t === 'string') : [],
    summary_zh: str(rec.summary_zh),
    candidates_considered: num(rec.candidates_considered),
    usage: { input_tokens: num(usage.input_tokens), usd: num(usage.usd) },
  };
}

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err ?? '请求失败');

/** AbortSignal.timeout rejects with a TimeoutError, not a network error. */
const timedOut = (err: unknown): boolean => err instanceof Error && err.name === 'TimeoutError';

/**
 * POST to the local service. A rejected fetch means nothing is listening; an
 * error status means the service answered badly. Only the first is reported as
 * `offline`, because only it has a fix the user can act on — a timeout is a
 * service that *is* running and just took too long, and telling that user to
 * go start it would send them the wrong way.
 */
async function post(
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ ok: true; data: unknown } | { ok: false; offline: boolean; error: string }> {
  let res: Response;
  try {
    res = await fetch(`${TRIAGE_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (timedOut(err)) {
      return { ok: false, offline: false, error: `triage 服务 ${timeoutMs / 1000}s 内没有响应` };
    }
    return { ok: false, offline: true, error: message(err) };
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    return { ok: false, offline: false, error: `triage 服务 ${res.status}: ${detail}` };
  }
  try {
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, offline: false, error: `返回不是 JSON: ${message(err)}` };
  }
}

/** Full judgement for one post. The service may take a while — hence 120s. */
export async function fetchTriage(item: TriageItem): Promise<TriageResult> {
  const res = await post('/triage', item, TRIAGE_TIMEOUT_MS);
  if (!res.ok) return { ok: false, offline: res.offline, error: res.error };
  // The service reports its own failures in-band, so a 200 can still be an error.
  const err = (res.data as { error?: unknown } | null)?.error;
  if (typeof err === 'string' && err) return { ok: false, offline: false, error: err };
  return { ok: true, verdict: normalizeVerdict(res.data) };
}

/** Queue an already-triaged post for ingest. */
export async function queueForIngest(
  item: TriageItem,
  verdict: TriageVerdict,
): Promise<InboxResult> {
  const res = await post('/inbox', { item, verdict }, INBOX_TIMEOUT_MS);
  if (!res.ok) {
    return { ok: false, error: res.offline ? `${TRIAGE_OFFLINE_HINT}（${res.error}）` : res.error };
  }
  const data = (res.data ?? {}) as { queued?: unknown; count?: unknown; error?: unknown };
  if (typeof data.error === 'string' && data.error) return { ok: false, error: data.error };
  if (data.queued !== true) return { ok: false, error: '服务没有确认入队' };
  return { ok: true, count: num(data.count) };
}

/** Is the service up, and how big is the knowledge base it sees? */
export async function fetchHealth(): Promise<TriageHealth> {
  let res: Response;
  try {
    res = await fetch(`${TRIAGE_BASE_URL}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
  } catch (err) {
    if (timedOut(err)) {
      return { ok: false, offline: false, error: `triage 服务 ${HEALTH_TIMEOUT_MS / 1000}s 内没有响应` };
    }
    return { ok: false, offline: true, error: message(err) };
  }
  if (!res.ok) {
    return { ok: false, offline: false, error: `triage 服务 ${res.status}` };
  }
  const data = (await res.json().catch(() => null)) as
    | { ok?: unknown; kb?: unknown; pages?: unknown }
    | null;
  if (!data || data.ok !== true) {
    return { ok: false, offline: false, error: '服务返回 ok=false' };
  }
  return { ok: true, kb: str(data.kb, '?'), pages: num(data.pages) };
}
