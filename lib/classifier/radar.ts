import { buildJevRequest, callJev, chunkPosts, isTooThin } from '@/lib/jev';
import {
  RADAR_CRITERIA,
  normalizeRadarThreshold,
  radarVerdictsFromJev,
  skippedVerdict,
  verdictFromSignals,
} from '@/lib/radar';
import type { FilterConfig, PostData, RadarSignals, RadarVerdict } from '@/lib/types';
import { defineTtlCache } from './cache';

// The radar's automatic half: the same Jev plumbing as the filter, asking the
// three fixed prescreen questions instead of the user's rules. Fails closed on
// *candidacy* (an error means no badge) rather than open — the filter must never
// hide a post it couldn't judge, but the radar must never invite a spend on one.

/**
 * Raw probabilities are cached, not the candidate flag, so moving the threshold
 * re-decides every post on screen without a single new request.
 */
const radarCache = defineTtlCache<RadarSignals>(
  'local:radarSignalCache',
  24 * 60 * 60 * 1000,
  2000,
);

/** Only the questions themselves invalidate the cache; the threshold does not. */
const CACHE_SIG = JSON.stringify(RADAR_CRITERIA.map((c) => c.description));

const allSkipped = (count: number, reason: string): RadarVerdict[] =>
  Array.from({ length: count }, () => skippedVerdict(reason));

export async function prescreenBatch(
  posts: PostData[],
  config: FilterConfig,
): Promise<RadarVerdict[]> {
  const key = (config.jevApiKey || '').trim();
  if (!key) {
    console.warn('[XFF/bg] radar prescreen needs a TypeSafe API key');
    return allSkipped(posts.length, '未配置 TypeSafe API Key，雷达未预筛');
  }

  const threshold = normalizeRadarThreshold(config.radarThreshold);
  const cached = await radarCache.read(CACHE_SIG);

  const out = allSkipped(posts.length, '预筛未完成');
  const ask: PostData[] = [];
  const askAt: number[] = [];

  posts.forEach((post, i) => {
    const hit = cached[post.id];
    if (hit) {
      out[i] = verdictFromSignals(hit, threshold);
      return;
    }
    // Same input gate as the filter: Jev has no abstain channel, and a bare
    // link or emoji is never an ingest candidate anyway.
    if (isTooThin(post.text)) {
      out[i] = skippedVerdict('正文太短，未做预筛');
      return;
    }
    ask.push(post);
    askAt.push(i);
  });

  if (ask.length === 0) return out;

  const fresh: Record<string, RadarSignals> = {};
  let offset = 0;
  for (const chunk of chunkPosts(ask, RADAR_CRITERIA)) {
    const at = offset;
    offset += chunk.length;
    try {
      const res = await callJev(buildJevRequest(chunk, RADAR_CRITERIA), key, {
        baseUrl: config.jevBaseUrl,
      });
      console.log('[XFF/bg] radar', res.model, 'usage', res.usage);
      radarVerdictsFromJev(res.answers, chunk, threshold).forEach((verdict, j) => {
        out[askAt[at + j]] = verdict;
        if (verdict.signals) fresh[chunk[j].id] = verdict.signals;
      });
    } catch (err) {
      console.warn('[XFF/bg] radar prescreen failed for', chunk.length, 'post(s):', err);
      for (let j = 0; j < chunk.length; j++) {
        out[askAt[at + j]] = skippedVerdict('预筛请求失败');
      }
    }
  }

  if (Object.keys(fresh).length > 0) {
    await radarCache.write(CACHE_SIG, fresh).catch((err) =>
      console.warn('[XFF/bg] radar signal cache write failed:', err),
    );
  }
  return out;
}
