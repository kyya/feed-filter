import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  outDir: 'dist',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'X Feed Filter',
    description: '用本机模型或 TypeSafe Jev 折叠 X（Twitter）时间线上的垃圾与无关内容。',
    permissions: ['storage'],
    host_permissions: [
      'https://x.com/*',
      'https://twitter.com/*',
      // TypeSafe Jev classifier endpoint. Pointing the popup's Base URL field
      // at another host needs a matching entry here (and a rebuild).
      'https://api.typesafe.ai/*',
    ],
    // Granted at runtime when the user configures an OpenAI-compatible endpoint.
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    minimum_chrome_version: '138',
  },
  webExt: {
    // chrome-launcher (via web-ext-run) defaults include
    // --disable-features=...,OptimizationHints,... which kills the Optimization
    // Guide and makes LanguageModel.availability() return "unavailable".
    // A later --disable-features switch replaces the earlier one in Chromium,
    // so re-list the same defaults minus OptimizationHints.
    chromiumArgs: [
      '--disable-features=Translate,MediaRouter,DialMediaRouteProvider,CalculateNativeWinOcclusion,InterestFeedContentSuggestions,CertificateTransparencyComponentUpdater,AutofillServerCommunication,PrivacySandboxSettings4',
    ],
  },
});
