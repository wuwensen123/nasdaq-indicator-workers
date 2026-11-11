# QQQ/VOO 战略评分升级与数据核验报告

日期：2026-11-11
版本：v2.2.0
线上 Worker：`e10d9f54-d850-40e8-8eea-a3b2c3c95fc1`（之后如有重部署，以最新为准）

## 1. 本次改动

### 1.1 战术层（不进入战略评分）

- QQQ/VOO 弹窗新增「战术情绪（不计入战略评分）」：
  - VIX、CNN F&G、Put/Call、VIX/VIX3M 比值
  - 当前战术系数与触发原因
- 规则：
  - F&G ≤25 → 加速部分 ×1.25；F&G ≥75 → ×0.75
  - VIX/VIX3M >1.15 → ×1.15，可与 F&G 叠加，总系数上限 1.5
  - 1x 底仓不因贪婪减速
- 战术层只影响 `strategy.multiple`，不进入 `composite_score`。

### 1.2 战略层新增指标

- **Forward P/E**：StockAnalysis.com ETF 页面日更；Yahoo 对 QQQ/VOO 的 `summaryDetail.forwardPE` 返回空对象，不可用。
- **EY spread vs Baa**：`100/forward_pe − Baa`；FRED `DBAA` 在 Workers 出口不可用，回退为 JPM Guide 2026-09-30 隐含 Baa 6.26% + 10Y 国债变动。
- QQQ 的 S&P CAPE 权重从 30% 降至 15%（它是标普代理，不是纳指自身估值）；VOO 的 CAPE 维持 35%。

### 1.3 数据健壮性

- 东财 PB 偶发失败 → 腾讯快照优先（字段 46=PB、39=PE、64=股息率），东财单次兜底。
- Yahoo `.SS` 技术指标偶发失败 → 腾讯未复权日线优先，MA200/回撤与 Yahoo 口径一致。
- 数据覆盖 <90% → 强制维持 1x，并在弹窗显示黄色警告；不再因单一数据源缺失触发加速。
- 弹窗指标显示 `source` 与 `as_of`。

## 2. 线上结果（2026-11-11）

### 2.1 QQQ / VOO

| 标的 | 旧评分 | 新评分 | 定投倍数 | 数据覆盖 |
|---|---:|---:|---|---:|
| QQQ | 69.48 | **62.12** | 1x | 100% |
| VOO | 76.75 | **73.13** | 1x | 100% |

QQQ 指标：

| 指标 | 值 | 分数 | 来源 |
|---|---:|---:|---|
| PE 综合估值 | 27.79 | 65.39 | Yahoo Finance |
| CAPE | 39.7 | 98.7 | multpl.com |
| Forward P/E | 19.80 | 39.0 | StockAnalysis.com |
| 实际 ERP | 0.82% | 52.7 | Treasury.gov（TIPS 2.78%） |
| EY spread vs Baa | −0.89% | 70.13 | JPM 锚 6.26% + 10Y 调整 |
| MA200 偏离 | −0.98% | 42.94 | Yahoo Finance + 计算 |

VOO 指标：

| 指标 | 值 | 分数 | 来源 |
|---|---:|---:|---|
| PE 综合估值 | 23.81 | 91.62 | Yahoo Finance |
| CAPE | 39.7 | 98.7 | multpl.com |
| Forward P/E | 18.12 | 63.69 | StockAnalysis.com |
| 实际 ERP | 1.42% | 43.7 | Treasury.gov（TIPS 2.78%） |
| EY spread vs Baa | −0.42% | 62.14 | JPM 锚 6.26% + 10Y 调整 |
| MA200 偏离 | +2.58% | 35.16 | Yahoo Finance + 计算 |

战术层当前值：VIX 18.45、F&G 36.71、Put/Call 1.10、VIX/VIX3M 0.89；系数 1.00，无极端信号。

### 2.2 其他标的（核验后）

| 标的 | 评分 | 覆盖率 | 倍数 | 关键数据 |
|---|---:|---:|---|---|
| 黄金 GLD | 73.7 | 100% | 1x | 实际利率 2.78%、金价实际分位 97.8、MA200 −9.99% |
| 恒生指数 | 43.68 | 100% | 1x | PE 11.18、港股 ERP 3.96%、MA200 −3.69% |
| 红利低波 512890 | 42.17 | 100% | 1x | DY 4.80%、PE 分位 79.1、MA200 +4.55% |
| 红利低波100 930955 | 43.87 | 100% | 1x | DY 4.92%、PE 分位 87.2、MA200 +2.84% |
| 农业银行 | 44.47 | 100% | 1.5x | PB 0.88、ROE 10.6%、回撤 −16.36% |
| 建设银行 | 45.78 | 100% | 1x | PB 0.85、ROE 9.7%、MA200 +18.47% |
| 长江电力 | 52.18 | 100% | 1x | PE 22.09、PB 3.16、派息率 79.5%（风险） |
| 招商银行 | 35.97 | 100% | 1.5x | PB 0.91、ROE 13.0%、DY 4.74% |
| 紫金矿业 | 76.34 | 100% | 1x | PB 3.55、铜价分位 96.4、MA200 −14.81% |

## 3. 数据核验

### 3.1 QQQ / VOO 估值

- QQQ PE 27.79 vs Yahoo 27.98：同一 trailing 口径，差 0.7%，抓取时点差异。
- VOO PE 23.81：Yahoo trailing；JPM 2026-09-30 的 19.0x 是 forward，不可直接比较。
- CAPE 39.7 vs JPM 2026-09-30 的 40.9x：日期差，基本一致。
- 实际 ERP：QQQ 1/27.79 − 2.78% = 0.82%；VOO 1/23.81 − 2.78% = 1.42%，计算正确。
- Forward PE 交叉验证：
  - QQQ：StockAnalysis 19.80 vs Siblis NDX 21.24（2026-10-31）vs historyofmarket 18.8（2026-11-10）/22.4（FAQ）；口径差异较大，取 StockAnalysis 日更，弹窗标注交叉验证值。
  - VOO：StockAnalysis 18.12 vs JPM S&P 19.0 vs SPY 单张 FY1 20.38；一致。
- EY spread：JPM 2026-09-30 为 −1.0%（forward P/E 19.0x、Baa≈6.26%、10Y 5.3%）。当前 10Y 4.98% → Baa≈5.94%，spread −0.89%/−0.42%，方向一致。
- MA200：QQQ −0.98%、VOO +2.58%；Yahoo 日线计算。

### 3.2 其他标的数据源

- A股 PB/PE/股息率：腾讯快照（字段 46/39/64），东财兜底。
- A股 MA200/52周：腾讯未复权日线，已与 Yahoo 原值对齐：
  - 农业银行 7.45% vs Yahoo 7.4%
  - 建设银行 18.47% vs Yahoo 18.49%
  - 长江电力 6.61% vs Yahoo 6.62%
  - 招商银行 8.07% vs Yahoo 8.08%
  - 紫金矿业 −14.81% vs Yahoo −14.80%
- 红利低波/930955：中证官方 P/E2、D/P2 + 韭圈儿独立分位/ROE（v2.1.3 已修）。
- 黄金/恒生：Yahoo + 现有分位表。

## 4. 核验中发现并修复的问题

1. **东财 PB 偶发返回空 data** → 评分里 `个股PB水平`/`ROE` 变 null，权重重归一化，银行评分跳变。
   - 修复：腾讯快照优先（一次请求拿 PB/PE/股息率），东财兜底；同一 refresh 内缓存。
2. **Yahoo `.SS` 技术指标偶发失败** → MA200/回撤 null，影响 A股/红利ETF。
   - 修复：腾讯未复权日线优先；MA200 与 Yahoo 原值对齐。
3. **数据源缺失时评分仍可能加速** → 例如 PB 缺失时农业银行/招商银行曾显示 1.5x。
   - 修复：覆盖率 <90% 强制 1x，并显示警告。
4. **QQQ 的 S&P CAPE 权重与备注不一致**（备注说只作交叉验证，权重 30%）。
   - 修复：降至 15%，新增 Forward PE 15% + EY spread 10%。

## 5. 已知口径差异（非 bug）

- **Forward PE**：StockAnalysis 与 Siblis/JPM 的聚合方法不同（ETF 持仓加权 vs 指数总市值/总盈利），QQQ 差异约 7%；已用多源交叉验证并在弹窗标注。
- **Baa**：FRED DBAA 在 Workers 出口不可用，当前用 JPM 隐含 Baa 锚 + 10Y 调整；季度校准，非每日 Moody's 官方值。
- **银行 PB 历史分位**：`PB历史分位` 仍是中证银行指数（所有银行相同 0.7219）；个股绝对 PB 用 `个股PB水平` 区分。后续可接个股 PB 历史序列。
- **QQQ CAPE**：仍是 S&P 500 CAPE 代理，权重已降至 15%，并在备注中说明。

## 6. 验证记录

```bash
cd worker && npm test
# 20 tests passed

npx wrangler deploy --dry-run
# bundle OK

# 生产刷新
curl -s "https://api.motris.dpdns.org/api/refresh"
# success=true, elapsed≈5.5s
```

- Worker 版本：`e10d9f54-d850-40e8-8eea-a3b2c3c95fc1`
- Pages 部署：`f3d0c671.nasdaq-indicator.pages.dev`（生产别名 motris.dpdns.org）
- 前端弹窗已核验：QQQ 显示 6 项指标 + 战术情绪区块 + 数据源；农业银行显示 1.5x 回撤原因。

## 7. 后续建议

1. 观察 1–2 周 Forward PE / EY spread 的稳定性，再决定是否调整 15%/10% 权重。
2. 用真实历史序列回测 Forward PE / EY spread（当前只做了权重敏感性，不是收益回测）。
3. 把银行 `PB历史分位` 从中证银行指数换成分股自身历史 PB（需要历史序列）。
4. 若 Cloudflare Workers 升级到付费计划（子请求上限 1000），可恢复更细的交叉验证请求。
