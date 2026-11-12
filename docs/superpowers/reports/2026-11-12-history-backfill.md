# 全部指标 90 天回溯 + 历史回填 验收报告

**日期:** 2026-11-12
**版本:** v2.6.0（v2.5.1 后补充战术情绪指标回溯）
**计划:** [2026-11-12-indicator-history-90d.md](../plans/2026-11-12-indicator-history-90d.md)

## 战术情绪指标回溯（v2.6.0 补充）

用户反馈「战术情绪这几个指标没有」，已补入 90 天回溯：

- **analyzer**：`analyzeTarget` 新增 `sentiment` 字段（vix / vix3m / vix_ratio / fear_greed / put_call）——所有标的都计算（市场级快照），但只有 `tactical_fg !== false` 的标的参与倍数叠加；`tactical` 字段语义不变
- **每日快照**：`saveScoreHistory` 把 sentiment 并入 indicators JSON，名称「VIX波动率」「VIX/VIX3M」「恐惧与贪婪指数」「看跌/看涨期权比率」，`{v, s:null}`（情绪指标不参与战略评分，无得分）
- **90 天回填**：VIX/VIX3M 用 Yahoo 日线（真值）；F&G 与 Put/Call 用 CNN graphdata 历史（约 252 天日度，真值）；逐日 as-of，11 标的每行都带同一组情绪值
- **前端零改动**：按钮行从 indicators 自动生成，情绪指标自动出现（QQQ 共 11 个按钮）；tooltip 对 `s=null` 只显示值
- **验证**：生产 `/api/history` 四指标各 90 点；浏览器实测 F&G 曲线 90 点（64.3→36.6）、VIX 曲线 12.5-30.3；54 个单测全绿
- 口径说明：回填 P/C 为 CNN 序列（CBOE 5 日平均口径），生产当日值优先 CBOE 实时源，两者小差属跨源正常

## 目标（用户 /goal）

> 每个投资标的里面的所有指标都可以回溯 90 天的所有数据，包括最后用公式算出来的分数，然后做几个按钮切换指标并进行回溯。把历史的数据补全。

## 交付内容

### 1. 后端 `/api/history` 返回全部指标历史

`GET /api/history?days=90` 每个标的返回：

```json
{
  "qqq": {
    "series": [{ "date": "2026-11-12", "score": 62.76, "multiple": 1 }],
    "indicators": {
      "PE综合估值": [{ "date": "2026-11-12", "v": 28.44, "s": 68.22 }],
      "CAPE周期调整市盈率": [{ "date": "…", "v": 39.82, "s": 98.73 }]
    }
  }
}
```

- `indicators` 来自 `score_history.indicators` JSON（每日快照早已存储），按指标名分组
- 兼容无 indicators 的旧行（空对象）和坏 JSON 行（跳过不影响其它行）

### 2. 前端指标切换按钮

弹窗「90 天指标回溯」区块：横向按钮 = 综合评分 + 该标的所有指标名，点击切换曲线：

- 综合评分视图保留 40 加速线 / 75 高位线
- 指标视图动态 y 轴（按指标值范围留 15% 边距）
- tooltip 同时显示指标值 + 当期得分：`PE综合估值: 28.44　得分 68.22`
- 空状态两种文案：
  - 综合评分无数据 → 「评分历史积累中（每天 7:30 记录一次）」
  - 指标无历史 → 「「X」暂无历史数据（该数据源仅提供当日快照）」
- 按标的记忆所选指标（`_selIndicator`），重建 Chart 前 `Chart.getChart(canvas).destroy()`

### 3. 90 天历史回填（2026-08-15 ~ 2026-11-12，990 行）

离线脚本 `worker/scripts/backfill-history.mjs`：拉取各数据源每日历史序列，对每个自然日 as-of 构造 `globalData` + `targetsData`，**直接调用生产 `analyzer.analyzeTarget` 重放评分公式**（无未来函数：分位/前值只用 `<= 当日` 的点），产物拆成每 100 行一条 INSERT（D1 单语句限长 `SQLITE_TOOBIG`）。

| 指标 | 回填数据源 | 性质 |
|---|---|---|
| PE综合估值（QQQ/VOO） | 生产 API 当日 trailing PE 反推 EPS 锚 × 当日收盘价 | 估计（最新 TTM EPS 恒定） |
| CAPE | multpl.com 月度表 as-of | 真值（月度精度） |
| Forward P/E | historyofmarket 合并序列 as-of（周度 terminal + 日度 forwardOwn） | 真值 |
| 实际股权风险溢价 | 1/PE − DFII10（FRED） | PE 为估计，TIPS 为真值 |
| EY spread vs Baa | 1/ForwardPE − DBAA（FRED） | 真值 |
| 10年TIPS实际利率 / 10Y / Baa | FRED（DFII10 / DGS10 / DBAA） | 真值 |
| 黄金实际价格分位 | GC=F 月线 × multpl CPI | 真值 |
| 美元指数 5 年分位 / 铜价 10 年分位 | Yahoo DX-Y.NYB / HG=F | 真值 |
| A 股银行/长电/紫金 PE_TTM、PB_MRQ、ROE | 东财 RPT_VALUEANALYSIS_DET（2019 起逐日，1906 天） | 真值 |
| 银行 PB 历史分位 | 东财 PB_MRQ 序列（2019 起 1900+ 点） | 真值 |
| 200日趋势风控 / RSI / 52周高 | Yahoo 日线（US）/ 腾讯日 K（A 股）重算 | 真值 |
| 港股 PE/ERP/股息率、红利低波估值分位、派息率 | **无历史源** | 留空不造假 |

**红线执行：** 无历史源指标（韭圈儿/蛋卷/中证官方估值分位、腾讯实时股息率）回填为 `null`，不写 0、不插值。前端对应按钮显示「该数据源仅提供当日快照」，11-13 起由每日快照自然积累真实数据。

### 4. Forward P/E 生产口径统一（v2.5.0 附带修复）

生产原为「StockAnalysis 当日值 + historyofmarket 历史序列分位」混搭，与回填（仅能取 historyofmarket）存在 ~5% 跨源差（QQQ 20.57 vs 19.56），导致回填曲线与生产当日点跳变。v2.5.0 起生产值也取 historyofmarket 合并序列当日值，值/分位同源；顺带省 2 个子请求。

## 验证证据

### 生产 API（2026-11-12 部署后实测）

```
success: true, days: 90
qqq  series 90 点 2026-08-15 → 2026-11-12，指标 6 个各 90 点
     PE综合估值 90 / CAPE 90 / Forward P/E 90 / 实际ERP 90 / EY spread 90 / 200日趋势 90
voo 90 / gld 90 / hsi 90 / dividend_low_vol_etf 90 / dividend_low_vol_100 90
abc_bank 90 / ccb_bank 90 / yangtze_power 90 / cmb_bank 90 / zijin_mining 90
```

### 回填 vs 生产当日一致性（QQQ 2026-11-12）

| 指标 | 回填 | 生产 refresh | 说明 |
|---|---|---|---|
| PE综合估值 | 28.44 / 68.22 | 28.44 / 68.22 | 完全一致（EPS 锚统一） |
| CAPE | 39.82 / 98.73 | 40.24 / 98.8 | multpl 月度 vs 实时抓取 |
| Forward P/E | 19.56 / 41.67 | 19.56 / 41.67 | 完全一致（同源改造后） |
| 实际ERP | 0.86 / 52.1 | 0.74 / 53.9 | TIPS：FRED 收盘(11-11) 2.66 vs 实时 2.78 |
| EY spread vs Baa | -1.28 / 75.64 | -1.28 / 75.64 | 一致 |
| 200日趋势风控 | 1.27 / 32.54 | 1.27 / 32.54 | 一致 |
| **综合评分** | **62.76** | **63.13** | 差 0.37（TIPS/CAPE 实时 vs 收盘静态） |

### 前端（本地 static server + 生产 API，浏览器实测）

- QQQ 弹窗：7 个按钮，点击「PE综合估值」→ 90 点曲线 30.12 → 28.44，y 轴动态 25.97-31.98
- HSI 弹窗：
  - 综合评分 → 「评分历史积累中（每天 7:30 记录一次）」✓
  - 「PE历史分位」（全 null）→ 「「PE历史分位」暂无历史数据（该数据源仅提供当日快照）」✓
  - 「200日趋势风控」→ 90 点曲线 ✓
- 测试：52 个单测全绿（含 /api/history 指标分组、坏 JSON 容错、子请求预算）

## 已知限制

1. QQQ/VOO trailing PE 回填为「最新 TTM EPS 恒定 × 当日价格」估计，历史 EPS 实际会变动（尤其季报前后），曲线在财报日附近可能有小幅平台跳变；标注来源为「回填估计」。
2. CAPE 为月度序列 as-of，月内不变属正常。
3. HSI / 两只红利低波的估值类指标（PE/PB/股息率/派息率）90 天内无真值，曲线从 11-13 起积累。
4. 回填按自然日存储（与生产 cron 一致），周末/节假日为前值 as-of。

## 以后如何重跑

```bash
cd worker
node scripts/backfill-history.mjs <start> <end>        # 默认 89 天前 ~ 今天
CLOUDFLARE_API_TOKEN=<token> npx wrangler d1 execute nasdaq_cache --remote --file backfill_<start>_<end>.sql
```

脚本幂等（`INSERT OR REPLACE`，UNIQUE(target_id,date)），重跑覆盖同日期行。
