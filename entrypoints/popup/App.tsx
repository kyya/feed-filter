import { useEffect, useState } from 'react';
import { filterConfig, normalizeConfig } from '@/lib/storage';
import { CATEGORIES } from '@/lib/categories';
import { DEFAULT_JEV_BASE_URL, JEV_MODEL, jevEndpoint, normalizeThreshold } from '@/lib/jev';
import { normalizeRadarThreshold } from '@/lib/radar';
import { TRIAGE_BASE_URL, fetchHealth } from '@/lib/triage';
import type { FilterConfig, FilterMode, Provider, TriageHealth } from '@/lib/types';
import './App.css';

type ModelState = 'checking' | 'unsupported' | 'unavailable' | 'downloadable' | 'downloading' | 'ready';
type ApiTestState = 'idle' | 'testing' | 'ok' | 'error';
type Tab = 'topics' | 'rules' | 'authors' | 'engagement' | 'radar' | 'model';

const EXPECTED = [{ type: 'text' as const, languages: ['en'] }];

const TABS: { id: Tab; label: string }[] = [
  { id: 'topics', label: '话题' },
  { id: 'rules', label: '规则' },
  { id: 'authors', label: '作者' },
  { id: 'engagement', label: '互动' },
  { id: 'radar', label: '雷达' },
  { id: 'model', label: '分类器' },
];

const MODES: { id: FilterMode; label: string; hint: string }[] = [
  { id: 'filter', label: '过滤', hint: '你边刷，它边把噪音从时间线里折掉。' },
  { id: 'radar', label: '入库雷达', hint: '不折叠任何东西，只把值得入库的推文挑出来。' },
  { id: 'both', label: '两者', hint: '先折掉噪音，再从剩下的里挑值得入库的。' },
];

/** Fill in provider fields missing from older stored configs. */
function withDefaults(c: FilterConfig): FilterConfig {
  return normalizeConfig(c);
}

function normalizeAvailability(value: string): ModelState {
  if (value === 'available' || value === 'readily') return 'ready';
  if (value === 'downloadable' || value === 'after-download') return 'downloadable';
  if (value === 'downloading') return 'downloading';
  return 'unavailable';
}

/** Ask Chrome for host access to an OpenAI-compatible base URL. */
async function ensureHostPermission(baseUrl: string): Promise<boolean> {
  try {
    const origin = new URL(baseUrl).origin;
    const origins = [`${origin}/*`];
    const already = await browser.permissions.contains({ origins });
    if (already) return true;
    return await browser.permissions.request({ origins });
  } catch {
    return false;
  }
}

/** Status dot color for the on-device model, independent of the banner it's normally nested in. */
function modelDotColor(model: ModelState): string {
  if (model === 'ready') return 'var(--ok)';
  if (model === 'unavailable' || model === 'unsupported') return 'var(--warn)';
  if (model === 'checking') return 'var(--muted)';
  return 'var(--signal)';
}

function apiDotColor(state: ApiTestState): string {
  if (state === 'ok') return 'var(--ok)';
  if (state === 'error') return 'var(--warn)';
  if (state === 'testing') return 'var(--signal)';
  return 'var(--muted)';
}

function App() {
  const [config, setConfig] = useState<FilterConfig | null>(null);
  const [tab, setTab] = useState<Tab>('topics');
  const [model, setModel] = useState<ModelState>('checking');
  const [progress, setProgress] = useState<number | null>(null);
  const [newRule, setNewRule] = useState('');
  const [newAuthor, setNewAuthor] = useState('');
  const [apiTest, setApiTest] = useState<ApiTestState>('idle');
  const [apiError, setApiError] = useState('');
  const [health, setHealth] = useState<TriageHealth | null>(null);
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    filterConfig.getValue().then((c) => {
      const next = withDefaults(c);
      setConfig(next);
      // Persist newly added fields for older installs.
      if (
        c.showEngagement === undefined ||
        c.engagementHighPct === undefined ||
        c.hideLowEngagement === undefined ||
        c.hideLowEngagementPct === undefined
      ) {
        void filterConfig.setValue(next);
      }
    });
    checkModel();
    // Poll so the indicator updates live (downloadable → downloading → ready)
    // even when the download was triggered outside the popup.
    const id = setInterval(checkModel, 2000);
    return () => clearInterval(id);
  }, []);

  async function checkModel() {
    if (typeof LanguageModel === 'undefined') {
      setModel('unsupported');
      return;
    }
    try {
      setModel(
        normalizeAvailability(
          await LanguageModel.availability({ expectedInputs: EXPECTED, expectedOutputs: EXPECTED }),
        ),
      );
    } catch {
      setModel('unsupported');
    }
  }

  async function downloadModel() {
    if (typeof LanguageModel === 'undefined') return;
    setProgress(0);
    setModel('downloading');
    try {
      const session = await LanguageModel.create({
        expectedInputs: EXPECTED,
        expectedOutputs: EXPECTED,
        monitor(m) {
          m.addEventListener('downloadprogress', (e) => {
            setProgress((e as ProgressEvent).loaded);
          });
        },
      });
      session.destroy();
    } catch {
      // fall through to re-check below
    }
    setProgress(null);
    checkModel();
  }

  function update(patch: Partial<FilterConfig>) {
    if (!config) return;
    const next = { ...config, ...patch };
    setConfig(next);
    filterConfig.setValue(next);
  }

  async function setProvider(provider: Provider) {
    update({ provider });
    setApiTest('idle');
    setApiError('');
  }

  async function setApiBaseUrl(apiBaseUrl: string) {
    if (!config) return;
    const next = { ...config, apiBaseUrl };
    setConfig(next);
    // Persist immediately so typing isn't lost, but request host permission
    // once the URL looks like a real origin (on blur / via test).
    filterConfig.setValue(next);
    setApiTest('idle');
  }

  async function commitApiBaseUrl() {
    if (!config) return;
    const url = config.apiBaseUrl.trim();
    if (!url) return;
    const ok = await ensureHostPermission(url);
    if (!ok) {
      setApiError('主机权限被拒 — API 模式需要访问该端点。');
      setApiTest('error');
      return;
    }
    setApiError('');
  }

  async function testApi() {
    if (!config) return;
    const base = config.apiBaseUrl.trim();
    const key = config.apiKey.trim();
    const modelName = config.apiModel.trim();
    if (!base || !key || !modelName) {
      setApiError('请先填写 Base URL、API Key 和模型名。');
      setApiTest('error');
      return;
    }
    const granted = await ensureHostPermission(base);
    if (!granted) {
      setApiError('主机权限被拒 — 无法访问该端点。');
      setApiTest('error');
      return;
    }
    setApiTest('testing');
    setApiError('');
    try {
      const origin = base.replace(/\/+$/, '');
      const res = await fetch(`${origin}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            { role: 'system', content: 'Reply with JSON only.' },
            {
              role: 'user',
              content:
                'Classify this dummy post. Return {"results":[{"index":1,"hide":false,"reason":"ok","confidence":100}]}.\n\nPost 1 (@test):\n"""hello"""',
            },
          ],
          response_format: { type: 'json_object' },
          temperature: 0,
          max_tokens: 80,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`${res.status}: ${body.slice(0, 120)}`);
      }
      setApiTest('ok');
    } catch (err) {
      setApiTest('error');
      setApiError(err instanceof Error ? err.message : '请求失败');
    }
  }

  async function testJev() {
    if (!config) return;
    const key = config.jevApiKey.trim();
    if (!key) {
      setApiError('请先填写 TypeSafe API Key。');
      setApiTest('error');
      return;
    }
    setApiTest('testing');
    setApiError('');
    try {
      const res = await fetch(jevEndpoint(config.jevBaseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          state: 'Just shipped a small rewrite of our build pipeline.',
          model: JEV_MODEL,
          questions: { ping: { type: 'noul', instructions: 'Is this post about software?' } },
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`${res.status}: ${body.slice(0, 120)}`);
      }
      setApiTest('ok');
    } catch (err) {
      setApiTest('error');
      setApiError(err instanceof Error ? err.message : '请求失败');
    }
  }

  /** Ask the local triage service whether it is up and how big its KB is. */
  async function probeTriage() {
    setProbing(true);
    setHealth(await fetchHealth());
    setProbing(false);
  }

  function addRule() {
    const r = newRule.trim();
    if (!config || !r) return;
    update({ rules: [...config.rules, r] });
    setNewRule('');
  }

  function addAuthor() {
    const a = newAuthor.trim().replace(/^@+/, '');
    if (!config || !a) return;
    if (config.blockedAuthors.some((h) => h.toLowerCase() === a.toLowerCase())) {
      setNewAuthor('');
      return;
    }
    update({ blockedAuthors: [...config.blockedAuthors, a] });
    setNewAuthor('');
  }

  if (!config) return <div className="app app-loading">加载中…</div>;

  const provider = config.provider ?? 'on-device';
  const mode = config.mode ?? 'filter';
  const activeCats = CATEGORIES.filter((c) => config.categories[c.id]).length;
  const activeEngagement = Number(config.showEngagement) + Number(config.hideLowEngagement);

  function navBadge(id: Tab) {
    if (id === 'topics') return <span className="navtab-count">{activeCats}/{CATEGORIES.length}</span>;
    if (id === 'rules') return <span className="navtab-count">{config!.rules.length}</span>;
    if (id === 'authors') return <span className="navtab-count">{config!.blockedAuthors.length}</span>;
    if (id === 'engagement') return <span className="navtab-count">{activeEngagement}/2</span>;
    if (id === 'radar') {
      const on = mode !== 'filter';
      const color = !on ? 'var(--muted)' : health?.ok ? 'var(--ok)' : health ? 'var(--warn)' : 'var(--signal)';
      return <span className="navtab-dot" style={{ background: color }} aria-hidden="true" />;
    }
    if (id === 'model') {
      const color = provider === 'on-device' ? modelDotColor(model) : apiDotColor(apiTest);
      return <span className="navtab-dot" style={{ background: color }} aria-hidden="true" />;
    }
    return null;
  }

  return (
    <div className={`app${config.enabled ? ' app-live' : ''}`}>
      <header className="header">
        <div className="brand">
          <span className="brand-mark">X · 中文时间线过滤</span>
          <h1>Feed Filter</h1>
        </div>
        <label className="switch header-switch">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
            aria-label={config.enabled ? '过滤已开启' : '过滤已关闭'}
          />
          <span className="switch-track" aria-hidden="true">
            <span className="switch-thumb" />
          </span>
          <span className="switch-label">{config.enabled ? '运行中' : '已关闭'}</span>
        </label>
      </header>
      <p className="tagline">
        {config.enabled
          ? MODES.find((m) => m.id === mode)!.hint
          : '打开开关，开始清理时间线里的噪音。'}
      </p>

      <div className="modebar">
        <span className="modebar-label">模式</span>
        <div className="segment" role="group" aria-label="运行模式">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              className={mode === m.id ? 'segment-btn segment-on' : 'segment-btn'}
              aria-pressed={mode === m.id}
              onClick={() => update({ mode: m.id })}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="shell">
        <nav className="rail" role="tablist" aria-label="设置分类">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              className={tab === t.id ? 'navtab navtab-on' : 'navtab'}
              onClick={() => setTab(t.id)}
            >
              <span className="navtab-label">{t.label}</span>
              {navBadge(t.id)}
            </button>
          ))}
        </nav>

        <div className="panel">
          {tab === 'topics' && (
            <div className="panel-pane" role="tabpanel" id="panel-topics" aria-labelledby="tab-topics">
              <div className="panel-head">
                <h2>屏蔽话题</h2>
                <p className="panel-desc">勾选要让模型从时间线里清掉的内容。</p>
              </div>
              <div className="chips" role="group" aria-label="要折叠的话题">
                {CATEGORIES.map((cat) => {
                  const active = !!config.categories[cat.id];
                  return (
                    <button
                      key={cat.id}
                      type="button"
                      className={active ? 'chip chip-on' : 'chip'}
                      title={cat.description}
                      aria-pressed={active}
                      onClick={() => update({ categories: { ...config.categories, [cat.id]: !active } })}
                    >
                      <span className="chip-label">{cat.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {tab === 'rules' && (
            <div className="panel-pane" role="tabpanel" id="panel-rules" aria-labelledby="tab-rules">
              <div className="panel-head">
                <h2>自定义规则</h2>
                <p className="panel-desc">用大白话写规则，模型逐条拿推文去对。</p>
              </div>
              <div className="row">
                <input
                  value={newRule}
                  placeholder="例如：AI 吹嘘长串"
                  onChange={(e) => setNewRule(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addRule()}
                />
                <button type="button" className="add" onClick={addRule}>
                  添加
                </button>
              </div>
              <ul className="list list-scroll">
                {config.rules.map((rule, i) => (
                  <li key={`${rule}-${i}`}>
                    <span>{rule}</span>
                    <button
                      type="button"
                      className="remove"
                      aria-label={`删除规则：${rule}`}
                      onClick={() => update({ rules: config.rules.filter((_, j) => j !== i) })}
                    >
                      ×
                    </button>
                  </li>
                ))}
                {config.rules.length === 0 && (
                  <li className="empty">用一句话写条规则，命中的推文会被折叠。</li>
                )}
              </ul>
            </div>
          )}

          {tab === 'authors' && (
            <div className="panel-pane" role="tabpanel" id="panel-authors" aria-labelledby="tab-authors">
              <div className="panel-head">
                <h2>屏蔽作者</h2>
                <p className="panel-desc">按名单直接折叠 — 不走模型。</p>
              </div>
              <div className="row">
                <input
                  value={newAuthor}
                  placeholder="@handle"
                  onChange={(e) => setNewAuthor(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addAuthor()}
                />
                <button type="button" className="add" onClick={addAuthor}>
                  添加
                </button>
              </div>
              <ul className="list list-scroll">
                {config.blockedAuthors.map((h, i) => (
                  <li key={h}>
                    <span>@{h}</span>
                    <button
                      type="button"
                      className="remove"
                      aria-label={`取消屏蔽 @${h}`}
                      onClick={() => update({ blockedAuthors: config.blockedAuthors.filter((_, j) => j !== i) })}
                    >
                      ×
                    </button>
                  </li>
                ))}
                {config.blockedAuthors.length === 0 && (
                  <li className="empty">添加一个 handle，该账号的推文全部折叠。</li>
                )}
              </ul>
            </div>
          )}

          {tab === 'engagement' && (
            <div className="panel-pane" role="tabpanel" id="panel-engagement" aria-labelledby="tab-engagement">
              <div className="panel-head">
                <h2>互动率</h2>
                <p className="panel-desc">（点赞 + 回复 + 转推）÷ 浏览量。</p>
              </div>
              <div className="footer-toggle engagement-toggle">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={config.showEngagement}
                    onChange={(e) => update({ showEngagement: e.target.checked })}
                    aria-label="显示互动率"
                  />
                  <span className="switch-track" aria-hidden="true">
                    <span className="switch-thumb" />
                  </span>
                  <span className="switch-label">显示互动率</span>
                </label>
              </div>
              <label className={`field${config.showEngagement ? '' : ' field-disabled'}`}>
                <span className="field-label">高互动阈值 %</span>
                <input
                  type="number"
                  min={0.1}
                  step={0.1}
                  disabled={!config.showEngagement}
                  value={config.engagementHighPct}
                  onChange={(e) => {
                    const n = parseFloat(e.target.value);
                    if (!Number.isFinite(n) || n < 0) return;
                    update({ engagementHighPct: n });
                  }}
                />
              </label>
              <p className="hint hint-inline">达到或超过阈值的推文会带上 Hot 徽章。</p>

              <div className="footer-toggle engagement-toggle">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={config.hideLowEngagement}
                    onChange={(e) => update({ hideLowEngagement: e.target.checked })}
                    aria-label="折叠低互动推文"
                  />
                  <span className="switch-track" aria-hidden="true">
                    <span className="switch-thumb" />
                  </span>
                  <span className="switch-label">折叠低互动推文</span>
                </label>
              </div>
              <label className={`field${config.hideLowEngagement ? '' : ' field-disabled'}`}>
                <span className="field-label">最低互动率 %</span>
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  disabled={!config.hideLowEngagement}
                  value={config.hideLowEngagementPct}
                  onChange={(e) => {
                    const n = parseFloat(e.target.value);
                    if (!Number.isFinite(n) || n < 0) return;
                    update({ hideLowEngagementPct: n });
                  }}
                />
              </label>
              <p className="hint hint-inline">浏览量加载出来后，低于该比例的推文会被折叠。</p>
            </div>
          )}

          {tab === 'radar' && (
            <div className="panel-pane" role="tabpanel" id="panel-radar" aria-labelledby="tab-radar">
              <div className="panel-head">
                <h2>入库雷达</h2>
                <p className="panel-desc">自动预筛出值得入库的推文，点徽章再做完整判断。</p>
              </div>

              {mode === 'filter' && (
                <div className="banner banner-info">
                  <span className="status">
                    <span className="dot" />
                    当前是「过滤」模式，雷达没在跑
                  </span>
                </div>
              )}

              <label className={`field field-range${mode === 'filter' ? ' field-disabled' : ''}`}>
                <span className="field-label">
                  预筛阈值
                  <span className="field-value">{config.radarThreshold.toFixed(2)}</span>
                </span>
                <input
                  type="range"
                  min={0.4}
                  max={0.95}
                  step={0.05}
                  value={config.radarThreshold}
                  onChange={(e) => {
                    const n = parseFloat(e.target.value);
                    if (!Number.isFinite(n)) return;
                    update({ radarThreshold: normalizeRadarThreshold(n) });
                  }}
                />
              </label>
              <p className="hint hint-inline">
                每条推文问 Jev 三个问题：实质信息 / 一手来源 / 营销引流。
                实质 ≥ 阈值且营销 &lt; 60% 的算候选，右上角出一个徽章；一手 ≥ 70% 会加「一手」。
                实测约 750 token/条（≈ $0.03 / 1000 条），预筛结果按推文缓存 24 小时。
                预筛走 TypeSafe Jev，需要在「分类器」里填好 API Key（不必把分类器切到 Jev）。
              </p>

              <label className="field">
                <span className="field-label">triage 服务</span>
                <input value={TRIAGE_BASE_URL} readOnly spellCheck={false} />
              </label>
              <div className="api-actions">
                <button
                  type="button"
                  className="add add-compact"
                  onClick={() => void probeTriage()}
                  disabled={probing}
                >
                  {probing ? '检查中…' : '检查服务'}
                </button>
                {health?.ok && (
                  <span className="api-status api-ok">
                    已连通 · {health.kb} · {health.pages} 页
                  </span>
                )}
                {health && !health.ok && (
                  <span className="api-status api-err" title={health.error}>
                    {health.offline ? '未启动' : health.error}
                  </span>
                )}
              </div>
              <p className="hint hint-inline">
                没启动就在知识库目录跑 <code>python3 scripts/jev_triage.py serve</code>。
                预筛只把推文发给 TypeSafe；点徽章做完整判断时，推文先发到这台机器上的本地服务，
                再由本地服务决定把什么送去 TypeSafe——知识库内容不经过扩展。
              </p>
            </div>
          )}

          {tab === 'model' && (
            <div className="panel-pane" role="tabpanel" id="panel-model" aria-labelledby="tab-model">
              <div className="panel-head">
                <h2>分类器</h2>
                <p className="panel-desc">选择由谁来判定每条推文。</p>
              </div>
              <div className="segment" role="group" aria-label="分类器后端">
                <button
                  type="button"
                  className={provider === 'on-device' ? 'segment-btn segment-on' : 'segment-btn'}
                  aria-pressed={provider === 'on-device'}
                  onClick={() => setProvider('on-device')}
                >
                  本机模型
                </button>
                <button
                  type="button"
                  className={provider === 'openai' ? 'segment-btn segment-on' : 'segment-btn'}
                  aria-pressed={provider === 'openai'}
                  onClick={() => setProvider('openai')}
                >
                  API
                </button>
                <button
                  type="button"
                  className={provider === 'jev' ? 'segment-btn segment-on' : 'segment-btn'}
                  aria-pressed={provider === 'jev'}
                  onClick={() => setProvider('jev')}
                >
                  TypeSafe Jev
                </button>
              </div>

              {provider === 'on-device' ? (
                <div className="model-panel">
                  <ModelBanner model={model} progress={progress} onDownload={downloadModel} />
                </div>
              ) : provider === 'jev' ? (
                <div className="model-panel fields">
                  <label className="field">
                    <span className="field-label">API Key</span>
                    <input
                      type="password"
                      value={config.jevApiKey}
                      placeholder="TypeSafe API Key"
                      onChange={(e) => update({ jevApiKey: e.target.value })}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">Base URL（可选）</span>
                    <input
                      value={config.jevBaseUrl}
                      placeholder={DEFAULT_JEV_BASE_URL}
                      onChange={(e) => update({ jevBaseUrl: e.target.value })}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <label className="field field-range">
                    <span className="field-label">
                      折叠阈值
                      <span className="field-value">{config.jevThreshold.toFixed(2)}</span>
                    </span>
                    <input
                      type="range"
                      min={0.4}
                      max={0.95}
                      step={0.05}
                      value={config.jevThreshold}
                      onChange={(e) => {
                        const n = parseFloat(e.target.value);
                        if (!Number.isFinite(n)) return;
                        update({ jevThreshold: normalizeThreshold(n) });
                      }}
                    />
                  </label>
                  <p className="hint hint-inline">
                    每条规则会变成一个是/否问题；任一规则的概率达到阈值就折叠这条推文。
                    正文不足 20 个字符的推文直接保留，不发请求。改 Base URL 还需要同步改
                    manifest 的 host_permissions。API Key 以明文存在浏览器本地。
                  </p>
                  <div className="api-actions">
                    <button
                      type="button"
                      className="add add-compact"
                      onClick={() => void testJev()}
                      disabled={apiTest === 'testing'}
                    >
                      {apiTest === 'testing' ? '测试中…' : '测试连接'}
                    </button>
                    {apiTest === 'ok' && <span className="api-status api-ok">已连通</span>}
                    {apiTest === 'error' && (
                      <span className="api-status api-err" title={apiError}>
                        {apiError || '失败'}
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <div className="model-panel fields">
                  <label className="field">
                    <span className="field-label">Base URL</span>
                    <input
                      value={config.apiBaseUrl}
                      placeholder="https://api.openai.com/v1"
                      onChange={(e) => setApiBaseUrl(e.target.value)}
                      onBlur={() => void commitApiBaseUrl()}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">API Key</span>
                    <input
                      type="password"
                      value={config.apiKey}
                      placeholder="sk-…"
                      onChange={(e) => update({ apiKey: e.target.value })}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">模型</span>
                    <input
                      value={config.apiModel}
                      placeholder="gpt-4o-mini"
                      onChange={(e) => update({ apiModel: e.target.value })}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <p className="hint hint-inline">
                    你刷过的推文会发往这个端点。API Key 以明文存在浏览器本地。
                  </p>
                  <div className="api-actions">
                    <button
                      type="button"
                      className="add add-compact"
                      onClick={() => void testApi()}
                      disabled={apiTest === 'testing'}
                    >
                      {apiTest === 'testing' ? '测试中…' : '测试连接'}
                    </button>
                    {apiTest === 'ok' && <span className="api-status api-ok">已连通</span>}
                    {apiTest === 'error' && (
                      <span className="api-status api-err" title={apiError}>
                        {apiError || '失败'}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <footer className="footer">
        <label className="switch">
          <input
            type="checkbox"
            checked={config.debug}
            onChange={(e) => update({ debug: e.target.checked })}
            aria-label="调试标签"
          />
          <span className="switch-track" aria-hidden="true">
            <span className="switch-thumb" />
          </span>
          <span className="switch-label">调试标签</span>
        </label>
        <span className="footer-hint">屏幕上已有的推文需要刷新 X 页面才会重新判定。</span>
      </footer>
    </div>
  );
}

function ModelBanner({
  model,
  progress,
  onDownload,
}: {
  model: ModelState;
  progress: number | null;
  onDownload: () => void;
}) {
  const pct = progress != null ? ` ${Math.round(progress * 100)}%` : '';
  const meta: Record<ModelState, { cls: string; text: string }> = {
    checking: { cls: 'banner-info', text: '正在检查本机模型…' },
    ready: { cls: 'banner-ok', text: '本机模型就绪' },
    downloading: { cls: 'banner-info', text: `正在下载模型…${pct}` },
    downloadable: { cls: 'banner-info', text: '本机模型尚未下载' },
    unavailable: { cls: 'banner-warn', text: '本设备不支持本机模型' },
    unsupported: { cls: 'banner-warn', text: '需要 Chrome 138+ 并开启 Prompt API' },
  };
  const m = meta[model];
  const warn = model === 'unavailable' || model === 'unsupported';
  const ready = model === 'ready';

  return (
    <>
      <div className={`banner ${m.cls}${ready ? ' banner-ready' : ''}`}>
        <span className="status">
          <span className={`dot dot-${model}`} />
          {m.text}
        </span>
        {model === 'downloadable' && (
          <button type="button" className="add add-compact" onClick={onDownload}>
            下载
          </button>
        )}
      </div>
      {warn && (
        <p className="hint hint-inline">
          话题与规则过滤需要 Gemini Nano；屏蔽作者不需要模型也能用。
        </p>
      )}
    </>
  );
}

export default App;
