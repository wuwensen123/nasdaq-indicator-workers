# 三个 P0 数据口径缺口修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复三个数据口径缺口：① Baa 收益率改为 FRED 每日真值（API key 可选，失败回退 JPM 锚）；② 银行 `pb_pct_hist` 由共享的中证银行指数分位改为个股自身历史 PB 分位（东财，2018 至今）；③ QQQ/VOO 的 Forward PE 评分由静态锚点表×0.88 近似改为 2001/1990 至今的真实周度序列动态分位（historyofmarket.com）。

**Architecture:** 三个独立数据源接入，全部走"fetcher 抓取 → 计算/缓存 → analyzer 消费"现有模式。银行 PB 历史因为请求量大（3 家 × 9 年 = 27 个子请求，超 refresh 单次配额）改为 **D1 缓存 + scheduled 更新 + 部署时预热灌库**；Forward PE 历史一次请求拿到全序列（61KB），内存 6h 缓存即可；Baa 走 FRED 官方 API（key 可选），无 key/失败时维持 JPM 锚兜底。

**Tech Stack:** Cloudflare Workers (ESM + fetch)、D1（新表 `valuation_cache`）、node:test、东财 datacenter API、historyofmarket.com JSON API、FRED api.stlouisfed.org。

**Spec:** `docs/superpowers/specs/2026-11-11-qqq-voo-strategic-upgrade-design.md` §3.2/§5 与本会话核验结论（见下方"数据源可行性与校准结论"章节）。

## 数据源可行性与校准结论（2026-11-12 实测）

| 缺口 | 源 | 实测结论 | 校准 |
|---|---|---|---|
| Baa | FRED `api.stlouisfed.org/fred/series/observations?series_id=DBAA&file_type=json` | 本机可到（400 需 key）；`fred.stlouisfed.org` CSV 本机 000 / Workers 出口 520 | 需免费 API key（Worker secret `FRED_API_KEY`）；无 key 回退 JPM 锚 6.26% + 10Y 调整 |
| 银行 PB 历史 | 东财 `datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_VALUEANALYSIS_DET` | 200 可达；`filter=(SECURITY_CODE="601288")(TRADE_DATE>='2018-01-01')(TRADE_DATE<='2018-12-31')&pageSize=500&sortColumns=TRADE_DATE&sortTypes=1` → 2018 全年 243 行、1 页；每日一条 PB_MRQ、无缺口；验证前 500 行=500 交易日 | 2018-01-02 起，每年 1 请求；分位=当前 PB 在全历史序列中的 rank/n |
| NDX/SPX Forward PE 历史 | `https://historyofmarket.com/api/{ndx,sp500}/forward-pe.json`（CC BY 4.0，AI 用途明确允许） | 200 可达、61-76KB；`forward`（terminal 12M blended-forward consensus，周度）：NDX 2001-04-27→2026-08-05 共 1239 点、SPX 1990-06-29→2026-08-05 共 1495 点；`forwardOwn`（持仓加权，日更）：2026-08-05 起，与 terminal 重叠点差 0.18%（NDX 22.41 vs 22.37）/0.6%（SPX）——**两序列同口径连续**，合并即得完整序列 | 当前值 StockAnalysis 与 forwardOwn 差：NDX 19.80 vs 19.56（+1.2%）、SPX 18.53 vs 18.47（+0.3%）→ 用 StockAnalysis 当日值对该合并序列打动态分位 |

NDX forward 序列分布（2001-2026）：min 11.2 / p5 13.1 / p25 17.5 / p50 20.3 / p75 26.1 / p95 31.5 / max 82.0
SPX forward 序列分布（1990-2026）：min 9.5 / p5 12.2 / p25 14.7 / p50 16.8 / p75 20.3 / p95 23.0 / max 25.3

## Global Constraints

- 免费版 Workers 单次调用子请求上限 50：refresh 流程**不得**新增超过 3 个常驻子请求；银行 PB 历史全量更新只允许发生在 scheduled 或预热阶段，refresh 只读 D1。
- 现有 JPM 锚/静态表逻辑全部保留为 fallback，任何新数据源失败都必须有兜底路径，指标分值不得因新源失败而变 null 导致 coverage 突降。
- `wrangler.toml`、`credentials.md`、`.env` 含 secrets，绝不提交；FRED key 通过 `env.FRED_API_KEY`（Worker secret）注入，不硬编码。
- 新数据都需要 `source` 与 `updated_at`/`as_of` 回传，前端弹窗已支持展示。
- 中文界面文案、注释沿用现有风格。

## Review Focus

1. historyofmarket 返回 404/解析失败（格式变化）时，forward_pe 必须回退静态锚点表而非报错拖垮整个 refresh —— 测试覆盖。
2. 东财接口在 Workers 出口被拒（如 520/超时）时，银行 PB 分位缺数据 → coverage <90% → 强制 1x（现有保护），不得抛异常中断全部 targets —— 测试覆盖。
3. forwardOwn 与 forward 重叠日期的去重：合并序列不得出现重复日期，且顺序保持升序 —— 测试覆盖。
4. FRED API 无 key 或 key 无效时：`getBaaYield` 必须返回 `{value:null}` 让 analyzer 走现有 JPM 锚回退，不得 throw —— 测试覆盖。
5. 银行分位缓存过期/缺失时 refresh 行为：读 D1 失败返回 null → 该指标 N/A → coverage 兜底，不允许 refresh 现场发 27 个请求。

---

### Task 1: D1 估值缓存表 + 通用读写

**Files:**
- Modify: `worker/src/index.js`（initDB 增加建表）
- Create: `worker/src/fetchers.js` 内新增 `getValuationCache(env, key)` / `setValuationCache(env, key, data)` 方法
- Test: `worker/test/fetchers.test.mjs`

**Interfaces:**
- Consumes: `env.nasdaq_cache`（现有 D1 binding）
- Produces:
  - `initDB` 建 `valuation_cache(key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)`
  - `Fetcher.getValuationCache(env, key)` → `{data: any, fetched_at: string} | null`
  - `Fetcher.setValuationCache(env, key, data)` → void（INSERT ... ON CONFLICT(key) DO UPDATE）

- [ ] **Step 1: 写失败测试**

```js
// fetchers.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
const fetcher = new Fetcher();
const fakeEnv = {
  nasdaq_cache: { prepare: (sql) => sql.includes('SELECT') ? { first: async () => ({ data: '{"pb":1.0}', fetched_at: '2026-11-12T00:00:00Z' }) } : { run: async () => ({}) }, bind: () => ({ run: async () => ({}) }) },
};
test('getValuationCache reads stored value', async () => {
  const r = await fetcher.getValuationCache(fakeEnv, 'bank_pb_pct:abc_bank');
  assert.equal(r.data.pb, 1.0);
});
test('setValuationCache writes on conflict', async () => {
  assert.doesNotReject(() => fetcher.setValuationCache(fakeEnv, 'k', { a: 1 }));
});
```

- [ ] **Step 2: 运行确认失败**（方法不存在 → TypeError）
- [ ] **Step 3: 在 `fetchers.js` 实现两个方法 + `index.js` initDB 建表**（建表 SQL 与现有 market_cache 风格一致）

```js
async getValuationCache(env, key) {
  if (!env?.nasdaq_cache) return null;
  const r = await env.nasdaq_cache.prepare('SELECT data, updated_at FROM valuation_cache WHERE key = ?').bind(key).first();
  return r ? { data: JSON.parse(r.data), fetched_at: r.updated_at } : null;
}
async setValuationCache(env, key, data) {
  if (!env?.nasdaq_cache) return;
  await env.nasdaq_cache.prepare(
    'INSERT INTO valuation_cache (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
  ).bind(key, JSON.stringify(data), new Date().toISOString()).run();
}
```

- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: 提交** `chore: D1 valuation_cache 表与通用读写`

---

### Task 2: 银行个股 PB 历史分位（东财 + D1 缓存）

**Files:**
- Modify: `worker/src/fetchers.js`（新增 `getBankPbHistory`、`buildBankPbPercentiles`、`getBankPbPercentile`）
- Modify: `worker/src/index.js`（`fetchFreshData(env)` 传 env、targetsData 注入 `pb_pct_hist`、scheduled 7:30 调 `refreshBankPbPercentiles`）
- Modify: `worker/src/analyzer.js`（`pb_pct_hist` 分支：优先个股分位）
- Test: `worker/test/fetchers.test.mjs`、`worker/test/analyzer.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `getValuationCache`/`setValuationCache`；东财接口
- Produces:
  - `Fetcher.getBankPbHistory(code, year)` → `[{date:'2018-01-02', pb:1.67437005}, ...]`（当年 1 页至多 500 行，升序）
  - `Fetcher.refreshBankPbPercentiles(env)` → `{updated: {abc_bank: true, ...}}`：对 3 家银行×2018..今年并发，合并历史（覆盖策略见下），算分位，写 D1 三个 key
  - `Fetcher.getBankPbPercentile(env, targetId, code)` → `{pct: 0-1, current_pb, count, median, source, updated_at} | null`
  - `analyzer.js` `pb_pct_hist` 分支读 `td.pb_pct_hist`（为新结构），无则回退现有 `_jq`/danjuan
  - 银行→东财代码映射：`{abc_bank: '601288', ccb_bank: '601939', cmb_bank: '600036'}`（fetchers.js 内常量 `BANK_EM_CODES`）

**合并与分位逻辑（实现唯一确定）：**
- 历史序列缓存存 `bank_pb_hist:{id}` = `{points:[{d:'2026-11-12',pb:0.909581}...]}`；刷新时逐年：若缓存中已含该年内数据（`points.some(p=>p.d.startsWith(year))`）则跳过该年请求，否则请求该年追加（升序排序去重按 d）。
- 分位：`pct = sortedValues.filter(v => v <= current).length / n`（current 取最新点 `points[points.length-1].pb` 与腾讯报价取 min？——不：**取历史最新点即可**，与腾讯即时报价差异 <0.5% 且标准一致）。
- 缓存写入 `bank_pb_pct:{id}` = `{pct, current_pb, count, median, source:'东方财富估值分析(RPT_VALUEANALYSIS_DET,2018至今)', updated_at}`。

- [ ] **Step 1: 写失败测试**（历史解析 + 分位 + 缓存回退）

```js
// 测试 1：逐年抓取解析（用 2018 年已存样本断言结构）
const f = await fetcher.getBankPbHistory('600036', '2018');
assert.ok(Array.isArray(f) && f.length > 200);
assert.equal(f[0].date, '2018-01-02');

// 测试 2：分位计算（构造 100 个点在 1-10 均匀分布，current=3 → pct=0.30±0.02）
// 测试 3：getBankPbPercentile 缓存缺失返回 null、命中返回结构
```

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现 fetchers.js 三个方法**（东财 URL 模板照抄下方，headers 带 UA）

```
https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_VALUEANALYSIS_DET&columns=TRADE_DATE,PB_MRQ&filter=(SECURITY_CODE%3D%22{code}%22)(TRADE_DATE%3E%3D%27{year}-01-01%27)(TRADE_DATE%3C%3D%27{year}-12-31%27)&pageSize=500&sortColumns=TRADE_DATE&sortTypes=1
```

- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: analyzer `pb_pct_hist` 分支改优先个股**（`td.pb_pct_hist` → `{value: td.pb, score: round(pct*100), source, description:'个股自身历史PB分位(2018至今)'}`；缺时回退老逻辑，description 不变）
- [ ] **Step 6: index.js 接线**：`fetchFreshData(env)`；`targetsData[t.id].pb_pct_hist = await fetcher.getBankPbPercentile(env, t.id, BANK_EM_CODES[t.id])`（Promise.all 里，缺 null 不影响）；scheduled 7:30 分支加 `await fetcher.refreshBankPbPercentiles(env)`
- [ ] **Step 7: 测试**：`npm test` 全量 + 手工断言 analyzer 对 abc_bank 的 `pb_pct_hist` 分位与老 index 值不同且 ≈ 个股真实分位
- [ ] **Step 8: 提交** `feat: 银行PB历史分位改个股口径(东财2018至今)+D1缓存`

---

### Task 3: NDX/SPX Forward PE 动态分位（historyofmarket）

**Files:**
- Modify: `worker/src/fetchers.js`（`getForwardPEHistory(series)`、`_mergeFwdSeries`）
- Modify: `worker/src/analyzer.js`（`forward_pe` 分支用动态分位，静态表降为 fallback）
- Modify: `worker/src/index.js`（fetchFreshData 抓 2 个序列注入 global）
- Test: `worker/test/fetchers.test.mjs`、`worker/test/analyzer.test.mjs`

**Interfaces:**
- Consumes: 现有 `getForwardPE`（StockAnalysis 当日值）
- Produces:
  - `Fetcher.getForwardPEHistory('ndx'|'spx')` → `{series:[{date,value}...升序], currentOwn, updated_at, source:'historyofmarket.com'}`；内存缓存 6h（`this._fwdHistCache = {}`）；多 key 可并行
  - `_mergeFwdSeries(fwd, fwdOwn)`：以 `fwd` 为底，追加 `fwdOwn` 中 `date > 最后一条 fwd.date` 的点（重叠日保留 fwdOwn 值），输出升序去重
  - `_pctInSeries(value, series)` → 0-1：`sorted=series.values.sort()`，`i=lowerBound(sorted, value)`，`i/n`（含边界：value<=min→0、value>=max→1）
  - analyzer `forward_pe`：`td.forward_pe` 不变；系列取 `global.fwd_pe_hist`（`{ndx:{...}, spx:{...}}`），按 `cfg.pe_family==='ndx'?'ndx':'spx'` 选；`score = round(_pctInSeries(v, series)*100)`；系列缺失 → 现有静态表逻辑（PE_FWD_PCT_NDX/SPX）；`source` 标注 `StockAnalysis.com 当日值 / 历史分位: historyofmarket.com(2001/1990至今)`

- [ ] **Step 1: 写失败测试**

```js
// 合并去重
const series = fetcher._mergeFwdSeries(
  [ {date:'2026-08-04', value:22.4}, {date:'2026-08-05', value:22.37} ],
  [ {date:'2026-08-05', value:22.41}, {date:'2026-08-06', value:22.25} ]
);
assert.deepEqual(series.map(p=>p.date), ['2026-08-04','2026-08-05','2026-08-06']);

// 分位（lowerBound index / n，float 用近似断言）
assert.ok(Math.abs(fetcher._pctInSeries(3, [{date:'a',value:1},{date:'b',value:4},{date:'c',value:6}]) - 1/3) < 1e-9);
assert.equal(fetcher._pctInSeries(0.5, [{date:'a',value:1}]), 0);
assert.equal(fetcher._pctInSeries(9, [{date:'a',value:1}]), 1);

// 抓取解析（真实网络，node:test 异步，超时 20s）
const ndx = await fetcher.getForwardPEHistory('ndx');
assert.ok(ndx.series.length > 1200);
assert.ok(ndx.series[ndx.series.length-1].date > '2026-08-01');

// analyzer fallback：系列缺失时 forward_pe 走静态锚点表而非 null
// （analyzer.test.mjs）构造 global.fwd_pe_hist 缺失 + td.forward_pe 有值
assert.ok(result.indicators.find(i => i.name === 'Forward P/E').score != null);
```

- [ ] **Step 2: 运行确认失败**（两个测试：merge 方法不存在 + 分位函数不存在）
- [ ] **Step 3: 实现 fetcher 与 analyzer 修改**（公式见 Interfaces；`globalData.fwd_pe_hist = await Promise.all({ndx, spx 两系列})` 并行抓取，失败条目为 null 不阻塞）
- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: 提交** `feat: Forward PE 历史分位改动态真分位(historyofmarket 2001/1990至今)`

---

### Task 4: Baa 每日真值（FRED API key 可选）

**Files:**
- Modify: `worker/src/fetchers.js`（`getBaaYield()` 支持 `env.FRED_API_KEY`）
- Modify: `worker/src/index.js`（`getBaaYield(env)` 传参）
- Test: `worker/test/fetchers.test.mjs`

**Interfaces:**
- Consumes: `env.FRED_API_KEY`（可选 secret）
- Produces: `Fetcher.getBaaYield(env)` → `{value, source, updated_at}`；无 key 或请求失败 → `{value:null, source:'FRED (DBAA)', updated_at}`（**不 throw**），analyzer 现有 JPM 锚回退不变

- [ ] **Step 1: 写失败测试**（fake env 有 key → 请求被发出并解析；无 key → null 不抛）

```js
// 用真实 key 不可用时的行为：
const noKey = await fetcher.getBaaYield({});
assert.equal(noKey.value, null);
// key 无效时（假）不 throw：
assert.doesNotReject(() => fetcher.getBaaYield({ FRED_API_KEY: 'bad' }));
```

- [ ] **Step 2: 运行确认失败**（现在 `getBaaYield()` 无 env 参数且可能 throw）
- [ ] **Step 3: 实现**：key 存在时请求 `https://api.stlouisfed.org/fred/series/observations?series_id=DBAA&file_type=json&sort_order=desc&limit=1&api_key={key}`；解析 `observations[0].value`（数字串或 '.' 视为 null）；任一步失败 catch → 返回 null 结构；`FRED_API_KEY` 从 `env` 取（`env.FRED_API_KEY || env?.FRED_API_KEY ?? null`）
- [ ] **Step 4: 运行测试确认通过**
- [ ] **Step 5: 提交** `feat: Baa 支持 FRED API key 每日真值，无key回退JPM锚`

---

### Task 5: 部署、预热、生产验证

**Files:**
- 无新增代码（部署与数据灌入）

**Interfaces:**
- Consumes: Task 1-4 全部；`wrangler.toml` 现有 binding；Cloudflare D1
- Produces: 生产环境验收记录（写入 `docs/superpowers/reports/2026-11-12-data-veracity-verification.md`）

- [ ] **Step 1: 本地全量测试** `cd worker && npm test`（含网络用例，全部 pass）
- [ ] **Step 2: 本地预热脚本**（不提交仓库，放 `worker/tmp_warmup.js` 单个文件）：node 直接调东财 3 家×9 年取全序列→本地算分位→输出 3 条 `INSERT INTO valuation_cache ...` SQL 文件 `worker/tmp_warmup.sql`；`npx wrangler d1 execute nasdaq_cache --remote --file=tmp_warmup.sql`（库名以 wrangler.toml 为准）；执行后删两个临时文件（gitignore 已有 tmp 惯例，仍手动清理）
- [ ] **Step 3: 部署** `npx wrangler deploy`（成功后记录版本号）
- [ ] **Step 4: 生产验证**
  - `curl /api/refresh` 检查：三家银行 `pb_pct_hist` 出现 `个股PB分位(2018至今)` 且三值不同（资产侧真分位）；QQQ/VOO `forward_pe` 分数由动态分位给出（QQQ 预期 ~42-50、VOO ~55-65，与旧值 39.0/63.69 对比记录）；`baa_yield` 若无 key 仍 null（预期），`ey_spread_baa` 走 JPM 锚标注不变
  - 覆盖率：11 标的全 100%；无 JS 错误（前端 index.html 已支持 source 展示，无需改）
- [ ] **Step 5: 写验收报告** `docs/superpowers/reports/2026-11-12-data-veracity-verification.md`：before/after 数值表、数据源、校准说明、遗留（FRED key 待用户注册则 Baa 仍为锚点近似）
- [ ] **Step 6: 提交** `docs: v2.3.0 数据口径修复验收报告` + `git tag v2.3.0 && git push --tags`