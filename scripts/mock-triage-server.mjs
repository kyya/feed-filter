// A stand-in for the real triage service, so the extension's radar can be
// exercised without a knowledge base. Node 22 standard library only.
//
//   node scripts/mock-triage-server.mjs
//   node scripts/mock-triage-server.mjs --port 9224 --latency 800
//
// Implements the three endpoints the extension calls:
//   GET  /health  → {"ok":true,"kb":"demo-kb","pages":128}
//   POST /triage  → one of the fixtures below, picked deterministically by id
//   POST /inbox   → {"queued":true,"count":N}
//
// Stop it (or never start it) to see the extension's "service not running"
// card — that path is as much a part of the contract as the happy one.

import { createServer } from 'node:http';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const PORT = Number(flag('port', 9224));
const HOST = '127.0.0.1';
/** Fake thinking time, so the「判定中…」badge state is actually visible. */
const LATENCY_MS = Number(flag('latency', 600));

// Deliberately a made-up knowledge base: this file knows nothing about any
// real one, it just answers in the right shape.
const KB = { kb: 'demo-kb', pages: 128 };

// Three fixtures covering the card's branches: a clean ingest, a skip whose
// reason is redundancy with existing pages, and a review with a contradiction.
const FIXTURES = [
  {
    recommend: 'ingest',
    value: { level: 1, label: '高价值 · 一手发布', score: 3.6, confidence: 0.7 },
    primary_source: 0.9,
    section: 'source',
    redundant_with: [],
    contradicts: [],
    links: [
      { page: '连接池', prob: 0.72, relation: 'extends' },
      { page: 'p99 延迟排查', prob: 0.61, relation: 'part-of' },
    ],
    tags: ['postgres', 'pooling', 'latency'],
    summary_zh: '作者本人发布了自己项目的新版本和一组延迟数据，是一手来源，库里没有对应页。',
    candidates_considered: 37,
    usage: { input_tokens: 8123, usd: 0.00034 },
    error: null,
  },
  {
    recommend: 'skip',
    value: { level: 3, label: '低价值 · 已有记录', score: 1.2, confidence: 0.81 },
    primary_source: 0.2,
    section: 'source',
    redundant_with: [
      { page: '推理加速卡', prob: 0.92, path: 'notes/inference-accelerators.md' },
      { page: '显存带宽', prob: 0.74, path: 'notes/memory-bandwidth.md' },
    ],
    contradicts: [],
    links: [],
    tags: ['hardware'],
    summary_zh: '二手转述，讲的东西 notes/inference-accelerators.md 已经写过了，没有新增信息。',
    candidates_considered: 41,
    usage: { input_tokens: 9210, usd: 0.00039 },
    error: null,
  },
  {
    recommend: 'review',
    value: { level: 2, label: '中等价值 · 需人工确认', score: 2.4, confidence: 0.55 },
    primary_source: 0.64,
    section: 'note',
    redundant_with: [{ page: '本地模型推理成本', prob: 0.58, path: 'notes/local-inference.md' }],
    contradicts: [{ page: '本地模型推理成本', prob: 0.8 }],
    links: [{ page: 'Gemini Nano', prob: 0.66, relation: 'relates-to' }],
    tags: ['local-llm', 'benchmark'],
    summary_zh: '给出的吞吐数字和库里那页记的对不上，值得人工看一眼再决定覆盖还是并存。',
    candidates_considered: 29,
    usage: { input_tokens: 7040, usd: 0.0003 },
    error: null,
  },
];

/** Same post → same fixture, so repeated clicks look consistent. */
function pickFixture(id) {
  let hash = 0;
  for (const ch of String(id ?? '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return FIXTURES[hash % FIXTURES.length];
}

/** Everything queued this run, newest last. */
const inbox = [];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    console.log('GET  /health');
    send(res, 200, { ok: true, ...KB });
    return;
  }

  if (req.method === 'POST' && pathname === '/triage') {
    const item = await readJson(req);
    if (!item?.id || typeof item.text !== 'string') {
      send(res, 400, { error: 'triage 需要 {id, url, author, text, link_domains, source_type}' });
      return;
    }
    const fixture = pickFixture(item.id);
    console.log(`POST /triage  ${item.author} ${item.id} → ${fixture.recommend}`);
    await sleep(LATENCY_MS);
    send(res, 200, fixture);
    return;
  }

  if (req.method === 'POST' && pathname === '/inbox') {
    const body = await readJson(req);
    if (!body?.item?.id || !body?.verdict) {
      send(res, 400, { error: 'inbox 需要 {item, verdict}' });
      return;
    }
    inbox.push(body);
    console.log(`POST /inbox   ${body.item.author} ${body.item.id} → 队列 ${inbox.length}`);
    send(res, 200, { queued: true, count: inbox.length });
    return;
  }

  send(res, 404, { error: `未知路径 ${pathname}` });
});

server.listen(PORT, HOST, () => {
  console.log(`mock triage service → http://${HOST}:${PORT}`);
  console.log(`  GET  /health   kb=${KB.kb} pages=${KB.pages}`);
  console.log(`  POST /triage   ${FIXTURES.map((f) => f.recommend).join(' / ')}（按推文 id 取模）`);
  console.log(`  POST /inbox    内存队列，重启即清空`);
  console.log(`  延迟 ${LATENCY_MS}ms — Ctrl-C 停止后可测「服务未启动」那张卡片`);
});
