import { storage } from '#imports';
import type { FilterConfig } from './types';
import { CATEGORIES } from './categories';
import { DEFAULT_JEV_BASE_URL, DEFAULT_JEV_THRESHOLD } from './jev';
import { DEFAULT_RADAR_THRESHOLD } from './radar';

export const DEFAULT_CONFIG: FilterConfig = {
  enabled: true,
  mode: 'filter',
  rules: [],
  categories: Object.fromEntries(CATEGORIES.map((c) => [c.id, c.defaultOn === true])),
  blockedAuthors: [],
  debug: false,
  showEngagement: true,
  engagementHighPct: 3,
  hideLowEngagement: false,
  hideLowEngagementPct: 1,
  provider: 'on-device',
  apiBaseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  apiModel: 'gpt-4o-mini',
  jevApiKey: '',
  jevBaseUrl: DEFAULT_JEV_BASE_URL,
  jevThreshold: DEFAULT_JEV_THRESHOLD,
  radarThreshold: DEFAULT_RADAR_THRESHOLD,
};

/** Merge stored config with defaults so new fields work for older installs. */
export function normalizeConfig(c: Partial<FilterConfig> | null | undefined): FilterConfig {
  return {
    ...DEFAULT_CONFIG,
    ...c,
    categories: { ...DEFAULT_CONFIG.categories, ...(c?.categories ?? {}) },
    rules: c?.rules ?? DEFAULT_CONFIG.rules,
    blockedAuthors: c?.blockedAuthors ?? DEFAULT_CONFIG.blockedAuthors,
    showEngagement: c?.showEngagement ?? DEFAULT_CONFIG.showEngagement,
    engagementHighPct: c?.engagementHighPct ?? DEFAULT_CONFIG.engagementHighPct,
    hideLowEngagement: c?.hideLowEngagement ?? DEFAULT_CONFIG.hideLowEngagement,
    hideLowEngagementPct: c?.hideLowEngagementPct ?? DEFAULT_CONFIG.hideLowEngagementPct,
    provider: c?.provider ?? DEFAULT_CONFIG.provider,
    apiBaseUrl: c?.apiBaseUrl ?? DEFAULT_CONFIG.apiBaseUrl,
    apiKey: c?.apiKey ?? DEFAULT_CONFIG.apiKey,
    apiModel: c?.apiModel ?? DEFAULT_CONFIG.apiModel,
    jevApiKey: c?.jevApiKey ?? DEFAULT_CONFIG.jevApiKey,
    jevBaseUrl: c?.jevBaseUrl ?? DEFAULT_CONFIG.jevBaseUrl,
    jevThreshold: c?.jevThreshold ?? DEFAULT_CONFIG.jevThreshold,
    radarThreshold: c?.radarThreshold ?? DEFAULT_CONFIG.radarThreshold,
    mode: c?.mode ?? DEFAULT_CONFIG.mode,
    debug: c?.debug ?? DEFAULT_CONFIG.debug,
    enabled: c?.enabled ?? DEFAULT_CONFIG.enabled,
  };
}

/**
 * Single source of truth for filter settings. Popup writes it; content script
 * and background react via `.watch()`.
 */
export const filterConfig = storage.defineItem<FilterConfig>('local:filterConfig', {
  fallback: DEFAULT_CONFIG,
});
