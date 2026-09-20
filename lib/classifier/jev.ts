import { storage } from '#imports';
import { activeCriteriaLabeled } from '@/lib/prompt';
import {
  buildJevRequest,
  callJev,
  chunkPosts,
  isTooThin,
  normalizeThreshold,
  thinPostVerdict,
  verdictsFromJev,
} from '@/lib/jev';
import type { FilterConfig, LabeledCriterion, PostData, Verdict } from '@/lib/types';
import { allKeep } from './parse';

// TypeSafe Jev classifier. Unlike the chat-based providers there is no prompt:
// each post becomes a named record in the request `state`, each active rule
// becomes a Noul question over it, and the returned probabilities are
// thresholded here. Anything below the threshold keeps the post (fail-open).

/** Verdicts survive a browser restart, so a scrolled-back post is never re-billed. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 2000;

interface JevCache {
  /** Criteria + threshold the cached verdicts were produced under. */
  sig: string;
  entries: Record<string, { verdict: Verdict; at: number }>;
}

const EMPTY_CACHE: JevCache = { sig: '', entries: {} };

const jevCache = storage.defineItem<JevCache>('local:jevVerdictCache', { fallback: EMPTY_CACHE });

const cacheSignature = (criteria: LabeledCriterion[], threshold: number) =>
  JSON.stringify([criteria.map((c) => c.description), threshold]);

/** Cached verdicts for the current criteria, with expired entries dropped. */
async function readCache(sig: string): Promise<Record<string, Verdict>> {
  const stored = (await jevCache.getValue()) ?? EMPTY_CACHE;
  if (stored.sig !== sig) return {};
  const cutoff = Date.now() - CACHE_TTL_MS;
  const fresh: Record<string, Verdict> = {};
  for (const [id, entry] of Object.entries(stored.entries ?? {})) {
    if (entry && entry.at > cutoff) fresh[id] = entry.verdict;
  }
  return fresh;
}

async function writeCache(sig: string, fresh: Record<string, Verdict>): Promise<void> {
  const stored = (await jevCache.getValue()) ?? EMPTY_CACHE;
  const cutoff = Date.now() - CACHE_TTL_MS;
  const now = Date.now();
  const entries = stored.sig === sig ? { ...stored.entries } : {};
  for (const [id, entry] of Object.entries(entries)) {
    if (!entry || entry.at <= cutoff) delete entries[id];
  }
  for (const [id, verdict] of Object.entries(fresh)) entries[id] = { verdict, at: now };

  const ids = Object.keys(entries);
  if (ids.length > CACHE_MAX_ENTRIES) {
    ids
      .sort((a, b) => entries[a].at - entries[b].at)
      .slice(0, ids.length - CACHE_MAX_ENTRIES)
      .forEach((id) => delete entries[id]);
  }
  await jevCache.setValue({ sig, entries });
}

export async function classifyJev(posts: PostData[], config: FilterConfig): Promise<Verdict[]> {
  const key = (config.jevApiKey || '').trim();
  if (!key) {
    console.warn('[XFF/bg] Jev provider not configured (API key missing)');
    return allKeep(posts.length);
  }
  const criteria = activeCriteriaLabeled(config);
  if (criteria.length === 0) return allKeep(posts.length);

  const threshold = normalizeThreshold(config.jevThreshold);
  const sig = cacheSignature(criteria, threshold);
  const cached = await readCache(sig);

  const out = allKeep(posts.length);
  const ask: PostData[] = [];
  const askAt: number[] = [];

  posts.forEach((post, i) => {
    const hit = cached[post.id];
    if (hit) {
      out[i] = hit;
      return;
    }
    // Jev has no abstain channel — an empty post still gets a confident answer.
    if (isTooThin(post.text)) {
      out[i] = thinPostVerdict();
      return;
    }
    ask.push(post);
    askAt.push(i);
  });

  if (ask.length === 0) return out;

  const fresh: Record<string, Verdict> = {};
  let offset = 0;
  for (const chunk of chunkPosts(ask, criteria)) {
    const at = offset;
    offset += chunk.length;
    try {
      const res = await callJev(buildJevRequest(chunk, criteria), key, {
        baseUrl: config.jevBaseUrl,
      });
      console.log('[XFF/bg] Jev', res.model, 'usage', res.usage);
      verdictsFromJev(res.answers, chunk, criteria, threshold).forEach((verdict, j) => {
        out[askAt[at + j]] = verdict;
        fresh[chunk[j].id] = verdict;
      });
    } catch (err) {
      // Fail open for this chunk only; other chunks and cache hits still apply.
      console.warn('[XFF/bg] Jev request failed, keeping', chunk.length, 'post(s):', err);
    }
  }

  if (Object.keys(fresh).length > 0) {
    await writeCache(sig, fresh).catch((err) =>
      console.warn('[XFF/bg] Jev verdict cache write failed:', err),
    );
  }
  return out;
}
