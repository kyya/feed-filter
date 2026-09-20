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
import { defineTtlCache } from './cache';
import { allKeep } from './parse';

// TypeSafe Jev classifier. Unlike the chat-based providers there is no prompt:
// each post becomes a named record in the request `state`, each active rule
// becomes a Noul question over it, and the returned probabilities are
// thresholded here. Anything below the threshold keeps the post (fail-open).

/**
 * Verdicts survive a browser restart, so a scrolled-back post is never
 * re-billed. The `V2` key is not cosmetic: the entry shape moved from
 * `{ verdict, at }` to the shared cache's `{ value, at }`, so rows written by
 * an older build would read back empty and squat the entry cap for a day.
 */
const jevCache = defineTtlCache<Verdict>('local:jevVerdictCacheV2', 24 * 60 * 60 * 1000, 2000);

const cacheSignature = (criteria: LabeledCriterion[], threshold: number) =>
  JSON.stringify([criteria.map((c) => c.description), threshold]);

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
  const cached = await jevCache.read(sig);

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
    await jevCache.write(sig, fresh).catch((err) =>
      console.warn('[XFF/bg] Jev verdict cache write failed:', err),
    );
  }
  return out;
}
