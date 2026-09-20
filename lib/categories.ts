// Preset filter categories. The `description` is what the LLM actually sees,
// so it is written as a classification criterion, not a UI label. `label` is
// the Chinese name shown in the popup and in the collapsed-post reason.
//
// `matchesWhen` / `notMatchesWhen` are only read by the Jev provider, which
// judges one criterion at a time and takes the true/false hints alongside it.

export interface CategoryDef {
  id: string;
  label: string;
  emoji: string;
  description: string;
  /** What a *true* (matched) answer looks like — Jev only. */
  matchesWhen?: string;
  /** What a *false* (not matched) answer looks like — Jev only. */
  notMatchesWhen?: string;
  /** Enabled on a fresh install. Everything else starts off. */
  defaultOn?: boolean;
}

export const CATEGORIES: CategoryDef[] = [
  // --- Chinese-timeline spam presets, ported from the X Filter prototype -----
  {
    id: 'sex_solicitation',
    label: '招嫖 / 色情引流',
    emoji: '🔞',
    description:
      'Primarily sexual solicitation, escort / 招嫖 advertising, or pornographic traffic diversion.',
    matchesWhen: '招嫖, escort ads, porn diversion, explicit solicitation links',
    notMatchesWhen: 'Not primarily sexual solicitation or porn diversion',
    defaultOn: true,
  },
  {
    id: 'giveaway_scam_promo',
    label: '福不黑福利 / 空投刷屏',
    emoji: '🎁',
    description:
      'Primarily a giveaway / red-packet / airdrop / 「福不黑」-style welfare scam or crypto promo.',
    matchesWhen: 'Giveaway, airdrop, red packet, 福不黑 welfare, follow-to-win scam',
    notMatchesWhen: 'Not primarily a giveaway or airdrop promo',
    defaultOn: true,
  },
  {
    id: 'marketing_promo',
    label: '营销引流',
    emoji: '📣',
    description: 'Primarily commercial marketing / affiliate / paid promo / hard sell.',
    matchesWhen: 'Hard sell product promo, affiliate spam, commercial marketing dump',
    notMatchesWhen: 'Not primarily commercial marketing',
    defaultOn: true,
  },
  {
    id: 'bot_or_spam',
    label: '疑似营销/机器人',
    emoji: '🤖',
    description:
      'Primarily from a spam / promo bot account or low-quality automated spam, rather than a real person sharing genuine content.',
    matchesWhen: 'Repetitive promo, engagement bait, bot-like phrasing, fake giveaway style',
    notMatchesWhen: 'Normal personal opinion, news, conversation, or genuine content',
    defaultOn: true,
  },
  {
    id: 'spam_fallback',
    label: '疑似垃圾（兜底）',
    emoji: '🧹',
    description:
      'A personal X / Twitter feed should hide or collapse this post by default because it is spam, a scam, solicitation, or low-value promo.',
    matchesWhen: 'Worth collapsing for a cleaner personal feed',
    notMatchesWhen: 'Worth keeping visible',
  },

  // --- Upstream presets ------------------------------------------------------
  {
    id: 'ai',
    label: 'AI',
    emoji: '🤖',
    description:
      'Anything about artificial intelligence: AI, machine learning, LLMs, chatbots (ChatGPT, Gemini, Claude, Grok, etc.), generative-AI tools, AI art/images/video, AI agents, prompts, AI hype or doom threads, or content that is itself AI-generated.',
  },
  {
    id: 'tech',
    label: '科技',
    emoji: '💻',
    description:
      'Software, programming, startups, gadgets, big-tech company news, or product launches.',
  },
  {
    id: 'gaming',
    label: '游戏',
    emoji: '🎮',
    description:
      'Video games, game releases and reviews, esports, streamers, or gaming hardware.',
  },
  {
    id: 'ads',
    label: '广告 / 推广',
    emoji: '📢',
    description:
      'Advertisements, sponsored or promoted posts, product plugs, brand marketing, affiliate or referral links, discount codes, giveaways, "link in bio", calls to buy / sign up / subscribe / download, or any self-promotion.',
  },
  {
    id: 'crypto',
    label: '加密货币 / NFT',
    emoji: '🪙',
    description:
      'Cryptocurrency, tokens, NFTs, or related trading and shilling promotion.',
  },
  {
    id: 'politics',
    label: '政治',
    emoji: '🏛',
    description:
      'Political news, partisan commentary, elections, or government policy debates.',
  },
  {
    id: 'outrage',
    label: '愤怒 / 引战',
    emoji: '🔥',
    description:
      'Content designed to provoke anger or moral outrage, inflammatory hot takes, or ragebait.',
  },
  {
    id: 'engagement',
    label: '互动钓鱼',
    emoji: '🎣',
    description:
      'Reply-farming, "repost if", follow-for-follow, or low-effort viral engagement bait.',
  },
  {
    id: 'sports',
    label: '体育',
    emoji: '⚽',
    description: 'Sports scores, commentary, or athlete/team news.',
  },
  {
    id: 'crime',
    label: '犯罪 / 暴力',
    emoji: '🚨',
    description:
      'Graphic crime, violence, accidents, war footage, or distressing shock content.',
  },
];
