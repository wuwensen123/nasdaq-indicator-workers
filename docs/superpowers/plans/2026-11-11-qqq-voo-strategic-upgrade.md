# QQQ/VOO 战略评分升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 QQQ/VOO 增加可见的战术情绪层，并在战略评分中补上 Forward P/E 与 EY spread vs Baa，同时修正 QQQ 的 S&P CAPE 权重。

**Architecture:** 数据层新增 Yahoo `forwardPE`、FRED `DBAA`、Yahoo `^VIX3M` 三个输入；分析层把 VIX/F&G 限定在 `tactical` 对象（只影响定投倍数），把 Forward P/E / EY spread 加入 `_strategicScore`；前端在 QQQ/VOO 弹窗单独渲染战术区块。战略评分与战术层严格分离。

**Tech Stack:** Cloudflare Workers、ESM JavaScript、SheetJS（已有）、Node `node:test`、Bootstrap 单页前端。

**Spec:** `docs/superpowers/specs/2026-11-11-qqq-voo-strategic-upgrade-design.md`

## Global Constraints

- VIX/F&G 不得进入 `composite_score`；只允许影响 `strategy.multiple`。
- 1x 底仓不得因贪婪或任何战术系数降到 1x 以下。
- 新数据源失败时返回 null，不得抛异常阻塞 `/api/data`。
- 不提交任何密钥；`wrangler.toml`、`credentials.md` 已被 gitignore。
- 每次部署前必须 `node --test` 全绿；部署后必须刷新生产并核对 QQQ/VOO 数值。
- 用户已选择「战术模块 + 战略补强（推荐）」，不再把 VIX/F&G 加进战略评分。

## Review Focus

- **Yahoo forwardPE 缺失/为 0**：QQQ/VOO 仍应正常出分，`forward_pe` 指标显示 N/A，权重重新归一化。
- **FRED DBAA 返回 520/空 CSV**：`ey_spread_baa` 为 N/A，其他指标不受影响；不得让 `NaN` 进入综合分。
- **VIX3M 缺失或为 0**：战术块显示 N/A，`tactical.coeff` 仍按 F&G 计算；不得出现 `Infinity`。
- **极端 F&G + VIX 倒挂叠加**：系数上限 1.5，前端倍数按 0.25 档位取整；1x 底仓不被降到 1x 以下。
- **旧缓存/旧前端**：部署后 `/api/data` 必须返回新字段；前端刷新后不得因 `target.tactical` 为 undefined 报错。

---

### Task 1: 数据层新增 VIX3M、Forward P/E、Baa 收益率

**Files:**
- Modify: `worker/src/fetchers.js`
- Modify: `worker/src/index.js`
- Test: `worker/test/fetchers.test.mjs`

**Interfaces:**
- Consumes: 现有 `fetchJSON`, `fetchText`, `getYahooAuth`, `round`, `now`。
- Produces:
  - `fetchYahooPE(symbol) -> Promise<{ trailing: number|null, forward: number|null }>`（模块内函数）
  - `Fetcher.getPERatio(symbol, name?) -> Promise<{ value, forward_pe, source, updated_at, name }>`
  - `Fetcher.getForwardPE(symbol) -> Promise<{ value, source: 'StockAnalysis.com', updated_at }>`
  - `Fetcher.getVIX3M() -> Promise<{ value, change, source, updated_at }>`
  - `Fetcher.getBaaYield() -> Promise<{ value, source, updated_at }>`
  - `globalData.vix3m`, `globalData.baa_yield`
  - `targetsData[id].forward_pe`

- [ ] **Step 1: 写失败测试（Yahoo forwardPE 解析）**

```js
// worker/test/fetchers.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Fetcher } from '../src/fetchers.js';

test('getPERatio returns trailing and forward PE from Yahoo summaryDetail', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('getcrumb')) return new Response('crumb123', { status: 200 });
    if (String(url).includes('fc.yahoo.com')) return new Response('', { status: 200 });
    return new Response(JSON.stringify({
      quoteSummary: { result: [{ summaryDetail: {
        trailingPE: { raw: 27.98 }, forwardPE: { raw: 25.5 },
      } }] },
    }), { status: 200 });
  };
  const f = new Fetcher();
  const r = await f.getPERatio('QQQ');
  assert.equal(r.value, 27.98);
  assert.equal(r.forward_pe, 25.5);
  assert.equal(r.source, 'Yahoo Finance');
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd worker && node --test test/fetchers.test.mjs`
Expected: FAIL（`forward_pe` 为 undefined，或 `getPERatio` 未返回该字段）。

- [ ] **Step 3: 实现 `fetchYahooPE` 并改造 `getPERatio`**

把 `fetchYahooTrailingPE` 改为 `fetchYahooPE`，同一 `summaryDetail` 请求同时取：
```js
const sd = d?.quoteSummary?.result?.[0]?.summaryDetail;
return { trailing: sd?.trailingPE?.raw ?? null, forward: sd?.forwardPE?.raw ?? null };
```
`getPERatio` 在 Yahoo 分支返回 `{ value: round(trailing), forward_pe: forward != null ? round(forward) : null, source: 'Yahoo Finance', ... }`；worldperatio 兜底分支 `forward_pe: null`。

**生产补充**：实测 Yahoo 对 QQQ/VOO 等 ETF 的 `summaryDetail.forwardPE` 返回空对象 `{}`，因此新增 `getForwardPE(symbol)`，抓取 `https://stockanalysis.com/etf/{symbol.toLowerCase()}/` 的 `Forward PE</td><td...>19.80</td>`；在 `index.js` 中优先使用该值，Yahoo forward 仅作兜底。

- [ ] **Step 4: 写失败测试（VIX3M 与 DBAA）**

```js
test('getVIX3M reads ^VIX3M chart meta', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    chart: { result: [{ meta: { regularMarketPrice: 18.4 }, indicators: { quote: [{ close: [17.9, 18.4] }] } }] },
  }), { status: 200 });
  const r = await new Fetcher().getVIX3M();
  assert.equal(r.value, 18.4);
});

test('getBaaYield reads last non-empty FRED DBAA row', async () => {
  globalThis.fetch = async () => new Response('observation_date,DBAA\n2026-11-07,5.18\n2026-11-10,5.21\n', { status: 200 });
  const r = await new Fetcher().getBaaYield();
  assert.equal(r.value, 5.21);
});
```

- [ ] **Step 5: 实现 `getVIX3M()` 与 `getBaaYield()`**

`getVIX3M` 复用 `getVIX` 的 chart 逻辑，URL 为 `%5EVIX3M`，返回 `{ value, change, source: 'Yahoo Finance (^VIX3M)', updated_at }`；失败返回 value null。
`getBaaYield` 用 `https://fred.stlouisfed.org/graph/fredgraph.csv?id=DBAA` + `UA_PLAIN`，从最后一行往上找第一个非空数值；失败返回 value null。

- [ ] **Step 6: 接线 `index.js`**

在 `fetchFreshData` 的 `Promise.all` 增加 `fetcher.getVIX3M()`、`fetcher.getBaaYield()`，写入：
```js
vix3m,
baa_yield: baaYield,
```
在 `targetsData` 构造里增加 `forward_pe: peMap[t.id]?.forward_pe ?? null`。

- [ ] **Step 7: 运行测试并提交**

Run: `cd worker && node --test test/fetchers.test.mjs`
Expected: PASS。
```bash
git add worker/src/fetchers.js worker/src/index.js worker/test/fetchers.test.mjs
git commit -m "feat: add VIX3M, forward PE, Baa yield data sources"
```

---

### Task 2: 分析层战术信号与 `tactical` 返回对象

**Files:**
- Modify: `worker/src/analyzer.js`
- Test: `worker/test/analyzer.test.mjs`

**Interfaces:**
- Consumes: `global.vix`, `global.vix3m`, `global.fear_greed`, `global.put_call_ratio`。
- Produces:
  - `_tacticalSignals(global) -> { coeff, reason, vix, vix3m, vix_ratio, fear_greed, put_call }`
  - 每个战略结果新增 `tactical`（`cfg.tactical_fg === false` 时为 `null`）。

- [ ] **Step 1: 写失败测试**

```js
// worker/test/analyzer.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Analyzer } from '../src/analyzer.js';

test('tactical signals: fear + VIX backwardation stack, capped at 1.5', () => {
  const a = new Analyzer();
  const r = a._tacticalSignals({ fear_greed: { value: 20 }, vix: { value: 30 }, vix3m: { value: 22 }, put_call_ratio: { value: 1.2 } });
  assert.equal(r.coeff, 1.4375);
  assert.match(r.reason, /恐惧/);
  assert.match(r.reason, /VIX/);
});

test('tactical signals: no extreme returns coeff 1', () => {
  const a = new Analyzer();
  const r = a._tacticalSignals({ fear_greed: { value: 33 }, vix: { value: 19.5 }, vix3m: { value: 20.5 }, put_call_ratio: { value: 1.1 } });
  assert.equal(r.coeff, 1);
  assert.equal(r.vix_ratio, 0.95);
  assert.equal(r.reason, null);
});

test('tactical signals: missing VIX3M does not produce Infinity', () => {
  const a = new Analyzer();
  const r = a._tacticalSignals({ fear_greed: { value: 50 }, vix: { value: 20 }, vix3m: { value: null } });
  assert.equal(r.vix_ratio, null);
  assert.equal(r.coeff, 1);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd worker && node --test test/analyzer.test.mjs`
Expected: FAIL（`_tacticalSignals` not a function）。

- [ ] **Step 3: 实现 `_tacticalSignals`**

在 `_tacticalCoeff` 旁新增；保留 `_tacticalCoeff` 兼容或改为调用新函数。规则：
```js
let coeff = 1; const reasons = [];
if (fg != null && fg <= 25) { coeff *= 1.25; reasons.push(`极度恐惧${round(fg,1)}，恐慌期保持并小幅加快节奏`); }
else if (fg != null && fg >= 75) { coeff *= 0.75; reasons.push(`极度贪婪${round(fg,1)}，亢奋期小幅放慢节奏`); }
if (vix != null && vix3m != null && vix3m > 0) {
  vixRatio = round(vix / vix3m, 2);
  if (vixRatio > 1.15) { coeff *= 1.15; reasons.push(`VIX/VIX3M ${vixRatio}>1.15，短期压力确认`); }
}
coeff = Math.max(0.5, Math.min(1.5, round(coeff, 3)));
```
返回 `{ coeff, reason: reasons.join('；') || null, vix, vix3m, vix_ratio, fear_greed: fg, put_call: pc }`。

- [ ] **Step 4: 在 `_analyzeStrategic` 接入**

把 `_tacticalCoeff(global.fear_greed?.value)` 替换为 `_tacticalSignals(global)`；`_applyTactical(base, coeff, reason)` 不变。返回值增加：
```js
tactical: cfg.tactical_fg === false ? null : tactical,
```
并在 `formula_detail` 末尾追加一句：
```js
`｜战术层：VIX/F&G/Put-Call 只在极端时调整倍数，不进入战略评分`
```

- [ ] **Step 5: 运行测试并提交**

Run: `cd worker && node --test test/analyzer.test.mjs`
Expected: PASS。
```bash
git add worker/src/analyzer.js worker/test/analyzer.test.mjs
git commit -m "feat: add tactical sentiment signals separate from strategic score"
```

---

### Task 3: 战略层新增 Forward P/E 与 EY spread vs Baa

**Files:**
- Modify: `worker/src/analyzer.js`
- Modify: `worker/src/fetchers.js`（若 Task 1 未完成）
- Test: `worker/test/analyzer.test.mjs`

**Interfaces:**
- Consumes: `td.forward_pe`, `td.pe_ratio`, `global.baa_yield.value`。
- Produces:
  - `PE_FWD_PCT_NDX`, `PE_FWD_PCT_SPX` 常量
  - `_eySpreadBaaScore(v) -> number`
  - `_strategicScore('forward_pe'|'ey_spread_baa', ...)`
  - QQQ/VOO 新指标与权重

- [ ] **Step 1: 写失败测试**

```js
test('forward PE scores lower than trailing PE for same multiple', () => {
  const a = new Analyzer();
  const qqq = a.targets.find(t => t.id === 'qqq');
  const trailing = a._strategicScore('pe_composite', qqq, { pe_ratio: 25, pe_data: { source: 'Yahoo Finance' } }, {});
  const forward = a._strategicScore('forward_pe', qqq, { forward_pe: 25 }, {});
  assert.ok(forward.score <= trailing.score);
  assert.equal(forward.value, 25);
});

test('EY spread vs Baa: -1% is expensive, +3% is cheap', () => {
  const a = new Analyzer();
  assert.ok(a._eySpreadBaaScore(-1) > 65);
  assert.ok(a._eySpreadBaaScore(3) < 15);
});

test('QQQ/VOO configs include forward_pe and ey_spread_baa with weights summing to 1', () => {
  const a = new Analyzer();
  for (const id of ['qqq', 'voo']) {
    const t = a.targets.find(x => x.id === id);
    assert.ok(t.indicators.includes('forward_pe'));
    assert.ok(t.indicators.includes('ey_spread_baa'));
    const sum = t.indicators.reduce((s, k) => s + t.weights[k], 0);
    assert.equal(Math.round(sum * 100), 100);
  }
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd worker && node --test test/analyzer.test.mjs`
Expected: FAIL（`_eySpreadBaaScore` 不存在 / 指标缺失）。

- [ ] **Step 3: 实现锚点表与评分函数**

```js
// 暂定锚点：SPX forward 19x≈72 分位（JPM 30年均值17.2x）；NDX forward 按 trailing 锚点×0.88
const PE_FWD_PCT_SPX = [[10,1],[12,8],[14,22],[15.5,40],[17.2,55],[19,72],[21,85],[23,93],[25,97],[28,99]];
const PE_FWD_PCT_NDX = [[8.8,0],[13.2,8],[17.6,28],[22,50],[24.4,65],[26.4,75],[29,85],[31.7,93],[33.9,99]];

_eySpreadBaaScore(v) {
  if (v >= 3) return 10;
  if (v >= 2) return 10 + (3 - v) * 10;
  if (v >= 1) return 20 + (2 - v) * 15;
  if (v >= 0.7) return 35 + (1 - v) / 0.3 * 7;
  if (v >= 0) return 42 + (0.7 - v) / 0.7 * 13;
  if (v >= -1) return 55 + (-v) * 17;
  if (v >= -2) return 72 + (-1 - v) * 13;
  return Math.min(95, 85 + (-2 - v) * 5);
}
```

- [ ] **Step 4: 增加 `_strategicScore` 分支与标签**

```js
if (key === 'forward_pe') {
  const v = td.forward_pe;
  const tbl = cfg.pe_family === 'spx' ? PE_FWD_PCT_SPX : PE_FWD_PCT_NDX;
  return { value: v, score: v != null ? round(this._pctFromAnchors(v, tbl)) : null, source: td.pe_data?.source ?? null, as_of: td.pe_data?.updated_at ?? null };
}
if (key === 'ey_spread_baa') {
  const pe = td.forward_pe ?? td.pe_ratio;
  const baaRaw = global.baa_yield?.value ?? null;
  const baa = baaRaw != null ? baaRaw
    : (global.treasury_10y?.value != null ? round(BAA_ANCHOR + (global.treasury_10y.value - BAA_ANCHOR_TREASURY), 2) : null);
  const src = baaRaw != null ? (global.baa_yield?.source ?? null) : (baa != null ? 'JPM锚(2026-09-30)+10Y调整' : null);
  if (pe == null || pe <= 0 || baa == null) return { value: null, score: null, unit: '%', source: src };
  const v = round(100 / pe - baa, 2);
  return { value: v, score: round(this._eySpreadBaaScore(v)), unit: '%', source: src };
}
```
`BAA_ANCHOR = 6.26`、`BAA_ANCHOR_TREASURY = 5.3`（JPM Guide 2026-09-30 implied Baa）。
`_mkInd` 透传 `source/as_of`；`_indName`/`_indInfo` 增加：
- `forward_pe: 'Forward P/E'`，描述「未来12个月预期市盈率（Yahoo forwardPE），与trailing PE互补」
- `ey_spread_baa: 'EY spread vs Baa'`，描述「盈利收益率−穆迪Baa公司债收益率（JPM估值表口径）；负值=股票相对信用债偏贵」

- [ ] **Step 5: 更新 QQQ/VOO 配置**

```js
// QQQ
indicators: ['pe_composite', 'cape', 'forward_pe', 'erp_real', 'ey_spread_baa', 'ma200_risk'],
weights: { pe_composite: 0.30, cape: 0.15, forward_pe: 0.15, erp_real: 0.20, ey_spread_baa: 0.10, ma200_risk: 0.10 },
// VOO
indicators: ['pe_composite', 'cape', 'forward_pe', 'erp_real', 'ey_spread_baa', 'ma200_risk'],
weights: { pe_composite: 0.15, cape: 0.35, forward_pe: 0.10, erp_real: 0.20, ey_spread_baa: 0.10, ma200_risk: 0.10 },
```
更新 `method_note`，说明 QQQ 的 CAPE 是 S&P 代理、已降权；VOO 的 CAPE 仍是主锚。

- [ ] **Step 6: 运行测试并提交**

Run: `cd worker && node --test test/analyzer.test.mjs`
Expected: PASS。
```bash
git add worker/src/analyzer.js worker/test/analyzer.test.mjs
git commit -m "feat: add forward PE and EY spread vs Baa to QQQ/VOO scoring"
```

---

### Task 4: 前端战术情绪区块与数据源显示

**Files:**
- Modify: `frontend/index.html`
- Test: 手工浏览器验证（无前端测试框架）

**Interfaces:**
- Consumes: `target.tactical`（Task 2）、`ind.source` / `ind.as_of`（Task 3）。
- Produces: QQQ/VOO 弹窗中的「战术情绪（不计入战略评分）」区块。

- [ ] **Step 1: 在 `showTargetDetail` 中构造 `tacticalHtml`**

```js
const t = target.tactical;
const tacticalHtml = t ? `
<div class="mt-3">
  <h6 style="color:var(--text-primary);margin-bottom:8px;">战术情绪（不计入战略评分）</h6>
  <div style="background:rgba(0,0,0,0.02);border:1px solid var(--border-color);border-radius:8px;padding:12px;font-size:0.85rem;">
    <div>VIX：${t.vix ?? '--'}　CNN F&G：${t.fear_greed ?? '--'}　Put/Call：${t.put_call ?? '--'}　VIX/VIX3M：${t.vix_ratio ?? '--'}</div>
    <div class="mt-1">当前战术系数：<b>${t.coeff}</b>${t.reason ? `（${t.reason}）` : '（无极端信号）'}</div>
    <div class="text-secondary mt-1">规则：F&G≤25 → 加速部分×1.25；F&G≥75 → ×0.75；VIX/VIX3M>1.15 → ×1.15；1x底仓不减速。</div>
  </div>
</div>` : '';
```
插入到 `indicatorsHtml` 之后、`formula-box` 之前。

- [ ] **Step 2: 指标行显示来源**

在 `indicatorsHtml` 的模板里，值后面追加：
```js
${ind.source ? `<span class="text-secondary" style="font-size:0.7rem;">（${ind.source}${ind.as_of ? ' · ' + ind.as_of.slice(0, 10) : ''}）</span>` : ''}
```
只对 `source` 存在的指标显示，避免影响现有布局。

- [ ] **Step 3: 浏览器验证**

Run: `cd frontend && python -m http.server 8080`（或直接用生产页面）
Expected: 打开 QQQ 弹窗，看到战术区块；VIX 19.46 / F&G 33.37 / Put-Call 1.1 / VIX3M 比值；无 JS 控制台错误。

- [ ] **Step 4: 提交**

```bash
git add frontend/index.html
git commit -m "feat: show tactical sentiment block in QQQ/VOO detail modal"
```

---

### Task 5: 部署、生产核验与数据审计

**Files:**
- Modify: `worker/package.json`（加 `test` script）
- Create: `docs/superpowers/reports/2026-11-11-qqq-voo-verification.md`

**Interfaces:**
- Consumes: 前四个任务的产物。
- Produces: 生产版本、核验报告。

- [ ] **Step 1: 加 test script 并跑全量测试**

`worker/package.json`:
```json
"scripts": { "dev": "wrangler dev", "deploy": "wrangler deploy", "test": "node --test test/*.test.mjs" }
```
Run: `cd worker && npm test`
Expected: 所有测试 PASS。

- [ ] **Step 2: 本地干跑打包**

Run: `cd worker && npx wrangler deploy --dry-run --outdir=.wrangler/dryrun`
Expected: 打包成功，gzip 体积 < 1MB。

- [ ] **Step 3: 部署 Worker 与 Pages**

```bash
cd worker && CLOUDFLARE_API_TOKEN='<CF_API_TOKEN>' npx wrangler deploy --env=""
cd .. && CLOUDFLARE_API_TOKEN='<CF_API_TOKEN>' npx wrangler pages deploy frontend --project-name nasdaq-indicator
```

- [ ] **Step 4: 刷新生产并记录新旧评分**

```bash
curl -s "https://api.motris.dpdns.org/api/refresh" -o /tmp/after.json
```
从 `/tmp/after.json` 提取 qqq/voo 的 `composite_score`、`strategy.multiple`、`tactical`、`forward_pe`、`ey_spread_baa`；与部署前旧值对比。

- [ ] **Step 5: 写核验报告**

`docs/superpowers/reports/2026-11-11-qqq-voo-verification.md` 包含：
- 旧值 vs 新值表（QQQ/VOO）
- 数据源：Yahoo trailing/forward PE、multpl CAPE、FRED DFII10/DBAA、Yahoo ^VIX/^VIX3M、CNN F&G
- 已知差异：trailing vs forward、S&P CAPE vs NDX PE、日期差
- 其他标的的数据核对清单（GLD/HSI/红利/银行/长电/紫金）及结果

- [ ] **Step 6: 提交、打 tag、推送**

```bash
git add worker/package.json docs/superpowers/reports/2026-11-11-qqq-voo-verification.md
git commit -m "chore: QQQ/VOO scoring verification report"
git tag v2.2.0
GIT_TERMINAL_PROMPT=0 GIT_TOKEN='<GITHUB_TOKEN>' git push "https://${GIT_TOKEN}@github.com/wuwensen123/nasdaq-indicator-workers.git" main --tags
```

---

## Implementation Notes（实际执行偏差）

- **Forward PE**：Yahoo 对 ETF 返回空 `forwardPE`，实际使用 `StockAnalysis.com` 的 `Forward PE` 行；Yahoo 解析保留为测试/兜底。
- **Baa**：FRED `DBAA` 在 Workers 出口不可用，实际使用 `BAA_ANCHOR=6.26` + `10Y - 5.3` 的 JPM 锚调整。
- **A股数据**：东财 PB 偶发空 data、Yahoo `.SS` 技术指标偶发失败，实际改为「腾讯快照（PB/PE/股息率）+ 腾讯未复权日线（MA200/52周）」优先，东财/Yahoo 兜底；同一 refresh 内腾讯快照缓存。
- **数据覆盖保护**：新增 `_capForCoverage`，覆盖率 <90% 强制 1x；生产核验时所有标的覆盖率 100%。
- **调试端点**：`/api/debug-yahoo` 与 `/api/debug-tencent` 已在最终版本移除。

## Self-Review

- **Spec coverage:** 战术层（Task 2/4）、Forward P/E（Task 1/3）、EY spread（Task 1/3）、QQQ CAPE 降权（Task 3）、数据源显示（Task 3/4）、核验（Task 5）均有对应任务。
- **Step scan:** 每个步骤有可检查结果；测试先失败再实现；没有 TBD。
- **Type consistency:** `forward_pe`、`baa_yield`、`vix3m`、`tactical` 的命名在数据层、分析层、前端一致。
- **Review Focus:** 五个失败模式均有测试或手工验证步骤；Task 1/2 的测试覆盖 null/缺失，Task 3 覆盖评分边界，Task 4 覆盖 undefined `tactical`，Task 5 覆盖生产旧缓存。
- **Proportion:** 计划长度约等于 spec，代码块只出现在签名/测试/关键公式处。
