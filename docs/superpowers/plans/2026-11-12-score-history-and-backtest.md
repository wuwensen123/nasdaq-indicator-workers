# 评分历史快照 + 加速规则回测 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ① 每天把 11 个标的的评分快照存入 D1，前端弹窗展示 90 天评分趋势曲线；② 用真实历史数据（NDX 2001+ / SPX 1990+ forward PE 周度序列 + 指数价格）回测「评分加速规则 vs 固定 1x 定投」，输出对比报告。

**Architecture:** ① 新表 `score_history`（UNIQUE(target_id,date)），只在 7:30 cron 写入（每天一条），新 API `/api/history` 一次返回全部标的；前端用现有 Chart.js 画折线。② 独立 Node 脚本（不部署、不进 Worker，避免占免费子请求额度），复用 historyofmarket 两个 JSON + Yahoo 历史价格，月度定投回测三种策略，输出 markdown 报告。

**Tech Stack:** D1、Workers fetch 路由、Chart.js（前端已有）、node:test、Node 脚本。

**Spec:** 本会话用户批准的建议 1、2（见对话记录）；数据源可行性见 `docs/superpowers/reports/2026-11-12-data-veracity-verification.md`。

## Global Constraints

- 免费版 50 子请求：`/api/history` 只读 D1（1 次查询）；快照写入放 7:30 cron，不占 refresh。
- D1 免费额度：11 行/天写入，忽略不计。
- 快照只存 7:30 的数据（美股前收盘 + A股前一交易日收盘，均为完整数据）；14:30 不写，避免盘中噪声。
- 前端不引入新图表库；先检查现有页面用的什么（Chart.js/ECharts），沿用。
- 历史回测脚本放 `worker/scripts/`，不参与 bundle（wrangler 只打包 src/）。
- 中文界面与文案。

## Review Focus

1. `/api/history` 在 D1 表为空（刚上线）时返回空数组而非 500 —— 前端显示"数据积累中"。
2. `INSERT OR REPLACE` 依赖 UNIQUE(target_id,date)，重复触发同一天不会重复行 —— 测试覆盖。
3. cron 7:30 之外的触发（手动 refresh、14:30）不得写快照 —— 测试覆盖。
4. 回测脚本对 forwardOwn 序列与价格日期不对齐（周度 vs 交易日）必须按日期前向填充（as-of join），不得错位 —— 测试覆盖。
5. 回测资金口径：三策略总投入不同，比较必须用 multiple/XIRR 且同时报告总投入 —— 报告里明确。

---

### Task 1: score_history 表 + 写入 + /api/history

**Files:**
- Modify: `worker/src/index.js`（initDB 建表、saveScoreHistory、/api/history 路由、scheduled 7:30 调用）
- Test: `worker/test/history.test.mjs`（新建）

**Interfaces:**
- Consumes: `fetchFreshData(env)` 返回的 data 结构（`analysis.results[].target_id/composite_score/strategy.multiple/indicators`）
- Produces:
  - `saveScoreHistory(env, data)` → void；`date` 取 UTC+8 的 YYYY-MM-DD；indicators 存精简 `{指标名: {v: value, s: score}}`
  - `GET /api/history?days=90`（上限 365）→ `{success:true, days, history: {qqq: [{date, score, multiple}, ...], ...}}`；无表/无数据返回空对象
  - 建表 SQL：`CREATE TABLE IF NOT EXISTS score_history (id INTEGER PRIMARY KEY AUTOINCREMENT, target_id TEXT NOT NULL, date TEXT NOT NULL, composite_score REAL, multiple REAL, indicators TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(target_id, date))`

- [x] **Step 1: 写失败测试**（mock env：batch/prepare/all）
- [x] **Step 2: 运行确认失败**
- [x] **Step 3: 实现 saveScoreHistory + 路由 + scheduled 接线**
- [x] **Step 4: 运行测试确认通过**
- [x] **Step 5: 提交** `feat: 评分历史每日快照(D1) + /api/history`

---

### Task 2: 前端 90 天评分趋势图

**Files:**
- Modify: `frontend/index.html`（showTargetDetail 弹窗加 canvas + fetch + Chart.js 渲染）

**Interfaces:**
- Consumes: `GET /api/history?days=90`（Task 1）
- Produces: 弹窗顶部「90 天评分趋势」区块；<2 个点时显示「评分历史积累中（每天 7:30 记录一次）」

- [x] **Step 1: 检查前端现有图表库与弹窗结构**
- [x] **Step 2: 加 canvas + 渲染逻辑（0-100 轴，40/60 虚线参考，当前点高亮）**
- [x] **Step 3: 本地/线上手动验证（无数据与有数据两种状态）**
- [x] **Step 4: 提交**

---

### Task 3: 加速规则回测脚本

**Files:**
- Create: `worker/scripts/backtest-accel-rules.mjs`
- Create: `worker/test/backtest-rules.test.mjs`
- Output: `docs/superpowers/reports/2026-11-12-accel-rules-backtest.md`

**Interfaces:**
- Consumes: `https://historyofmarket.com/api/{ndx,sp500}/forward-pe.json`（真实 forward PE 序列）；Yahoo chart `^NDX`（或 QQQ）与 `^SP500TR`（10 年+ 日线）
- Produces: 三策略对比（月度定投，月初第一个交易日）：
  - `fixed`：每次 1 单位
  - `score`：forward PE 历史分位（用截至当日的序列计算，无未来函数）≤40 → 1.5x；≤25 → 2x；否则 1x
  - `combo`：score 规则 + 距 52 周高点回撤 ≥15% → 再乘 1.5（上限 3x）
  - 指标：总投入、期末市值、multiple、XIRR、最大回撤（账户价值）、平均成本；分 QQQ(2001+) / VOO(1990+ 用 SPX) 两段
- 关键实现约束：**无未来函数**——每次定投只用当日及之前的 forward PE 序列算分位；价格与 PE 按日期 as-of 合并。

- [x] **Step 1: 写失败测试（as-of join、分位无未来函数、规则倍数）**
- [x] **Step 2: 运行确认失败**
- [x] **Step 3: 实现脚本**
- [x] **Step 4: 运行出真实回测结果**
- [x] **Step 5: 写报告 + 提交**

---

### Task 4: 部署与验证（Task 1-2）

- [x] **Step 1: 全量测试**
- [x] **Step 2: 部署 Worker，触发一次手动写入验证**（临时 curl /api/refresh 不写快照；用 wrangler 直接调 scheduled 不现实——改为部署后手动执行一次 SQL 插入？不：验证方式是等 7:30 cron 或加 debug 路由？**决定**：saveScoreHistory 除 cron 外也在 `/api/refresh` 里调用？违反 constraint（7:30 之外的触发不得写快照）——改为：部署后通过 `wrangler d1 execute` 手动插入一条演示数据验证前端渲染，24h 内 cron 产生真实数据后删演示行）
- [x] **Step 3: 生产验证 /api/history 与前端曲线**
- [x] **Step 4: 提交 + tag v2.4.0 + push**
