// Smoke test for the ingest radar's prescreen (lib/radar.ts) against the real
// TypeSafe API. Node 22 strips the types from the .ts imports directly.
//
// Six samples chosen to pin the boundaries the radar has to get right: a first-
// hand release and a first-hand benchmark should both be candidates, a
// second-hand news relay should be substantive but not primary, marketing and
// small talk should be neither, and a bare link should never reach the API.
//
//   eval "$(grep -E '^[[:space:]]*export[[:space:]]+TYPESAFE_API_KEY=' ~/.zshrc)"
//   node scripts/radar-smoke.mjs
//   RADAR_THRESHOLD=0.6 node scripts/radar-smoke.mjs

import { buildJevRequest, callJev, chunkPosts, isTooThin, postSubstance } from '../lib/jev.ts';
import {
  DEFAULT_RADAR_THRESHOLD,
  RADAR_CRITERIA,
  RADAR_PRIMARY_FLOOR,
  RADAR_PROMO_CEILING,
  radarVerdictsFromJev,
  signalsFromJev,
  toTriageItem,
} from '../lib/radar.ts';

const POSTS = [
  {
    id: '1000000000000000001',
    author: 'dbinternals',
    expect: '候选',
    note: '一手技术发布',
    text: 'Shipped pgpool-lite 0.4 today. Rewrote the connection handshake so a pooled backend is reused across TLS sessions: p99 connect time went from 41ms to 6ms on our staging cluster, and idle memory per backend dropped ~30%. Changelog and benchmarks: github.com/example/pgpool-lite/releases',
  },
  {
    id: '1000000000000000002',
    author: 'mlsysbench',
    expect: '候选',
    note: '一手实测数据',
    text: 'We ran the new 8B model on a single M4 Max for a week. 62 tok/s at 4-bit, 38 tok/s at 8-bit, and the 8-bit version lost 1.4 points on our internal eval while halving the hallucination rate on long-context retrieval. Raw numbers and the eval harness are in the repo.',
  },
  {
    id: '1000000000000000003',
    author: 'tech_roundup_cn',
    expect: '候选（非一手）',
    note: '二手转述新闻',
    text: '据外媒报道，某芯片厂商昨晚发布了新一代推理加速卡，官方称单卡显存 288GB、带宽 8TB/s，对比上代推理吞吐提升约 2.4 倍。目前尚未公布具体售价和出货时间。',
  },
  {
    id: '1000000000000000004',
    author: 'haowu_tuijian88',
    expect: '非候选',
    note: '营销',
    text: '【限时秒杀】这款便携榨汁杯原价299，今天直播间只要99！全网最低价，下单再送清洁刷。点链接直接拍 → shop.example.com/a1 拍完私信我返现，手慢无！',
  },
  {
    id: '1000000000000000005',
    author: 'shanghai_xiaoye',
    expect: '非候选',
    note: '闲聊',
    text: '楼下那家面馆今天终于开门了，排了半小时队，牛肉给得比以前还足。上海入秋之后能吃上一碗热汤面，真的很治愈。',
  },
  {
    id: '1000000000000000006',
    author: 'linkdropper',
    expect: '非候选（不发请求）',
    note: '纯链接',
    text: 'https://example.com/some/long/article-slug-here',
  },
];

const apiKey = (process.env.TYPESAFE_API_KEY ?? '').trim();
if (!apiKey) {
  console.error('TYPESAFE_API_KEY is not set in the environment.');
  process.exit(1);
}

const threshold = Number(process.env.RADAR_THRESHOLD ?? DEFAULT_RADAR_THRESHOLD);

/** Pad to a terminal column count, counting CJK glyphs as two cells. */
function pad(text, width) {
  const s = String(text);
  let used = 0;
  for (const ch of s) used += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(0, width - used));
}

const pct = (n) => (typeof n === 'number' ? `${(n * 100).toFixed(0)}%` : 'n/a');

console.log('='.repeat(80));
console.log(
  `入库雷达预筛  ·  实质阈值 ${threshold}  ·  营销上限 ${RADAR_PROMO_CEILING}  ·  一手线 ${RADAR_PRIMARY_FLOOR}`,
);
console.log(`问题: ${RADAR_CRITERIA.map((c) => c.label).join(' / ')}`);
console.log('='.repeat(80));

// --- Input gate: the same one the filter uses ---------------------------------
const sent = [];
const skipped = [];
for (const post of POSTS) (isTooThin(post.text) ? skipped : sent).push(post);

console.log(`\n--- 入口过滤 (${POSTS.length} 条) ---`);
for (const post of POSTS) {
  const gated = isTooThin(post.text);
  console.log(
    `  ${gated ? 'SKIP' : 'SEND'}  ${pad(post.id.slice(-4), 6)} ${pad(post.note, 16)}` +
      `substance=${postSubstance(post.text).length}ch${gated ? '  → 不发请求，绝不是候选' : ''}`,
  );
}

// --- Real API call ------------------------------------------------------------
const chunks = chunkPosts(sent, RADAR_CRITERIA);
console.log(`\n--- 请求 ---`);
console.log(
  `  ${sent.length} 条推文 / ${chunks.length} 次请求 / ${sent.length * RADAR_CRITERIA.length} 个 noul 问题`,
);

const results = new Map();
let totalInput = 0;
let totalOutput = 0;

for (const chunk of chunks) {
  const res = await callJev(buildJevRequest(chunk, RADAR_CRITERIA), apiKey);
  totalInput += res.usage?.input_tokens ?? 0;
  totalOutput += res.usage?.output_tokens ?? 0;
  console.log(
    `  model=${res.model} input_tokens=${res.usage?.input_tokens} output_tokens=${res.usage?.output_tokens}`,
  );
  const verdicts = radarVerdictsFromJev(res.answers, chunk, threshold);
  chunk.forEach((post, p) => {
    results.set(post.id, { verdict: verdicts[p], signals: signalsFromJev(res.answers, p) });
  });
}

// --- Per-post report ----------------------------------------------------------
console.log(`\n--- 预筛判定 ---`);
let ok = true;
for (const post of POSTS) {
  const hit = results.get(post.id);
  console.log(`\n@${post.author}  [${post.note}]  期望 ${post.expect}`);
  console.log(
    `  text: ${JSON.stringify(post.text.slice(0, 68))}${post.text.length > 68 ? '…' : ''}`,
  );
  if (!hit) {
    console.log('  nouls: (入口过滤，未发请求)');
    console.log('  → 非候选  reason: 正文太短，未做预筛');
    continue;
  }
  const s = hit.signals;
  RADAR_CRITERIA.forEach((c, r) => {
    const value = s ? [s.substantive, s.primary, s.promo][r] : undefined;
    const marks = [];
    if (r === 0 && value >= threshold) marks.push('← 过实质阈值');
    if (r === 1 && value >= RADAR_PRIMARY_FLOOR) marks.push('← 标「一手」');
    if (r === 2 && value >= RADAR_PROMO_CEILING) marks.push('← 触营销上限');
    console.log(`  ${pad(c.label, 12)} noul=${pct(value)}  ${marks.join(' ')}`);
  });
  const badge = hit.verdict.candidate
    ? `📥 候选 · ${pct(s.substantive)}${s.primary >= RADAR_PRIMARY_FLOOR ? ' · 一手' : ''}`
    : '（无徽章）';
  console.log(`  → ${hit.verdict.candidate ? '候选' : '非候选'}  徽章: ${badge}`);
  console.log(`  reason: ${hit.verdict.reason}`);
  if (post.expect.startsWith('候选') !== hit.verdict.candidate) {
    ok = false;
    console.log('  ✗ 与期望不符');
  }
}

// --- Gate assertion -----------------------------------------------------------
console.log(`\n--- 检查 ---`);
for (const post of skipped) {
  const leaked = results.has(post.id);
  if (leaked) ok = false;
  console.log(`  ${leaked ? 'FAIL' : 'ok  '}  ${post.note} 没有被发往 API`);
}

// --- What the triage request would look like ----------------------------------
const firstCandidate = POSTS.find((p) => results.get(p.id)?.verdict.candidate);
if (firstCandidate) {
  console.log(`\n--- 点徽章会 POST 给本地 triage 服务的 body ---`);
  console.log(JSON.stringify(toTriageItem(firstCandidate), null, 2));
}

// jev-1.13: $42 per Btok input, output free.
const costUsd = (totalInput / 1e9) * 42;
console.log(
  `\n用量合计: ${totalInput} input tokens（${totalOutput} output，免费）` +
    ` ≈ $${costUsd.toFixed(6)}，覆盖 ${sent.length} 条推文` +
    `（≈ ${Math.round(totalInput / Math.max(sent.length, 1))} token/条，` +
    `$${((costUsd / Math.max(sent.length, 1)) * 1000).toFixed(4)} / 1000 条）`,
);

process.exit(ok ? 0 : 1);
