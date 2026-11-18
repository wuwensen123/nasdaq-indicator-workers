# K 线图 + 三周期（价格走势升级）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 「价格走势」从折线升级为蜡烛 K 线（OHLC + MA5/10/20 均线），支持 日K(90天)/周K(52周)/月K(60月) 三周期切换。

**Architecture:** 日K OHLC 随每日快照存 `score_history.indicators['价格走势']`（`v`=close 向后兼容，新增 `o/h/l/d`）；周/月K 走新端点 `/api/ohlc`（Yahoo/腾讯代理 + D1 缓存，不进每日快照）；前端点「价格走势」后出现 日/周/月 切换，蜡烛图用 chartjs-chart-financial（CDN），MA 由收盘价前端现算。

**Tech Stack:** Cloudflare Workers + D1；前端纯 CDN（Chart.js 4.4 UMD + chartjs-chart-financial@4 + chartjs-adapter-date-fns@3 bundle）；node:test。

**Spec:** 2026-11-18 会话 brainstorming 与用户确认：K线蜡烛 + MA5/10/20 一起画；日K=90天、周K=最近52周、月K=最近60个月；红涨绿跌（用户截图样式）；不画成交量；周/月K 按需接口不存快照。

## Global Constraints

- 红涨绿跌统一所有标的（含美股）：up `#dc2626`、down `#16a34a`、unchanged `#9ca3af`
- MA 颜色：MA5 `#f59e0b`（橙）、MA10 `#3b82f6`（蓝）、MA20 `#a855f7`（紫）；不画成交量柱
- 快照格式：`indicators['价格走势'] = { v: close, s: null, o, h, l, d }`；`v` 必须是收盘价（向后兼容旧消费方）；`d` = OHLC 真实交易日（周末/假日 as-of 行 `d` 相同，前端按 `d` 去重）
- 无 OHLC 数据时只写 `{v, s:null}`（不造假）；前端遇到缺 `o/h/l` 的数据优雅降级为原折线图
- `/api/ohlc`：`GET /api/ohlc?target=<id>&period=weekly|monthly` → `{success:true, target, period, candles:[{date,o,h,l,c}]}`；非法 target 或 period → HTTP 400 `{success:false, error}`
- 缓存：D1 key `daily:ohlc_{target}_{period}`（复用 `fetcher.getCachedDaily`），weekly TTL 12h、monthly TTL 24h
- 周K = 末 52 根、月K = 末 60 根
- 标的→代码：`.SS`→sh / `.SZ`→sz 走腾讯 fqkline（dividend_low_vol_100 用 `tech_symbol` 563020.SS 即 sh563020）；QQQ/VOO/GLD/^HSI 走 Yahoo chart API
- 前端不引入构建步骤，只加 CDN script 标签
- `/api/ohlc` 不进 refresh 路径，cron 子请求预算不受影响（缓存未命中仅 1 个子请求）

## Review Focus

1. chartjs-chart-financial CDN 与 Chart.js 4.4 UMD 的加载顺序/兼容（插件静默失败 → 空白图）→ Task 4 实测：canvas 蜡烛红/绿像素计数 + console 无错误
2. 周末/假日 as-of 行 OHLC 重复 → 前端按 `d` 去重（Task 3 抽验：周六行的 d = 周五日期；Task 4 实测：日K蜡烛数 ≈ 交易日数而非 90）
3. dividend_low_vol_100 必须走 tech_symbol 563020.SS（930955 指数本身无交易价）→ Task 2 测试断言腾讯请求 URL 含 `sh563020`
4. 腾讯 fqkline 周/月返回键名 `qfqweek|week`、`qfqmonth|month` 与日线 `qfqday|day` 不同 → Task 2 兼容两种键 + mock 测试覆盖
5. v2.10.0 之前的旧快照行无 o/h/l → 前端必须降级折线而非空白 → Task 4 fallback 分支 + 实测

---

### Task 1: 后端日K OHLC 采集与快照存储

**Files:**
- Modify: `worker/src/fetchers.js`（getTechnicalIndicators ~L710-768；getTencentTechnical ~L771-799）
- Modify: `worker/src/index.js`（targetsData 构造 ~L244-253；saveScoreHistory ~L129-134）
- Modify: `worker/src/analyzer.js`（analyzeTarget 两处返回 ~L112、~L188；price 元数据 desc ~L824）
- Test: `worker/test/history.test.mjs`

**Interfaces:**
- Produces: `day_ohlc: {o, h, l, c, d} | null`（fetchers → `targetsData[t.id].day_ohlc` → analyzer 透传 `r.day_ohlc` → saveScoreHistory 消费）
- Produces: 快照行 `indicators['价格走势'] = {v, s:null, o?, h?, l?, d?}`

- [ ] **Step 1: 写失败测试**（history.test.mjs 追加）
  - `saveScoreHistory writes OHLC for 价格走势 when day_ohlc present`：result 带 `current_price: 689.52, day_ohlc: {o:685.1, h:690.2, l:684.3, c:689.52, d:'2026-11-17'}` → `parsed['价格走势']` deepEqual `{v:689.52, s:null, o:685.1, h:690.2, l:684.3, d:'2026-11-17'}`（注意不写 c，v 即 c）
  - `saveScoreHistory writes price-only when day_ohlc missing`：无 day_ohlc → deepEqual `{v:689.52, s:null}`（无 o 键）
- [ ] **Step 2: 跑测试确认失败**（`cd worker && node --test test/history.test.mjs`，以 package.json 实际 test 脚本为准）
- [ ] **Step 3: 实现**
  - `getTechnicalIndicators` Yahoo 路径：`timestamp` 末位 + `quote[0]` 的 open/high/low/close 末位（遇 null 向前跳过）→ `result.day_ohlc = {o, h, l, c, d: 该 timestamp 转 ISO 日期}`，round 到 4 位
  - `getTencentTechnical`：rows 末行 `[date, open, close, high, low]` → `day_ohlc = {o: parseFloat(r[1]), h: parseFloat(r[3]), l: parseFloat(r[4]), c: parseFloat(r[2]), d: r[0]}`
  - index.js targetsData：`targetsData[t.id].day_ohlc = tech.day_ohlc`；tech_symbol 代理合并行加 `day_ohlc: tech.day_ohlc ?? proxy.day_ohlc`
  - analyzer.js 两处返回对象加 `day_ohlc: td.day_ohlc ?? null`
  - saveScoreHistory：`if (r.current_price != null) { const p = { v: r.current_price, s: null }; if (r.day_ohlc) { p.o = r.day_ohlc.o; p.h = r.day_ohlc.h; p.l = r.day_ohlc.l; p.d = r.day_ohlc.d; } ind['价格走势'] = p; }`
  - analyzer `price` desc 改为：`标的每日收盘价（QQQ/VOO/GLD 为美元，A 股/红利低波为人民币；恒生指数为点数，红利低波 930955 用 563020 ETF 代理收盘价）。红涨绿跌蜡烛图，叠加 MA5/10/20 均线（橙/蓝/紫），支持 日K(90天)/周K(52周)/月K(60月) 切换。用于对照估值与趋势，不参与战略评分`
- [ ] **Step 4: 跑测试确认通过**

### Task 2: /api/ohlc 端点（周/月K 按需代理 + D1 缓存）

**Files:**
- Modify: `worker/src/fetchers.js`（新增方法）
- Modify: `worker/src/index.js`（路由，/api/history 附近 ~L297）
- Test: `worker/test/ohlc.test.mjs`（新建）

**Interfaces:**
- Consumes: analyzer.js TARGETS 配置的 `symbol` / `tech_symbol`
- Produces: `fetcher.getOhlcSeries({ symbol, techSymbol, period }) -> Promise<[{date,o,h,l,c}]>`（已 slice 到 52/60 根）
- Produces: HTTP `GET /api/ohlc?target&period`

- [ ] **Step 1: 写失败测试**（ohlc.test.mjs；mock D1 复用 history.test.mjs 的 mockD1 模式，stub `globalThis.fetch` 按 URL 分发 fixture）
  - `weekly 腾讯源`：fixture `{data:{sh512890:{qfqweek:[['2026-11-13','1.21','1.23','1.24','1.20','100'], ...共60条]}}}` → `GET /api/ohlc?target=dividend_low_vol_etf&period=weekly` → 200，candles.length === 52，`candles[0]` deepEqual `{date:'2026-11-13', o:1.21, c:1.23, h:1.24, l:1.20}`；fetch URL 含 `sh512890,week`
  - `tech_symbol 代理`：target=dividend_low_vol_100 → fetch URL 含 `sh563020`
  - `monthly Yahoo 源`：target=qqq&period=monthly → URL 含 `interval=1mo`；fixture 70 个月 → candles.length === 60，o/h/l/c 正确
  - `非法参数`：period=daily → 400 success:false；target=bogus → 400
  - `缓存命中不再 fetch`：同一 target+period 调两次，fetch 计数为 1
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**
  - `fetchers.js` 新增 `getOhlcSeries({ symbol, techSymbol, period })`：A股（.SS/.SZ）走腾讯 `fqkline/get?param={mk}{code},{week|month},,,400,`，键 `qfqweek||week` / `qfqmonth||month`，行 `[date,open,close,high,low]` → `{date, o:+r[1], c:+r[2], h:+r[3], l:+r[4]}`；其他走 Yahoo `chart/{symbol}?range={5y|10y}&interval={1wk|1mo}`（timestamp + quote OHLC，遇 null 跳过该点）；末尾 `slice(period==='weekly' ? -52 : -60)`
  - index.js 路由 `/api/ohlc`：校验 target ∈ TARGETS ids、period ∈ {weekly, monthly}，否则 400；`getCachedDaily(env, `ohlc_${target}_${period}`, period==='weekly'?12:24, () => fetcher.getOhlcSeries({symbol: cfg.symbol, techSymbol: cfg.tech_symbol, period}), r => Array.isArray(r) && r.length > 10)`；返回 `json({success:true, target, period, candles})`
- [ ] **Step 4: 测试通过**

### Task 3: 回填脚本 OHLC + 3 天窗口验证

**Files:**
- Modify: `worker/scripts/backfill-history.mjs`（yahooDaily ~L49、tencentKline ~L142、行构造 ~L449）
- Modify: `worker/scripts/backfill-price.mjs`
- Test: `worker/test/history.test.mjs`

**Interfaces:**
- Consumes: Task 1 快照格式
- Produces: `addPriceIndicator(ind, td, ohlc)`，ohlc = `{o,h,l,c,d} | null`

- [ ] **Step 1: 改测试为失败**：`addPriceIndicator` 第三参 `{o,h,l,c,d}` → 写入 `{v:c, s:null, o,h,l,d}`；第三参 null/缺省 → 只 `{v,s:null}`
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**
  - `yahooDaily`：quote 取 open/high/low/close，返回 `{date, open, high, low, close}`（现有消费方读 `.close`，不变）
  - `tencentKline`：返回 `{date, open: +r[1], close: +r[2], high: +r[3], low: +r[4]}`（加 open/low；现有消费方读 .close/.high 不变）
  - 行构造：为每标的准备 OHLC as-of（qqq/voo/gld/hsi 从对应 yahooDaily 序列；6 个 CN 标的从 cnK[tencentKline]，dividend_low_vol_etf→sh512890、dividend_low_vol_100→563020 的序列），asOf 到当日取 `{o,h,l,c,d:源点date}`；调用 `addPriceIndicator(ind, targetsData[r.target_id], ohlc)`
- [ ] **Step 4: 测试通过**
- [ ] **Step 5: 3 天窗口验证**：`node scripts/backfill-history.mjs 2026-11-13 2026-11-15`（含周末），产物 33 行；抽验：qqq 11-14/11-15 行的「价格走势」`d === '2026-11-13'`（周末 as-of 周五）；4 个代表标的（qqq/512890/dividend_low_vol_100/hsi）11-13 行含完整 o/h/l/d

### Task 4: 前端 K 线图 + 三周期切换

**Files:**
- Modify: `frontend/index.html`（CDN ~L218；historyHtml ~L358-367；renderScoreHistory ~L417-511；事件委托 ~L513）

**Interfaces:**
- Consumes: Task 1 快照格式、Task 2 `/api/ohlc`
- Produces: 内部 `renderKline(candles, period)`；`_selPeriod = {}`（targetId → 'daily'|'weekly'|'monthly'，默认 daily）；`_ohlcCache = {}`（key target_period，5min）

- [ ] **Step 1: CDN 引入与注册验证**（index.html L218 chart.js 之后）：
  `<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>`
  `<script src="https://cdn.jsdelivr.net/npm/chartjs-chart-financial@4.2.0/dist/chartjs-chart-financial.min.js"></script>`
  起本地静态服务器开页面，console 验证 candlestick controller 注册成功；若 jsdelivr 该路径失败换 unpkg.com 同包；仍失败则停下报告主代理（不要手写蜡烛 controller）
- [ ] **Step 2: 周期切换 UI**：historyHtml 在 `#indicatorTabs` 与图表容器之间加 `<div id="pricePeriodTabs" style="display:none;">`（日K/周K/月K 三个小按钮，样式同 hist-tab）；事件委托加 `#pricePeriodTabs button` 分支：`_selPeriod[targetId] = b.dataset.period; renderScoreHistory(targetId)`
- [ ] **Step 3: renderScoreHistory 价格走势分支**：sel==='价格走势' 时显示 #pricePeriodTabs（否则隐藏）；图表容器高度 K线 220px / 折线 150px 动态切换
  - daily：points 按 `d` 去重（同 d 保留首行）；若去重后 ≥2 点且全部含 o/h/l → K线；否则走原折线逻辑（fallback）
  - weekly/monthly：`_ohlcCache` 或 fetch `${appState.apiBase}/ohlc?target=${targetId}&period=${period}`；等待时图表区显示「周K/月K 加载中…」；candles → K线
  - renderKline：candlestick dataset（`color: {up:'#dc2626', down:'#16a34a', unchanged:'#9ca3af'}`）+ MA5/10/20 三条 `{type:'line'}` dataset（x 同蜡烛时间戳序列，前 n-1 点为 null，pointRadius 0，borderWidth 1.5）；数据 `{x: new Date(date).getTime(), o, h, l, c}`；x 轴 `type:'time'`，unit 按 period（day/week/month）；tooltip callbacks：title=完整日期，label 行显示 开/高/低/收 及当时 MA 值
- [ ] **Step 4: 本地实测**（本地静态服务器 + `npx wrangler dev --remote`（env CLOUDFLARE_API_TOKEN 用 credentials.md 占位符对应值，输出不打印）让 /api/ohlc 拿到真数据；前端 apiBase 指向 localhost:8787）：
  - /api/ohlc 直测：qqq weekly 52 根、512890 monthly 60 根、dividend_low_vol_100 weekly 走 sh563020
  - 日K渲染：手工把 `_historyCache.qqq.indicators['价格走势']` 的点补上 o/h/l/d（o=v±随机、最外 2 行保持无 o/h/l 以同时验证 fallback）→ renderScoreHistory('qqq') → canvas 红+绿像素 > 1000、MA 三色线存在
  - 周/月K真实数据渲染：52/60 根、tooltip 显示开高低收
  - 切其他指标 → 折线正常；切回价格走势 → K线正常；console 无错误
  - 截图 3 张存 `D:/ClaudeCodeDesktop/nasdaq-indicator-workers/picture_v2100_*.jpeg`（QQQ日K、QQQ月K、512890周K）

### Task 5: 运维（主代理验收 Task 1-4 后另行派发）

全量回填 90 天 → wrangler d1 execute → wrangler deploy（Worker）+ pages deploy（前端）→ 生产验证 → commit + tag v2.10.0 + push → 更新验收报告 + memory。
