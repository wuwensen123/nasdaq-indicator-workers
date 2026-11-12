# 全部指标 90 天回溯 + 前端切换 + 历史补全 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每个标的的全部指标（含公式算出的分数 s）可回溯 90 天；前端弹窗加按钮切换指标查看各自历史曲线；把 2026-08-14 ~ 今的 90 个交易日历史用真实数据回放补全进 `score_history`。

**Architecture:** ① `/api/history` 扩展为按标的返回 `{series(评分), indicators:{指标名:[{date,v,s}]}}`（数据早已存于 `score_history.indicators` JSON）。② 前端把现有单曲线改为指标按钮行 + 切换渲染。③ 离线回填脚本 `backfill-history.mjs`：拉取各数据源的每日历史序列（FRED API / Yahoo 日线 / historyofmarket 周序列 / 东财 RPT_VALUEANALYSIS_DET 每日 PE_TTM+PB_MRQ / 腾讯日 K），对每个交易日 as-of 取当日值构造 `globalData`+`targetsData`，**直接调用生产 `analyzer.analyzeTarget`** 重放评分公式，产物 INSERT 到 D1（本地脚本经 wrangler 写入）。

**Tech Stack:** node 脚本 + D1 + 现有 analyzer/fetchers + Chart.js（前端已有）。

**Spec:** 用户 /goal 指令："每个投资标的里面的所有指标都可以回溯90天的所有数据，包括最后用公式算出来的分数…做几个按钮切换指标…把历史的数据补全"。

## Global Constraints

- 前端不引入新图表库；button 行沿用现有弹窗样式。
- `/api/history` 响应兼容旧字段（`history[target].series` 保留）。
- 回填数据的日期 = UTC+8 交易日；每标的每天仍一行 UNIQUE(target_id,date)，indicators JSON 内缺的指标当天就不存在（前端自然缺段）。
- **无源的指标不造假**：蛋卷/韭圈儿/中证官方估值（daily-only 快照）、腾讯实时股息率无 90 天历史 → 回填跳过，只从 11-13 真实快照起积累；文档与 tooltip 说明。
- 回填值口径：收盘价当天的数据（FRED 当日值、东财当日快照、腾讯 K 当日收盘）。
- 回填脚本本地跑（无 50 子请求限制），不部署。
- 评分公式重放用**当日真实输入**（Baa/TIPS/Shiller/Forward PE 分位等全部取该日历史值），保证分数是"当时算出来的"。

## Review Focus

1. `/api/history` 指标分组按 name 聚合，同一日期多个指标互不串位 —— 测试覆盖。
2. 指标曲线上数值与分数并存：tooltip 同时给 v 和 s —— 前端自测。
3. 回填脚本对无历史源的指标（蛋卷/中证/股息率）不得写入 0 或假值，直接跳过 —— 测试覆盖。
4. 回填跨周末/节假日：FRED/东财只有交易日 → 按 as-of 前向填充，不得篡改日期。
5. 90 天窗口含 2026-08-14 起约 90 个交易日；回填后 `/api/history?days=90` 每标的 series 长度应 ≥70。

---

### Task 1: /api/history 返回全部指标历史

**Files:**
- Modify: `worker/src/index.js`（/api/history 路由：查询加 indicators 列，分组组装）
- Test: `worker/test/history.test.mjs`（加 2 个用例）

**Interfaces:**
- Consumes: `score_history.indicators` JSON `{指标名:{v,s}}`
- Produces: `GET /api/history?days=90` → `{success, days, history:{target:{series:[{date,score,multiple}], indicators:{名:[{date,v,s}]}}}}`；无 indicators 字段的行容错（indicators 空对象）

- [x] **Step 1: 写失败测试**（带 indicators 的 mock 行 → 断言按指标分组；无 indicators → indicators 为空对象）
- [x] **Step 2: 实现路由扩展**
- [x] **Step 3: 全量测试通过**

---

### Task 2: 前端指标切换按钮 + 多曲线

**Files:**
- Modify: `frontend/index.html`（renderScoreHistory 改为指标按钮行 + 按选中指标渲染）

**Interfaces:**
- Consumes: `/api/history` 新结构（Task 1）
- Produces: 弹窗「90 天评分趋势」区块：横向按钮（综合评分 + 各指标名），点击切换曲线；tooltip 显示值+分数；无点指标显示"该指标从 11-13 起记录"

- [x] **Step 1: 实现按钮行与切换逻辑**
- [x] **Step 2: preview 自测（有/无数据、切指标）**
- [x] **Step 3: 提交（与 Task 1 一起）**

---

### Task 3: 90 天历史回填脚本

**Files:**
- Create: `worker/scripts/backfill-history.mjs`
- Test: `worker/test/backfill-utils.test.mjs`（纯函数单测）
- Output: `docs/superpowers/reports/2026-11-12-history-backfill.md`

**Interfaces:**
- Consumes: 序列源（全部本地无限制）：
  - FRED API `api.stlouisfed.org`：DBAA（Baa）、DGS10、DFII10（TIPS）、SHILLER_PE —— 按天 as-of
  - `historyofmarket.com/api/{ndx,sp500}/forward-pe.json`（周序列）
  - Yahoo chart 日线：^VIX、^TNX、DX-Y.NYB、GC=F（月线）、全 11 标的价 + 技术重算
  - 东财 RPT_VALUEANALYSIS_DET：601288/601939/600036/600900/601899 每日 PE_TTM/PB_MRQ/CLOSE_PRICE
  - 腾讯日 K：A 股 7 标的 + 563020 代理（MA200/RSI/52w）
  - multpl CPI 月度表（金价实际分位）
- Produces: 对每个交易日构建当日 inputs → `analyzer.analyzeTarget` → `{target_id, date, composite_score, multiple, indicators}` 数组 → 写入 D1（`wrangler d1 execute` 批量或脚本内 async D1 via seq？→ 用 `wrangler d1 execute --file` 生成 SQL 批处理）
- 无源指标（蛋卷/韭圈儿/中证官方估值/腾讯实时股息率）：排除在回填目标外

- [x] **Step 1: 写纯函数测试**（as-of 拼接、东财行解析、指标排除规则）
- [x] **Step 2: 实现脚本**（序列抓取 → 逐日重放 → 产物 SQL）
- [x] **Step 3: 本地跑全量 90 天，调通评分重放（抽查某日分数与当日真值接口对比）**
- [x] **Step 4: 灌入 D1，验证 /api/history 90 天曲线**

---

### Task 4: 部署验证与收尾

- [x] **Step 1: 全量测试**
- [x] **Step 2: 部署 Worker + Pages**
- [x] **Step 3: 生产验证 /api/history 各指标曲线**
- [x] **Step 4: 提交 + tag v2.5.0 + push**