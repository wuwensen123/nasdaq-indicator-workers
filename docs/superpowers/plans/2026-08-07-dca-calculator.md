# 定投计算器网站 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 nasdaq-indicator 项目上新增定投回测计算器网站，支持多标的、组合定投、分红、年化收益/XIRR、逐年收益展示，并与现有买入卖出仪表盘互通跳转。

**Architecture:** 
- 后端：在现有 Cloudflare Worker 中新增 `/api/backtest` 端点，从 Yahoo Finance v8/chart API 获取历史价格+分红数据，实现 DCA 回测计算（含分红再投资、XIRR、CAGR）
- 前端：新增 `calculator.html` 页面，提供参数表单、结果表格、图表展示；在现有 `index.html` 和 `calculator.html` 之间添加互跳链接

**Tech Stack:** Cloudflare Workers (JavaScript), D1 Database, Cloudflare Pages, Chart.js, Yahoo Finance API

## Global Constraints

- 复用现有 Worker 的 fetchers.js（已有 Yahoo Finance v8/chart API 访问）
- 回测计算需包含分红（dividends）与再投资
- XIRR 用牛顿法迭代求解
- 前端保持深色主题，与现有仪表盘风格一致
- 两个页面通过相对链接互跳：`/`（仪表盘）和 `/calculator.html`（计算器）
- 部署后绑定自定义域名 motris.dpdns.org

---

## 文件结构

| 文件 | 修改内容 |
|------|---------|
| `worker/src/fetchers.js` | 新增 `getHistoricalPrices`（含分红）方法 |
| `worker/src/backtest.js` | 新增 DCA 回测计算引擎（含 XIRR、CAGR、逐年收益） |
| `worker/src/index.js` | 新增 `/api/backtest` 路由 |
| `frontend/calculator.html` | 新增定投计算器页面 |
| `frontend/index.html` | 添加跳转到计算器的链接 |
| `frontend/calculator.html` | 添加跳转到仪表盘的链接 |
| `worker/wrangler.toml` | 无需修改（定时任务不变） |

---

### Task 1: 新增历史价格+分红获取方法

**Files:**
- Modify: `worker/src/fetchers.js`

**Interfaces:**
- Produces: `Fetcher.getHistoricalPrices(symbol, startDate, endDate)` → `{ dates: [], prices: [], dividends: {} }`

**分析：** Yahoo Finance v8/chart API 支持 `includeDividends=true` 参数，返回 `indicators.adjclose` 和 `events.dividends`。

- [ ] **Step 1: 添加 getHistoricalPrices 方法**

```javascript
async getHistoricalPrices(symbol, startDate, endDate) {
  const start = Math.floor(new Date(startDate).getTime() / 1000);
  const end = Math.floor(new Date(endDate).getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${start}&period2=${end}&interval=1d&events=div%2Csplit&includeAdjustedClose=true`;
  const d = await fetchJSONWithHeaders(url, { 'Referer': 'https://finance.yahoo.com/' });
  const result = d.chart?.result?.[0];
  if (!result) return { dates: [], prices: [], dividends: {} };
  const timestamps = result.timestamp || [];
  const adjclose = result.indicators?.adjclose?.[0]?.adjclose || [];
  const dividends = result.events?.dividends || {};
  return {
    dates: timestamps.map(ts => new Date(ts * 1000).toISOString().slice(0, 10)),
    prices: adjclose,
    dividends, // { timestamp: { amount } }
  };
}
```

- [ ] **Step 2: 提交**

```bash
git add worker/src/fetchers.js
git commit -m "feat: add getHistoricalPrices with dividends"
```

---

### Task 2: 新增 DCA 回测计算引擎

**Files:**
- Create: `worker/src/backtest.js`

**Interfaces:**
- Produces: `backtest(config)` → 回测结果对象
  - `config`: `{ assets: [{symbol, weight}], amount, frequency, startDate, endDate }`
  - 返回: `{ totalInvested, finalValue, multiple, cagr, xirr, yearly: [{year, return, totalValue}] }`

**分析：** 
- DCA 定投：按频率（每月/每周/每季度）在指定日期投资指定金额
- 按权重分配到各标的
- 分红再投资：每次分红自动按当日价格买入更多份额
- CAGR：`(finalValue/totalInvested)^(1/years) - 1`
- XIRR：现金流（投入为负，期末为正值）的 IRR，用牛顿法迭代

- [ ] **Step 1: 实现 XIRR（牛顿法）**

```javascript
function xirr(cashflows, dates, guess = 0.1) {
  // cashflows: 金额数组，dates: 日期数组
  const DAYS = 365;
  function npv(rate) {
    let sum = 0;
    const t0 = Math.min(...dates.map(d => new Date(d).getTime()));
    for (let i = 0; i < cashflows.length; i++) {
      const days = (new Date(dates[i]).getTime() - t0) / (1000 * 60 * 60 * 24);
      sum += cashflows[i] / Math.pow(1 + rate, days / DAYS);
    }
    return sum;
  }
  // 牛顿法
  let rate = guess;
  for (let i = 0; i < 100; i++) {
    const f = npv(rate);
    const df = (npv(rate + 0.0001) - npv(rate - 0.0001)) / 0.0002;
    if (Math.abs(f) < 1e-6) break;
    rate = rate - f / df;
  }
  return rate;
}
```

- [ ] **Step 2: 实现 DCA 回测主逻辑**

```javascript
export function backtest(config) {
  const { assets, amount, frequency, startDate, endDate } = config;
  // assets: [{symbol, weight, prices, dates, dividends}]
  // 简化：需要先获取每个资产的历史数据（在 index.js 中调用 fetcher）
  
  // 1. 确定定投日期（按月/周/季）
  // 2. 每次按权重分配金额 → 买入份额
  // 3. 每次分红 → 按当日价格再投资
  // 4. 计算每年末的收益率和总金额
  // 5. 计算 CAGR 和 XIRR
}
```

- [ ] **Step 3: 提交**

```bash
git add worker/src/backtest.js
git commit -m "feat: add DCA backtest engine"
```

---

### Task 3: 新增 /api/backtest 路由

**Files:**
- Modify: `worker/src/index.js`

**Interfaces:**
- Consumes: `Fetcher.getHistoricalPrices`, `backtest(config)`
- Produces: `/api/backtest` POST 端点

- [ ] **Step 1: 添加路由**

```javascript
if (path === '/api/backtest' && request.method === 'POST') {
  const body = await request.json();
  // 1. 为每个资产获取历史数据
  // 2. 调用 backtest()
  // 3. 返回结果
}
```

- [ ] **Step 2: 提交并部署 Worker**

---

### Task 4: 新增定投计算器前端页面

**Files:**
- Create: `frontend/calculator.html`

**分析：** 深色主题，与仪表盘一致。包含：
- 参数表单：金额、频率（月/周/季）、起止日期、多标的（含权重）
- 预设组合：全天候、永久组合、巴菲特退休
- 结果显示：总投入、最终金额、倍数、CAGR、XIRR
- 逐年表格：每年末收益率、总金额
- 图表：累计金额曲线、逐年收益率柱状图

- [ ] **Step 1: 创建 calculator.html**
- [ ] **Step 2: 提交**

---

### Task 5: 添加页面互跳链接

**Files:**
- Modify: `frontend/index.html`（添加"定投计算器"链接）
- Modify: `frontend/calculator.html`（添加"返回仪表盘"链接）

- [ ] **Step 1: 在 index.html 添加跳转链接**
```html
<a href="/calculator.html" class="btn btn-outline-light">📈 定投计算器</a>
```
- [ ] **Step 2: 在 calculator.html 添加跳转链接**
```html
<a href="/" class="btn btn-outline-light">📊 返回仪表盘</a>
```

---

### Task 6: 部署到 Cloudflare 和 GitHub

- [ ] **Step 1: 推送代码到 GitHub**
```bash
git add -A
git commit -m "feat: add DCA calculator"
git push
```
- [ ] **Step 2: 部署 Worker**
```bash
CLOUDFLARE_API_TOKEN="<TOKEN>" npx wrangler deploy --env=""
```
- [ ] **Step 3: 部署前端**
```bash
CLOUDFLARE_API_TOKEN="<TOKEN>" npx wrangler pages deploy frontend --project-name nasdaq-indicator
```
- [ ] **Step 4: 验证自定义域名** motris.dpdns.org 可访问