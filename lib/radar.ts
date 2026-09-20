import type { LabeledCriterion, PostData, RadarSignals, RadarVerdict, TriageItem } from './types';
// Explicit .ts extension: scripts/radar-smoke.mjs loads this file under plain
// node, which needs the real filename for a value import.
import { linkDomains, questionId } from './jev.ts';
import type { JevResponse } from './jev.ts';

// The radar's prescreen: three fixed noul questions asked about every post that
// survives the feed filter, answered without any knowledge-base context. Its
// only job is to decide whether a post is worth paying for a full triage, so it
// reuses the filter's request machinery wholesale — buildJevRequest, chunkPosts,
// callJev and the input gate all take these criteria unchanged.
//
// Pure and DOM-free like lib/jev.ts, so scripts/radar-smoke.mjs runs the exact
// questions the extension ships.

/** Position of each question in RADAR_CRITERIA — answers come back by index. */
export const RADAR_SUBSTANTIVE = 0;
export const RADAR_PRIMARY = 1;
export const RADAR_PROMO = 2;

/** Substantive probability at or above which a post can be a candidate. */
export const DEFAULT_RADAR_THRESHOLD = 0.7;

/** A post this promotional is never a candidate, however substantive it reads. */
export const RADAR_PROMO_CEILING = 0.6;

/** primary_source at or above this earns the「一手」suffix on the badge. */
export const RADAR_PRIMARY_FLOOR = 0.7;

/**
 * The three questions, in answer order. English instructions (Jev judges them
 * more stably than Chinese, same as the filter presets) with explicit
 * true/false hints, because the boundary — a developer announcing their own
 * release is substantive and primary but *not* promo — is exactly what decides
 * whether the radar is useful or noisy.
 */
export const RADAR_CRITERIA: LabeledCriterion[] = [
  {
    label: '实质信息',
    description:
      'The post carries substantive technical, product, research, business, or industry information: a concrete fact, number, finding, release, mechanism, or argument a reader could actually learn something from.',
    matchesWhen:
      'Benchmark or pricing numbers, an architecture or implementation detail, a research result, a funding / acquisition / policy change, a release with specifics about what it does, a market or industry datapoint, a concrete explanation of how something works.',
    notMatchesWhen:
      'Small talk, jokes, greetings, personal mood, venting or complaint, a bare opinion or prediction with nothing supporting it, motivational or inspirational filler, pure marketing copy, or a link posted with no substance of its own.',
  },
  {
    label: '一手来源',
    description:
      'The post is a primary source: its own author is announcing, publishing, or reporting their own project, result, data, or official announcement, rather than relaying, summarizing, or reacting to someone else.',
    matchesWhen:
      'The author ships or releases their own project, publishes their own benchmark, research or data, posts an official announcement for the organisation or product they speak for, or reports first-hand what they themselves built, measured, or observed.',
    notMatchesWhen:
      'A repost or quote of someone else, a news summary of another party\'s announcement, commentary or reaction to a third-party link, an aggregator or news account relaying an item, or hearsay.',
  },
  {
    label: '营销引流',
    description:
      'The post is primarily marketing or audience farming: its main purpose is to sell, to drive signups or clicks, or to farm follows and engagement, rather than to convey information.',
    matchesWhen:
      'Hard sell, discount or referral codes, "link in bio", affiliate spam, paid promotion, giveaway or airdrop bait, follow-for-follow, reply farming, or engagement bait.',
    notMatchesWhen:
      'A genuine technical or informational post, even one about the author\'s own product or company, as long as its substance is the information rather than the pitch.',
  },
];

/** Clamp a stored radar threshold into a usable probability. */
export function normalizeRadarThreshold(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return DEFAULT_RADAR_THRESHOLD;
  return n;
}

/**
 * Candidate rule: substantive enough, and not mainly a pitch. `primary` is
 * reported but never gates — a good second-hand writeup is still worth a look.
 */
export function isCandidate(signals: RadarSignals, threshold: number): boolean {
  return signals.substantive >= threshold && signals.promo < RADAR_PROMO_CEILING;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** One line naming all three probabilities and what they decided. */
export function radarReason(signals: RadarSignals, threshold: number): string {
  const head =
    `实质 ${pct(signals.substantive)} · 一手 ${pct(signals.primary)} · ` +
    `营销 ${pct(signals.promo)}`;
  if (isCandidate(signals, threshold)) return `${head} → 入库候选`;
  const why =
    signals.substantive < threshold
      ? `实质低于 ${pct(threshold)} 阈值`
      : `营销达到 ${pct(RADAR_PROMO_CEILING)} 上限`;
  return `${head} → 非候选（${why}）`;
}

/** Read the three answers for post `p`, or null when any is missing. */
export function signalsFromJev(answers: JevResponse['answers'], p: number): RadarSignals | null {
  const read = (r: number): number | null => {
    const noul = answers?.[questionId(p, r)]?.noul;
    return typeof noul === 'number' && Number.isFinite(noul) ? noul : null;
  };
  const substantive = read(RADAR_SUBSTANTIVE);
  const primary = read(RADAR_PRIMARY);
  const promo = read(RADAR_PROMO);
  if (substantive == null || primary == null || promo == null) return null;
  return { substantive, primary, promo };
}

/** Build a verdict from already-read signals (also used on cache hits). */
export function verdictFromSignals(signals: RadarSignals, threshold: number): RadarVerdict {
  return {
    candidate: isCandidate(signals, threshold),
    signals,
    reason: radarReason(signals, threshold),
  };
}

/** A non-candidate verdict for a post that never went to Jev. */
export function skippedVerdict(reason: string): RadarVerdict {
  return { candidate: false, signals: null, reason };
}

/** Turn one Jev response into a verdict per post in the chunk. */
export function radarVerdictsFromJev(
  answers: JevResponse['answers'],
  posts: PostData[],
  threshold: number,
): RadarVerdict[] {
  return posts.map((_, p) => {
    const signals = signalsFromJev(answers, p);
    if (!signals) return skippedVerdict('Jev 未返回可用的预筛概率');
    return verdictFromSignals(signals, threshold);
  });
}

/**
 * Shape a post for the triage service. The permalink is rebuilt from the handle
 * and status id rather than scraped, so the item is buildable in the background
 * where there is no DOM.
 */
export function toTriageItem(post: PostData): TriageItem {
  const handle = post.author.replace(/^@+/, '');
  return {
    id: post.id,
    url: `https://x.com/${handle || 'i'}/status/${post.id}`,
    author: handle ? `@${handle}` : '',
    text: post.text,
    link_domains: linkDomains(post.text),
    source_type: 'tweet',
  };
}
