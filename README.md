# X Feed Filter · 中文版

一个 Chrome (MV3) 扩展：在 X / Twitter 时间线渲染的同时，用一个语言模型逐条判定推文，把你不想看的东西就地折叠成一行——招嫖引流、「福不黑」式福利空投、硬广营销、机器人刷屏，以及任何你自己用一句话写下的规则。

分类后端三选一：

| 后端 | 说明 |
| --- | --- |
| **本机模型** | Chrome 内置 Gemini Nano（Prompt API）。零服务器、零费用、数据不出浏览器。 |
| **API** | 任意 OpenAI 兼容的 `/chat/completions` 端点。 |
| **TypeSafe Jev** | `POST /v1/systemone`，每条规则一个 noul 问题，返回 0–1 概率。中文判定最准，本仓库的中文预设为它而写。 |

## 出处

- 底座是 [eintim/feed-filter](https://github.com/eintim/feed-filter)（WXT + React 19 + TypeScript，Cursor Hackathon Stuttgart 2026）。引擎、X 适配器、互动率、屏蔽作者、批量分类这些都来自上游。
- 中文垃圾类别、中文折叠条文案、Base URL 选项来自 [kyya/jev-x-feed-filter](https://github.com/kyya/jev-x-feed-filter)（纯静态 MV3 原型），已在这里重写为上游的预设 Topic 机制。
- 关于许可：**上游仓库目前没有 LICENSE 文件，GitHub 上也未声明许可证**。本仓库新增的代码按 MIT 处理，但分发整体之前建议先找上游作者确认授权。

## 安装

需要 **Chrome 138+**（本机模型需要实验性的 Prompt API；API / Jev 模式任意 Chromium 内核都行）。

```bash
pnpm install
pnpm build          # 产物 → dist/chrome-mv3
pnpm compile        # 只做类型检查
```

打开 `chrome://extensions` → 右上角开启 **开发者模式** → **加载已解压的扩展程序** → 选 `dist/chrome-mv3`。

开发模式：

```bash
pnpm dev            # 自动写好 chrome://flags 并带扩展启动一个独立的 Chrome 配置
```

## 设置

点扩展图标打开设置面板，顶部开关切到 **运行中**。

1. **分类器** 标签页 → 选 **TypeSafe Jev**。
2. 填 **API Key**（在 [console.typesafe.ai](https://console.typesafe.ai/settings/keys) 申请）。Key 以明文存在 `browser.storage.local`，只发给 TypeSafe 的 `Authorization` 头。
3. **Base URL（可选）**：默认 `https://api.typesafe.ai`，请求时拼 `/v1/systemone`。
   ⚠️ 改成别的域名还要同步修改 `wxt.config.ts` 里的 `host_permissions`（目前写死 `https://api.typesafe.ai/*`），否则 MV3 会拦掉请求。改完重新 `pnpm build`。
4. **折叠阈值**：滑块 0.40–0.95，步进 0.05，默认 **0.75**。任意一条规则的概率 ≥ 阈值，这条推文就折叠。
5. 点 **测试连接** 验证 Key 和 Base URL。

### 阈值为什么是 0.75，而不是旧版的 0.60

`jev-x-feed-filter` 原型问的是**一个总问题** `should_hide_in_feed`（"这条该不该折叠"），概率天然被摊平，0.60 就够。

这里改成**逐规则判定**：每条启用的规则单独问一次，取最高分。逐规则的问题更具体，命中时概率会压到 0.95 以上，不命中时压到 0.05 以下（见下面的实测），所以阈值抬到 0.75 反而更稳——既不误杀边缘内容，也不漏掉明显垃圾。

## 预设 Topics

**话题** 标签页里点一下就启用。前四个是中文时间线的垃圾类别，默认开启；`疑似垃圾（兜底）` 默认关闭。

| 显示名 | id | 判定文本（模型看到的 `criterion`） | 默认 |
| --- | --- | --- | --- |
| 招嫖 / 色情引流 | `sex_solicitation` | Primarily sexual solicitation, escort / 招嫖 advertising, or pornographic traffic diversion. | ✅ |
| 福不黑福利 / 空投刷屏 | `giveaway_scam_promo` | Primarily a giveaway / red-packet / airdrop / 「福不黑」-style welfare scam or crypto promo. | ✅ |
| 营销引流 | `marketing_promo` | Primarily commercial marketing / affiliate / paid promo / hard sell. | ✅ |
| 疑似营销/机器人 | `bot_or_spam` | Primarily from a spam / promo bot account or low-quality automated spam, rather than a real person sharing genuine content. | ✅ |
| 疑似垃圾（兜底） | `spam_fallback` | A personal X / Twitter feed should hide or collapse this post by default because it is spam, a scam, solicitation, or low-value promo. | ❌ |

上游的十个英文预设（AI、科技、游戏、广告 / 推广、加密货币 / NFT、政治、愤怒 / 引战、互动钓鱼、体育、犯罪 / 暴力）也都还在，同样默认关闭。

几点设计说明：

- **显示名是中文，判定文本是英文。** Jev 对英文 criterion 的判定更稳，而折叠条上要显示的是人能读懂的中文标签。两者在 `lib/categories.ts` 里同一条记录上。
- **每条预设还带 `matchesWhen` / `notMatchesWhen`**，对应原型 `background.js` 里 noul 的 `criteria.true` / `criteria.false`，会作为 `matches_when` / `does_not_match_when` 一起放进 Jev 的 `instructions`。只有 Jev 会读它们；本机模型和 OpenAI 模式只用 `description`。
- **兜底 Topic 是那个总问题**。默认关着，四个具体类别已经够用；开了它相当于再加一次"这条整体上该不该折叠"的宽判定，适合宁可错杀的场景。

## 自定义 Rules

**规则** 标签页，用一句大白话写，比如 `AI 吹嘘长串`、`转发抽奖`、`营销号翻译搬运`。每条规则在 Jev 下就是一个独立的 noul 问题，和预设 Topic 完全等价（只是没有 true/false 补充说明）。折叠条上会显示命中的那条规则原文（超过 48 字符会截断）。

作者屏蔽在 **作者** 标签页，不走模型，直接按 handle 折叠。

## Debug labels

设置面板底部的 **调试标签** 打开后，时间线上每条推文都会带一个小徽章：

- `… 判定中` / `✓ 保留` / `✕ <命中的规则>` / `⛔ 已屏蔽 @x` / `— 未启用过滤`
- 悬停看完整理由和置信度，例如 `已保留（置信度 97%） — 模型判定：最接近的规则「营销引流」3%，低于 75% 阈值`

折叠后的推文会显示成一行：

```
可能的垃圾信息 · 已折叠
已折叠: 招嫖 / 色情引流 (98%)                                  [显示这条]
```

点 **显示这条** 就地展开，这条推文在本次会话里不会再被折叠。

## 工作原理

```
entrypoints/x.content.ts   → 在 x.com / twitter.com 上启动引擎
lib/engine.ts              → 与平台无关的 扫描 / 判定 / 缓存 循环
lib/adapters/x.ts          → 所有 X 相关的 DOM 知识（选择器、折叠条 UI）
entrypoints/background.ts  → 分类队列（本机模型串行，远端并发上限 4）
lib/classifier/
  ├─ onDevice.ts           → Chrome Prompt API（Gemini Nano），常驻 session
  ├─ openai.ts             → 任意 OpenAI 兼容端点
  ├─ jev.ts                → TypeSafe Jev：阈值判定 + 24h 本地判定缓存
  └─ parse.ts              → 共用的 JSON 解析，出错一律 fail-open
lib/jev.ts                 → Jev 的请求构造 / 重试 / 概率→判定（纯函数，无 DOM）
lib/categories.ts          → 预设 Topic 定义（中文名 + 英文 criterion + true/false）
entrypoints/popup/         → React 设置面板
```

`MutationObserver` 监听 `document.body`，每次 DOM 变化就重新扫描。对每条推文：先查屏蔽作者和互动率下限（不走模型），再查按推文 status id 缓存的判定结果（**不是按 DOM 节点**——X 会虚拟化列表，同一条推文滚出去再滚回来是全新节点），都没命中才进批队列，8 条一批、120ms debounce 地发出去。

Jev 模式下一次请求覆盖 `批内推文 × 启用规则` 的所有组合：推文作为结构化 `state`（正文、作者、链接域名、是否同串、互动数），每个组合一个 noul 问题，Jev 读一遍 state 并行回答。判定结果按 status id 缓存 24 小时（规则或阈值一变就整体失效），所以来回滚动不会重复计费。

正文（去掉链接和 @ 之后）不足 20 个字符的推文直接保留，不发请求——Jev 没有"弃权"这个答案，对空内容也会给一个自信的概率。

任何一步出错都 fail-open：网络挂了、Key 错了、返回解析不了，推文照常显示，绝不会静默多折叠。

## 隐私

- 本机模型模式：什么都不出浏览器。
- API / Jev 模式：**你刷过的推文正文和作者 handle 会发给你配置的端点**，不带你的账号、cookie、session。
- API Key 明文存在 `browser.storage.local`（扩展本地存储），只出现在 `Authorization` 头里。
- 没有后端、没有数据库、没有埋点。

## 费用

Jev（`jev-1.13`）按输入 token 计费 **$42 / Btok**，输出免费。请求体的大头是"每条推文的 state"加上"每条推文 × 每条规则的问题文本"。

实测（`scripts/jev-smoke.mjs`，2026-09-20）：

| 场景 | 推文 × 规则 | input tokens | 每条推文 |
| --- | --- | --- | --- |
| 英文，3 条自定义规则（无 true/false 补充） | 4 × 3 | 1774 | ≈ 444 |
| 中文，4 个预设 Topic（带 true/false 补充） | 6 × 4 | 4040 | ≈ 673 |

也就是默认四个中文预设全开时 **≈ $0.03 / 1000 条推文**。粗算的经验公式：每条推文的 state ≈ 100 token，每条推文每条规则的问题 ≈ 55 token（英文短规则）到 ≈ 140 token（带 true/false 说明的预设）。少开几个 Topic 就线性地省钱；24 小时判定缓存让反复刷同一段时间线不重复计费。

## 局限

- **X 的 DOM 随时会变。** 所有脆弱的选择器都集中在 `lib/adapters/x.ts`，坏了只改这一个文件。
- **中文准确率**：下面这组实测是抽查，不是 benchmark，样本只有 6 条。阈值 0.75、四个预设全开：

  | 样例 | 最高分规则 | 概率 | 判定 |
  | --- | --- | --- | --- |
  | 招嫖引流（加微信、上门服务） | 招嫖 / 色情引流 | 0.98 | HIDE ✅ |
  | 福不黑空投（转发关注抽 USDT） | 福不黑福利 / 空投刷屏 | 0.98 | HIDE ✅ |
  | 硬广营销（限时秒杀 + 返现） | 营销引流 | 0.97 | HIDE ✅ |
  | 正常中文技术帖 | 营销引流 | 0.03 | KEEP ✅ |
  | 正常中文闲聊 | 疑似营销/机器人 | 0.03 | KEEP ✅ |
  | 边缘：独立开发者自荐开源工具 | 营销引流 | 0.28 | KEEP（合理） |

  两点要留意：一是**类别之间会串**——招嫖那条在「营销引流」上也有 0.83、在「疑似营销/机器人」上 0.95，四个预设全开等于取最大值，所以真正决定误杀率的是最宽松的那条规则（通常是「营销引流」）；二是干净内容的概率压得很低（≤0.03），说明阈值其实还能往下调，0.6 左右大概率也不会误杀，但没测过就别下结论。
- **误杀**：随时点「显示这条」，或者关掉某个 Topic、调高阈值。
- 目前只有 X / Twitter 的适配器；引擎和设置页本身是平台无关的（`PlatformAdapter` 接口），加一个平台基本就是加一个适配器文件。
- 规则和屏蔽名单不跨设备同步，只存在当前浏览器配置里。

## 开发

```bash
pnpm dev            # 带扩展启动 Chrome（会自动写好本机模型需要的 flags）
pnpm compile        # tsc --noEmit
pnpm build          # → dist/chrome-mv3
pnpm zip            # 打包
```

冒烟测试（会真的调 TypeSafe API，产生少量费用）：

```bash
eval "$(grep -E '^[[:space:]]*export[[:space:]]+TYPESAFE_API_KEY=' ~/.zshrc)"
node scripts/jev-smoke.mjs          # 中英各一组，逐条打印每条规则的概率
JEV_THRESHOLD=0.6 node scripts/jev-smoke.mjs   # 换个阈值看判定怎么变
```

脚本直接 import `lib/jev.ts` 和 `lib/categories.ts`（Node 22 原生剥类型），所以跑的就是扩展里真正用的那套逻辑和预设定义。

**永远不要把 API Key 写进仓库任何文件。**
