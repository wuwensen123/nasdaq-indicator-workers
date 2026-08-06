# A股定投策略修正 + Bug修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收紧A股定投策略阈值，参考权威券商标准修正PE评分，修复代码中的BUG，重新部署到Cloudflare

**Architecture:** 修改 analyzer.js 中的 PE 归一化函数和 DCA 策略阈值，修复 fetchers.js 中的 MACD 计算 bug，修复前端 index.html 中的多个 bug

**Tech Stack:** Cloudflare Workers (JavaScript), D1 Database, Cloudflare Pages

## Global Constraints

- 所有 PE 阈值参考海外券商对中国 A 股的历史估值区间
- 银行股正常 PE 区间 5-7，偏高 7-8，高估 >8
- 沪深300 正常 PE 区间 12-14，偏高 14-16，高估 >16
- 上证指数 正常 PE 区间 12-14，偏高 14-16，高估 >16
- 长江电力（电力股）正常 PE 区间 15-20
- 紫金矿业（矿业股）正常 PE 区间 10-15
- 修改后需重新部署到 Cloudflare 并推送 GitHub

---

## 文件结构

| 文件 | 修改内容 |
|------|---------|
| `worker/src/analyzer.js` | 收紧 PE_Shanghai/PE_CSI300/PE_Stock 阈值，新增 PE_Utility/PE_Mining 归一化，修正 DCA 策略 |
| `worker/src/fetchers.js` | 修复 MACD 信号线计算 bug，修复 Put/Call 比率估算逻辑 |
| `frontend/index.html` | 修复标签映射缺失、自动刷新使用 /refresh 端点、null 值处理等 bug |
| `worker/wrangler.toml` | 无需修改 |
| `worker/src/index.js` | 移除冗余的 Fetcher/Analyzer 实例化 |

---

### Task 1: 收紧A股PE归一化阈值

**Files:**
- Modify: `worker/src/analyzer.js:692-752` (normPE_Shanghai, normPE_CSI300, normPE_Stock 函数)

**Interfaces:**
- Consumes: 现有的 normPE_Shanghai, normPE_CSI300, normPE_Stock 函数签名
- Produces: 收紧后的阈值版本

**分析：** 当前A股PE阈值过于宽松。以当前实际数据为例：
- 上证指数 PE=17.9 → 当前判定为"正常偏高"（score 70-90），应判定为"高估"（score 85-100）
- 沪深300 PE=14.32 → 当前判定为"正常"（score 50-70），应判定为"偏高"（score 70-85）
- 农业银行 PE=7.73 → 当前判定为"正常偏低"（score 25-50），应判定为"偏高"（score 50-70）

参考海外券商对中国A股的历史估值区间，收紧阈值如下：

**新 normPE_Shanghai(v):**
- v < 10: score = 0, label = '历史低位'
- 10 ≤ v < 12: score = cap((v-10)/2 * 25), label = '偏低' (0-25)
- 12 ≤ v < 14: score = cap(25 + (v-12)/2 * 25), label = '正常' (25-50)
- 14 ≤ v < 16: score = cap(50 + (v-14)/2 * 20), label = '偏高' (50-70)
- 16 ≤ v < 18: score = cap(70 + (v-16)/2 * 15), label = '高估' (70-85)
- v ≥ 18: score = cap(85 + min(15, (v-18)/2 * 15)), label = '严重高估' (85-100)

**新 normPE_CSI300(v):**
- v < 10: score = 0, label = '历史低位'
- 10 ≤ v < 12: score = cap((v-10)/2 * 25), label = '偏低' (0-25)
- 12 ≤ v < 14: score = cap(25 + (v-12)/2 * 25), label = '正常' (25-50)
- 14 ≤ v < 16: score = cap(50 + (v-14)/2 * 20), label = '偏高' (50-70)
- 16 ≤ v < 18: score = cap(70 + (v-16)/2 * 15), label = '高估' (70-85)
- v ≥ 18: score = cap(85 + min(15, (v-18)/2 * 15)), label = '严重高估' (85-100)

**新 normPE_Stock(v) — 银行股专用:**
- v < 4: score = 0, label = '严重低估'
- 4 ≤ v < 5: score = cap((v-4)/1 * 20), label = '低估' (0-20)
- 5 ≤ v < 6: score = cap(20 + (v-5)/1 * 25), label = '正常偏低' (20-45)
- 6 ≤ v < 7: score = cap(45 + (v-6)/1 * 25), label = '正常' (45-70)
- 7 ≤ v < 8: score = cap(70 + (v-7)/1 * 15), label = '偏高' (70-85)
- v ≥ 8: score = cap(85 + min(15, (v-8)/1 * 15)), label = '高估' (85-100)

- [ ] **Step 1: 修改 normPE_Shanghai 函数**

替换 `analyzer.js` 中的 normPE_Shanghai 函数实现。

- [ ] **Step 2: 修改 normPE_CSI300 函数**

替换 `analyzer.js` 中的 normPE_CSI300 函数实现。

- [ ] **Step 3: 修改 normPE_Stock 函数**

替换 `analyzer.js` 中的 normPE_Stock 函数实现。

---

### Task 2: 新增电力股和矿业股PE归一化

**Files:**
- Modify: `worker/src/analyzer.js` (新增 normPE_Utility, normPE_Mining 函数 + 更新 _score 方法中的 globalIndicators)

**Interfaces:**
- Consumes: 现有的 pe_stock 指标用于银行股，新增 pe_utility 和 pe_mining 指标
- Produces: 长江电力使用 pe_utility，紫金矿业使用 pe_mining

**分析：** 当前所有中国个股共用 normPE_Stock（银行股尺度），但长江电力（PE=18.82）和紫金矿业（PE=14.87）的正常PE区间与银行完全不同。需要新增专用归一化函数。

**新增 normPE_Utility(v) — 电力股:**
- v < 10: score = 0, label = '严重低估'
- 10 ≤ v < 13: score = cap((v-10)/3 * 20), label = '低估' (0-20)
- 13 ≤ v < 16: score = cap(20 + (v-13)/3 * 25), label = '正常偏低' (20-45)
- 16 ≤ v < 20: score = cap(45 + (v-16)/4 * 25), label = '正常' (45-70)
- 20 ≤ v < 25: score = cap(70 + (v-20)/5 * 15), label = '偏高' (70-85)
- v ≥ 25: score = cap(85 + min(15, (v-25)/5 * 15)), label = '高估' (85-100)

**新增 normPE_Mining(v) — 矿业股:**
- v < 8: score = 0, label = '严重低估'
- 8 ≤ v < 10: score = cap((v-8)/2 * 20), label = '低估' (0-20)
- 10 ≤ v < 12: score = cap(20 + (v-10)/2 * 25), label = '正常偏低' (20-45)
- 12 ≤ v < 15: score = cap(45 + (v-12)/3 * 25), label = '正常' (45-70)
- 15 ≤ v < 18: score = cap(70 + (v-15)/3 * 15), label = '偏高' (70-85)
- v ≥ 18: score = cap(85 + min(15, (v-18)/3 * 15)), label = '高估' (85-100)

**更新目标配置：**
- 长江电力: 新增 `pe_utility` 指标替代 `pe_stock`
- 紫金矿业: 新增 `pe_mining` 指标替代 `pe_stock`

**更新 `_score` 方法中的 globalIndicators：**
- 新增 `'pe_utility': () => { const v = td.pe_ratio; const s = normPE_Utility(v); return { ...s, value: v }; }`
- 新增 `'pe_mining': () => { const v = td.pe_ratio; const s = normPE_Mining(v); return { ...s, value: v }; }`

**更新 `_indInfo` 和 `_indName` 方法：**
- 新增 `pe_utility: { name: '电力股市盈率', desc: '电力行业估值水平' }`
- 新增 `pe_mining: { name: '矿业股市盈率', desc: '矿业行业估值水平' }`

- [ ] **Step 1: 新增 normPE_Utility 和 normPE_Mining 函数**
- [ ] **Step 2: 更新长江电力目标的 indicators 列表** — 将 `pe_stock` 替换为 `pe_utility`
- [ ] **Step 3: 更新紫金矿业目标的 indicators 列表** — 将 `pe_stock` 替换为 `pe_mining`
- [ ] **Step 4: 在 `_score` 方法的 globalIndicators 中添加 pe_utility 和 pe_mining 映射**
- [ ] **Step 5: 在 `_indInfo` 和 `_indName` 中添加新指标**

---

### Task 3: 修复 MACD 信号线计算 Bug

**Files:**
- Modify: `worker/src/fetchers.js:203-208` (MACD 信号线计算)

**分析：** 当前 MACD 信号线计算使用 `[...Array(N).fill(macdLine), macdLine]` 创建全相同的数组，导致信号线始终等于 MACD 线。需要改用实际历史 MACD 值计算 EMA。

- [ ] **Step 1: 修复 MACD 信号线计算**

```javascript
// 当前（bug）:
result.macd_signal = round(calcEMA([...Array(Math.min(25, close.length - 1)).fill(macdLine), macdLine], 9));

// 修复后: 从历史收盘价计算 MACD 信号线
const ema12All = close.map((_, i) => i === 0 ? close[0] : close.slice(0, i+1).reduce((sum, v) => sum + v, 0) / (i+1));
// 简化方案: 使用 calcEMA 计算实际 MACD 历史值
const macdValues = [];
for (let i = 26; i < close.length; i++) {
  const e12 = calcEMA(close.slice(0, i+1), 12);
  const e26 = calcEMA(close.slice(0, i+1), 26);
  macdValues.push(e12 - e26);
}
if (macdValues.length >= 9) {
  result.macd_signal = round(calcEMA(macdValues, 9));
} else {
  result.macd_signal = round(macdLine);
}
```

---

### Task 4: 修复前端 Bug

**Files:**
- Modify: `frontend/index.html` (多个 locations)

**Bug 清单：**

- [ ] **Step 1: 修复标签映射缺失**

在 `renderGlobalIndicators` 函数中，找到 `badgeClass` 映射对象，添加缺失的标签：
```javascript
const badgeClass = {
  '极度恐惧': 'badge bg-danger',
  '恐惧': 'badge bg-warning text-dark',
  '中性': 'badge bg-secondary',
  '贪婪': 'badge bg-warning text-dark',
  '极度贪婪': 'badge bg-danger',
  '极度看涨': 'badge bg-danger',
  '看涨': 'badge bg-warning text-dark',
  '中性偏乐观': 'badge bg-warning text-dark',
  '中性偏悲观': 'badge bg-primary',
  '看跌': 'badge bg-primary',
  '极度看跌': 'badge bg-danger',
  '极度悲观': 'badge bg-danger',         // 新增
  '极度乐观': 'badge bg-danger',         // 新增
  '过度乐观': 'badge bg-warning text-dark', // 新增
  '未知': 'badge bg-secondary'
}[ind.label] || 'badge bg-secondary';
```

- [ ] **Step 2: 修复自动刷新使用 /refresh 端点**

找到 `startAutoRefresh` 函数，将 `fetchData(false)` 改为 `fetchData(true)` 以确保自动刷新从缓存中清除并获取新数据：
```javascript
function startAutoRefresh() {
    if (appState.autoRefreshInterval) clearInterval(appState.autoRefreshInterval);
    appState.autoRefreshInterval = setInterval(() => fetchData(true), 5 * 60 * 1000);
}
```

- [ ] **Step 3: 修复 `formatNumber` 对价格 0 的 falsy 处理**

在 `renderTargetCard` 函数中，将 `target.current_price ? formatNumber(...) : '--'` 改为 `target.current_price !== null && target.current_price !== undefined ? formatNumber(...) : '--'`。

---

### Task 5: 移除 index.js 中冗余的 Fetcher/Analyzer 实例化

**Files:**
- Modify: `worker/src/index.js` (fetchFreshData 函数)

**分析：** `fetchFreshData` 函数内部创建了新的 `Fetcher()` 和 `Analyzer()` 实例，但模块级已经存在实例。应当复用模块级实例。

- [ ] **Step 1: 移除 `fetchFreshData` 中的冗余实例化**

将 `fetchFreshData` 函数开头的 `const fetcher = new Fetcher(); const analyzer = new Analyzer();` 删除，改用模块级实例。

---

### Task 6: 推送 GitHub + 重新部署 Cloudflare

**Files:**
- 所有修改后的文件

- [ ] **Step 1: 提交代码到 GitHub**

```bash
cd D:/ClaudeCodeDesktop/nasdaq-indicator-workers
git add -A
git commit -m "fix: tighten A-share PE thresholds, add industry-specific PE norms, fix MACD bug, fix frontend bugs"
git push
```

- [ ] **Step 2: 部署 Worker 到 Cloudflare**

```bash
cd D:/ClaudeCodeDesktop/nasdaq-indicator-workers/worker
CLOUDFLARE_API_TOKEN="<你的CF_API_TOKEN>" npx wrangler deploy --env=""
```

- [ ] **Step 3: 部署前端到 Cloudflare Pages**

```bash
cd D:/ClaudeCodeDesktop/nasdaq-indicator-workers
CLOUDFLARE_API_TOKEN="<你的CF_API_TOKEN>" npx wrangler pages deploy frontend --project-name nasdaq-indicator
```

- [ ] **Step 4: 清除 D1 缓存 + 验证**

```bash
# 清除旧缓存强制刷新
curl -k -s --connect-timeout 90 "https://nasdaq-indicator.morisze.workers.dev/api/refresh"
```

---

## 自检清单

**1. Spec 覆盖：**
- ✅ 收紧A股PE阈值 (Task 1)
- ✅ 新增行业专用PE归一化 (Task 2)
- ✅ 修复MACD bug (Task 3)
- ✅ 修复前端bug (Task 4)
- ✅ 修复冗余代码 (Task 5)
- ✅ 重新部署 (Task 6)

**2. 占位符检查：** 所有代码块包含实际实现内容，无 TBD/TODO。

**3. 类型一致性：**
- `normPE_Shanghai`, `normPE_CSI300`, `normPE_Stock` 签名保持不变
- `normPE_Utility`, `normPE_Mining` 遵循相同签名模式
- `pe_utility`, `pe_mining` 指标 ID 在目标和 `_score` 方法中一致