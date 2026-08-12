# 组合再平衡回测 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在定投回测计算器中增加组合再平衡模拟功能，支持每年/每半年/每季度再平衡

**Architecture:** 修改 `backtest.js` 的 `runBacktest` 函数，在定投 + 分红再投资之后插入再平衡逻辑。新增 `rebalance` 参数控制频率。前端增加再平衡频率选择器，结果展示表格增加"再平衡后"列。

**Tech Stack:** Cloudflare Workers (JavaScript), D1 Database, Cloudflare Pages

## 全局约束

- 再平衡逻辑：在指定日期，计算各标的当前市值，按目标权重重新分配，卖出超配、买入低配
- 支持三种频率：每年（1月1日）、每半年（1月1日/7月1日）、每季度（1月1日/4月1日/7月1日/10月1日）
- 再平衡日当天有定投的，先定投再再平衡
- 定投+分红+再平衡后，计算逐年收益、最终收益、夏普比率等指标
- 逐年收益表格需要同时显示"不再平衡"和"再平衡后"两列，方便对比

---

## 文件结构

| 文件 | 修改内容 |
|------|---------|
| `worker/src/backtest.js` | 新增 `runRebalance` 逻辑，修改 `runBacktest` 支持 `rebalance` 参数 |
| `worker/src/index.js` | 将 HTTP 请求中的 `rebalance` 参数传给 `runBacktest` |
| `frontend/calculator.html` | 新增再平衡频率选择器，结果表格新增"再平衡后"对比列 |

---

### Task 1: 后端 — 新增再平衡逻辑

**Files:**
- Modify: `worker/src/backtest.js` (在 `runBacktest` 函数中增加再平衡逻辑)

**接口：**
- Consumes: `runBacktest(config)` 新增 `config.rebalance` 参数（`none`/`annual`/`semi-annual`/`quarterly`）
- Produces: 返回结果中新增 `rebalanced` 对象，包含 `finalValue`, `cagr`, `xirr`, `sharpeRatio`, `maxDrawdown`, `yearly` 等字段（与主结果结构相同）

- [ ] **Step 1: 读取 `backtest.js` 完整代码，理解当前定投 + 分红 + 逐年计算逻辑**

- [ ] **Step 2: 在 `runBacktest` 函数中，定投循环和分红再投资之后，增加再平衡逻辑**

```javascript
// 再平衡逻辑
function runRebalance(shares, assets, priceMaps, findPrice, rebalanceDate) {
  let totalValue = 0;
  const values = [];
  for (let i = 0; i < assets.length; i++) {
    const price = findPrice(i, rebalanceDate) || 0;
    const value = shares[i] * price;
    values.push(value);
    totalValue += value;
  }
  if (totalValue <= 0) return;
  for (let i = 0; i < assets.length; i++) {
    const targetValue = totalValue * assets[i].weight;
    const diff = targetValue - values[i];
    if (Math.abs(diff) < 0.01) continue;
    shares[i] = targetValue / (findPrice(i, rebalanceDate) || 1);
  }
}
```

- [ ] **Step 3: 生成再平衡日期列表**

```javascript
function getRebalanceDates(frequency, startDate, endDate) {
  const dates = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (frequency === 'none') return dates;
  const year = start.getFullYear();
  for (let y = year; y <= end.getFullYear(); y++) {
    dates.push(`${y}-01-01`);
    if (frequency === 'semi-annual' || frequency === 'quarterly') dates.push(`${y}-07-01`);
    if (frequency === 'quarterly') { dates.push(`${y}-04-01`); dates.push(`${y}-10-01`); }
  }
  return dates.filter(d => d >= startDate.slice(0,10) && d <= endDate.slice(0,10));
}
```

- [ ] **Step 4: 复制一份完整的回测逻辑，在新副本上应用再平衡**

为了同时显示"不再平衡"和"再平衡后"的对比结果，需要复制一份 `shares` 数组，在副本上执行再平衡，然后独立计算逐年收益和最终指标。

```
const rebalShares = [...shares]; // 复制基准份额
// 在 rebalShares 上执行再平衡
for (const rbDate of rebalanceDates) {
  runRebalance(rebalShares, assets, priceMaps, findPrice, rbDate);
}
// 用 rebalShares 独立计算逐年收益和最终指标
```

- [ ] **Step 5: 返回结果中增加 `rebalanced` 对象**

```javascript
return {
  ...originalResults,
  rebalanced: {
    finalValue: rebalFinalValue,
    totalInvested: totalInvested,
    ...其他指标,
    yearly: rebalYearly,
  }
};
```

---

### Task 2: 后端 — 修改 index.js 传递 rebalance 参数

**Files:**
- Modify: `worker/src/index.js` (从请求 body 中提取 `rebalance` 参数)

- [ ] **Step 1: 在 `/api/backtest` 处理中，从请求 body 提取 `rebalance` 参数**

```javascript
const { assets, amount, frequency, startDate, endDate, rebalance } = body;
// ...
const result = runBacktest({ assets: assetData, amount, frequency, startDate, endDate, rebalance: rebalance || 'none' });
```

---

### Task 3: 前端 — 增加再平衡频率选择器

**Files:**
- Modify: `frontend/calculator.html` (增加 UI 控件 + 结果展示)

- [ ] **Step 1: 在参数设置区增加"再平衡频率"下拉框**

在"定投频率"下方添加：

```html
<div class="mb-3">
  <label class="form-label">再平衡频率</label>
  <select class="form-select" id="rebalance">
    <option value="none">不进行再平衡</option>
    <option value="annual">每年</option>
    <option value="semi-annual">每半年</option>
    <option value="quarterly">每季度</option>
  </select>
</div>
```

- [ ] **Step 2: 在 `runBacktest` 函数中，读取再平衡频率并发送到 API**

```javascript
const body = {
  assets,
  amount: parseFloat(document.getElementById('amount').value) || 1000,
  frequency: document.getElementById('frequency').value,
  rebalance: document.getElementById('rebalance').value,
  startDate: document.getElementById('startDate').value,
  endDate: document.getElementById('endDate').value,
};
```

- [ ] **Step 3: 修改结果展示表格，增加"再平衡后"对比列**

在逐年收益表格中，如果 `data.rebalanced` 存在，增加两列：

```html
<th>年份</th><th>当年投入</th><th>累计投入</th>
<th>不再平衡 年末金额</th><th>不再平衡 年收益</th>
<th>再平衡后 年末金额</th><th>再平衡后 年收益</th>
```

- [ ] **Step 4: 在结果概况卡片中增加"再平衡后"对比指标**

在原有卡片下方新增一行再平衡后的核心指标对比：

```html
<div class="row g-3 mb-4">
  <div class="col-12">
    <div class="card">
      <div class="card-header">🔄 再平衡效果对比</div>
      <div class="card-body">
        <table class="table">
          <tr><th>指标</th><th>不再平衡</th><th>再平衡后</th><th>差异</th></tr>
          <tr><td>最终金额</td><td>¥{fmt(data.finalValue)}</td><td>¥{fmt(data.rebalanced.finalValue)}</td><td>+{diff}%</td></tr>
          ...
        </table>
      </div>
    </div>
  </div>
</div>
```

---

### Task 4: 测试验证

- [ ] **Step 1: 部署 Worker 并测试每种再平衡频率**

```bash
curl -k -s -X POST "https://api.motris.dpdns.org/api/backtest" \
  -H "Content-Type: application/json" \
  -d '{"assets":[{"symbol":"VOO","weight":0.6},{"symbol":"GLD","weight":0.4}],"amount":1000,"frequency":"monthly","rebalance":"annual","startDate":"2015-01-01","endDate":"2026-08-01"}'
```

验证：再平衡后的 CAGR/XIRR 应合理，且与不再平衡有差异（通常略高或略低，视组合而定）

- [ ] **Step 2: 测试边界情况**
  - 单标的（再平衡无意义，但不应报错）
  - 再平衡频率为 none（回退到当前行为）
  - 所有标的权重相等

---

### Task 5: 部署到 GitHub 和 Cloudflare

- [ ] **Step 1: 提交代码并推送**

```bash
git add -A && git commit -m "feat: add portfolio rebalancing backtest" && git push
```

- [ ] **Step 2: 部署 Worker 和前端**

```bash
cd worker && wrangler deploy --env=""
cd .. && wrangler pages deploy frontend --project-name nasdaq-indicator
```

- [ ] **Step 3: 创建版本标签**

```bash
git tag -a "v1.2.0" -m "v1.2.0 - 新增组合再平衡回测" && git push origin v1.2.0
```