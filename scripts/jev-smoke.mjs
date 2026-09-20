// Smoke test for the Jev classifier logic in lib/jev.ts, against the real
// TypeSafe API. Node 22 strips the types from the .ts imports directly.
//
// Two groups run back to back: an English one using ad-hoc custom rules, and a
// Chinese one using the shipped preset topics from lib/categories.ts — so the
// output doubles as an accuracy read on Chinese-language spam.
//
//   eval "$(grep -E '^[[:space:]]*export[[:space:]]+TYPESAFE_API_KEY=' ~/.zshrc)"
//   node scripts/jev-smoke.mjs

import { CATEGORIES } from '../lib/categories.ts';
import {
  DEFAULT_JEV_THRESHOLD,
  buildJevRequest,
  callJev,
  chunkPosts,
  isTooThin,
  postSubstance,
  questionId,
  thinPostVerdict,
  verdictsFromJev,
} from '../lib/jev.ts';

/** The exact criterion the extension ships for a preset topic. */
function preset(id) {
  const cat = CATEGORIES.find((c) => c.id === id);
  if (!cat) throw new Error(`unknown category id: ${id}`);
  return {
    label: cat.label,
    description: cat.description,
    matchesWhen: cat.matchesWhen,
    notMatchesWhen: cat.notMatchesWhen,
  };
}

// --- English group: three hand-written rules, as a user would type them ------
const EN_CRITERIA = [
  {
    label: 'Ragebait',
    description:
      'Content designed to provoke anger or moral outrage: inflammatory hot takes, deliberately divisive framing, or ragebait.',
  },
  {
    label: 'Crypto promotion',
    description:
      'Promotion of cryptocurrency, tokens, or NFTs: shilling a coin, price hype, or a call to buy, mint, or join.',
  },
  {
    label: 'Political flamewar',
    description:
      'Partisan political fighting: attacks on a political side, election flamewars, or hostile government-policy arguments.',
  },
];

const EN_POSTS = [
  {
    id: 'en-ragebait-1',
    author: 'hot_takes_daily',
    text: "Nobody wants to admit it but remote work was the single biggest scam ever pulled on employers. Half of you haven't done a real day's work since 2020. Quote tweet me, I'll wait.",
    metrics: { replies: 2400, reposts: 310, likes: 1800, views: 412000 },
    inThread: false,
  },
  {
    id: 'en-ragebait-2',
    author: 'civicpulse',
    text: 'Every single person defending this policy is either lying to you or too stupid to read the bill. There is no third option. Screenshot this and watch them melt down in the replies.',
    metrics: { replies: 5100, reposts: 890, likes: 3200, views: 980000 },
    inThread: false,
  },
  {
    id: 'en-crypto-1',
    author: 'chainmaxi',
    text: '$VELO is up 340% this week and we are still early. Liquidity locked, team doxxed, next 100x gem. Buy before the CEX listing drops on Friday. Link in bio to join the presale.',
    metrics: { replies: 120, reposts: 640, likes: 2100, views: 88000 },
    inThread: false,
  },
  {
    id: 'en-tech-1',
    author: 'dbinternals',
    text: 'Spent the afternoon tracing why our p99 latency doubled after the last deploy. Turned out the connection pool was being recreated per request because the config object was constructed inside the handler. One-line fix, 40% latency drop.',
    metrics: { replies: 18, reposts: 42, likes: 610, views: 51000 },
    inThread: true,
  },
  {
    id: 'en-emoji-only',
    author: 'quietposter',
    text: '🔥',
    metrics: { replies: 1, reposts: 0, likes: 12, views: 900 },
    inThread: false,
  },
  {
    id: 'en-url-only',
    author: 'linkdropper',
    text: 'https://example.com/some/long/article-slug-here',
    metrics: { replies: 0, reposts: 2, likes: 8, views: 1400 },
    inThread: false,
  },
];

// --- Chinese group: the four shipped spam presets ---------------------------
const CN_CRITERIA = [
  'sex_solicitation',
  'giveaway_scam_promo',
  'marketing_promo',
  'bot_or_spam',
].map(preset);

const CN_POSTS = [
  {
    id: 'cn-招嫖',
    author: 'tongcheng_yuepao',
    expect: 'HIDE',
    text: '全套上门服务，高端外围、楼凤兼职，同城可约看图选人，不满意不收费。加V信：xq998 备注城市，24小时在线安排。',
    metrics: { replies: 3, reposts: 1, likes: 6, views: 2200 },
    inThread: false,
  },
  {
    id: 'cn-福不黑空投',
    author: 'airdrop_fubuhei',
    expect: 'HIDE',
    text: '🎁福利来了！转发+关注+评论，今晚抽10位宝子送 USDT 空投，福不黑，每天都发，手慢无！领取入口在评论区置顶👇',
    metrics: { replies: 860, reposts: 1900, likes: 540, views: 120000 },
    inThread: false,
  },
  {
    id: 'cn-硬广营销',
    author: 'haowu_tuijian88',
    expect: 'HIDE',
    text: '【限时秒杀】这款便携榨汁杯原价299，今天直播间只要99！全网最低价，下单再送清洁刷。点链接直接拍 → shop.example.com/a1 拍完私信我返现。',
    metrics: { replies: 12, reposts: 30, likes: 88, views: 9400 },
    inThread: false,
  },
  {
    id: 'cn-技术帖',
    author: 'houduan_laobing',
    expect: 'KEEP',
    text: '折腾了一下午才定位到 p99 变慢的原因：连接池在每个请求里被重新创建，因为配置对象写在了 handler 内部。挪出去一行代码，延迟直接降了 40%。',
    metrics: { replies: 24, reposts: 60, likes: 720, views: 48000 },
    inThread: true,
  },
  {
    id: 'cn-闲聊',
    author: 'shanghai_xiaoye',
    expect: 'KEEP',
    text: '楼下那家面馆今天终于开门了，排了半小时队，牛肉给得比以前还足。上海入秋之后能吃上一碗热汤面，真的很治愈。',
    metrics: { replies: 6, reposts: 2, likes: 130, views: 7300 },
    inThread: false,
  },
  {
    id: 'cn-独立开发自荐',
    author: 'indie_xiaozhang',
    expect: 'BOUNDARY',
    text: '我自己写的小工具上线了，可以把微信收藏批量导出成 markdown，开源免费，不收费也没有内购，欢迎试试：github.com/example/wx-export',
    metrics: { replies: 15, reposts: 48, likes: 320, views: 26000 },
    inThread: false,
  },
];

const GROUPS = [
  { name: 'EN · 自定义规则', criteria: EN_CRITERIA, posts: EN_POSTS },
  { name: 'CN · 预设中文类别', criteria: CN_CRITERIA, posts: CN_POSTS },
];

const apiKey = (process.env.TYPESAFE_API_KEY ?? '').trim();
if (!apiKey) {
  console.error('TYPESAFE_API_KEY is not set in the environment.');
  process.exit(1);
}

const threshold = Number(process.env.JEV_THRESHOLD ?? DEFAULT_JEV_THRESHOLD);

/** Pad to a terminal column count, counting CJK glyphs as two cells. */
function pad(text, width) {
  const s = String(text);
  let used = 0;
  for (const ch of s) used += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(0, width - used));
}

let totalInput = 0;
let totalOutput = 0;
let totalSent = 0;
let ok = true;

for (const group of GROUPS) {
  const { name, criteria, posts } = group;
  console.log(`\n${'='.repeat(78)}\n${name}  ·  阈值 ${threshold}  ·  规则: ${criteria.map((c) => c.label).join(' / ')}\n${'='.repeat(78)}`);

  // --- Input gate ----------------------------------------------------------
  const sent = [];
  const skipped = [];
  for (const post of posts) (isTooThin(post.text) ? skipped : sent).push(post);

  console.log(`\n--- 入口过滤 (${posts.length} 条) ---`);
  for (const post of posts) {
    const substance = postSubstance(post.text);
    const gated = isTooThin(post.text);
    console.log(
      `  ${gated ? 'SKIP' : 'SEND'}  ${pad(post.id, 22)} substance=${substance.length}ch` +
        `${gated ? `  → 不发请求，直接保留 (${JSON.stringify(substance)})` : ''}`,
    );
  }

  // --- Real API call -------------------------------------------------------
  const chunks = chunkPosts(sent, criteria);
  console.log(`\n--- 请求 ---`);
  console.log(`  ${sent.length} 条推文 / ${chunks.length} 次请求 / ${sent.length * criteria.length} 个 noul 问题`);

  const results = new Map();
  const requestedIds = new Set();

  for (const chunk of chunks) {
    const body = buildJevRequest(chunk, criteria);
    for (const post of chunk) requestedIds.add(post.id);
    const res = await callJev(body, apiKey);
    totalInput += res.usage?.input_tokens ?? 0;
    totalOutput += res.usage?.output_tokens ?? 0;
    console.log(`  model=${res.model} input_tokens=${res.usage?.input_tokens} output_tokens=${res.usage?.output_tokens}`);

    const verdicts = verdictsFromJev(res.answers, chunk, criteria, threshold);
    chunk.forEach((post, p) => {
      results.set(post.id, {
        verdict: verdicts[p],
        nouls: criteria.map((_, r) => res.answers?.[questionId(p, r)]?.noul),
      });
    });
  }
  totalSent += sent.length;

  // --- Per-post report -----------------------------------------------------
  console.log(`\n--- 判定 ---`);
  for (const post of posts) {
    const hit = results.get(post.id);
    const want = post.expect ? `  [期望 ${post.expect}]` : '';
    console.log(`\n@${post.author}  [${post.id}]${want}`);
    console.log(`  text: ${JSON.stringify(post.text.slice(0, 70))}${post.text.length > 70 ? '…' : ''}`);
    if (!hit) {
      const verdict = thinPostVerdict();
      console.log('  nouls: (入口过滤，未发请求)');
      console.log(`  → ${verdict.hide ? 'HIDE' : 'KEEP'}  reason: ${verdict.reason}`);
      continue;
    }
    criteria.forEach((c, r) => {
      const noul = hit.nouls[r];
      const shown = typeof noul === 'number' ? noul.toFixed(2) : 'n/a';
      const mark = typeof noul === 'number' && noul >= threshold ? ' ← 过阈值' : '';
      console.log(`  ${pad(c.label, 24)} noul=${shown}${mark}`);
    });
    const got = hit.verdict.hide ? 'HIDE' : 'KEEP';
    const flag = post.expect && post.expect !== 'BOUNDARY' && post.expect !== got ? '  ✗ 与期望不符' : '';
    console.log(`  → ${got}  confidence=${hit.verdict.confidence}  reason: ${hit.verdict.reason}${flag}`);
  }

  // --- Gate assertion ------------------------------------------------------
  console.log(`\n--- 检查 ---`);
  for (const post of skipped) {
    const leaked = requestedIds.has(post.id);
    if (leaked) ok = false;
    console.log(`  ${leaked ? 'FAIL' : 'ok  '}  ${post.id} 没有被发往 API`);
  }
  console.log(`  ok    ${requestedIds.size} / ${posts.length} 条推文到达 API`);
}

// jev-1.13: $42 per Btok input, output free.
const costUsd = (totalInput / 1e9) * 42;
console.log(
  `\n用量合计: ${totalInput} input tokens（${totalOutput} output，免费）` +
    ` ≈ $${costUsd.toFixed(6)}，覆盖 ${totalSent} 条推文` +
    `（≈ $${((costUsd / Math.max(totalSent, 1)) * 1000).toFixed(4)} / 1000 条）`,
);

process.exit(ok ? 0 : 1);
