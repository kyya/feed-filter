import { filterConfig, DEFAULT_CONFIG, normalizeConfig } from '@/lib/storage';
import { classifyBatch, resetOnDeviceSession } from '@/lib/classifier';
import { allKeep } from '@/lib/classifier/parse';
import { prescreenBatch } from '@/lib/classifier/radar';
import { skippedVerdict } from '@/lib/radar';
import { fetchTriage, queueForIngest } from '@/lib/triage';
import type {
  FilterConfig,
  InboxMessage,
  PostData,
  RadarMessage,
  RadarVerdict,
  TriageMessage,
  Verdict,
} from '@/lib/types';

export default defineBackground(() => {
  console.log('[XFF/bg] background service worker started');

  let config: FilterConfig = DEFAULT_CONFIG;
  filterConfig.getValue().then((c) => {
    config = normalizeConfig(c);
  });
  filterConfig.watch((c) => {
    config = normalizeConfig(c);
    // Criteria or provider may have changed — drop the cached on-device session.
    resetOnDeviceSession();
  });

  // --- Provider-aware batch queue -------------------------------------------
  // On-device (Gemini Nano) runs one inference at a time, so those batches are
  // strictly serialized. Remote endpoints (OpenAI-compatible, Jev) have no
  // single-model bottleneck, so their batches run concurrently up to a small cap.
  const MAX_CONCURRENT = 4;
  let tail: Promise<unknown> = Promise.resolve();
  let active = 0;
  const waiters: Array<() => void> = [];

  async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiters.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiters.shift()?.();
    }
  }

  function enqueue(posts: PostData[]): Promise<Verdict[]> {
    const safe = () => classifyBatch(posts, config).catch(() => allKeep(posts.length));
    if ((config.provider ?? 'on-device') !== 'on-device') {
      return withSlot(safe);
    }
    const run = tail.then(safe);
    tail = run.catch(() => {});
    return run;
  }

  /** Radar prescreens are remote Jev calls too, so they share the slot cap. */
  function enqueueRadar(posts: PostData[]): Promise<RadarVerdict[]> {
    const fallback = (): RadarVerdict[] =>
      Array.from({ length: posts.length }, () => skippedVerdict('预筛请求失败'));
    return withSlot(() => prescreenBatch(posts, config).catch(fallback)).catch(fallback);
  }

  browser.runtime.onMessage.addListener((message) => {
    const type = (message as { type?: string } | null)?.type;

    if (type === 'classifyBatch') {
      const posts = (message as { posts: PostData[] }).posts ?? [];
      console.log('[XFF/bg] received classifyBatch for', posts.length, 'post(s)');
      return enqueue(posts).catch(() => allKeep(posts.length));
    }

    if (type === 'radarBatch') {
      const posts = (message as RadarMessage).posts ?? [];
      console.log('[XFF/bg] received radarBatch for', posts.length, 'post(s)');
      return enqueueRadar(posts);
    }

    // The triage service lives on 127.0.0.1, which a content script can't reach
    // cross-origin — these two round trips have to happen here.
    if (type === 'triage') {
      const item = (message as TriageMessage).item;
      console.log('[XFF/bg] triage request for', item?.id);
      return fetchTriage(item);
    }

    if (type === 'inbox') {
      const { item, verdict } = message as InboxMessage;
      console.log('[XFF/bg] queueing', item?.id, 'for ingest');
      return queueForIngest(item, verdict);
    }

    return undefined;
  });
});
