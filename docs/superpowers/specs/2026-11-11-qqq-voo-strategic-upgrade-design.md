# QQQ/VOO 战略评分升级设计

日期：2026-11-11
状态：用户已选择「战术模块 + 战略补强（推荐）」

## 1. 意图

QQQ/VOO 当前战略评分只有 PE、CAPE、实际 ERP、MA200 四项。用户希望把 VIX、CNN 恐惧贪婪指数等情绪指标纳入视野，并判断是否需要补充其他评分指标。

目标不是「指标越多越好」，而是：
1. 不把 1–3 个月的情绪信号混进 10 年估值评分；
2. 让用户能在 QQQ/VOO 弹窗里看到情绪指标，并理解它们只在极端时影响定投倍数；
3. 补上真正有长期估值证据的指标：Forward P/E、EY spread vs Baa；
4. 修正 QQQ 用 S&P CAPE 代理纳指估值却给 30% 权重的不一致。

## 2. 研究结论（权威资料）

| 来源 | 结论 | 对本设计的含义 |
|---|---|---|
| CBOE VIX 方法论 | VIX 衡量未来 30 天预期波动率，常称「恐惧指数」 | 情绪/波动率指标，不是估值指标 |
| BofA Bull & Bear（Flow Show） | 逆向情绪指标，>8 卖 / <2 买，**信号持续 1–3 个月** | 情绪是战术级别 |
| Goldman Sachs Sentiment Indicator / TimeX | 衡量 positioning，短期择时 | 情绪/仓位用于短期 |
| JPM Guide to the Markets（2026-09-30） | 战略估值用 Forward P/E 19.0x、CAPE 40.9x、股息率 1.4%、EY spread −1.0%；消费者信心只预测未来 12 个月回报 | 长期估值看 PE/CAPE/ERP；情绪最多 12 个月 |
| Vanguard VEMO（2026-09-30） | 10 年回报由估值/盈利/利润率/贴现率驱动；估值短期/中期预测力差 | 十年定投重估值 |
| AQR《Market Timing: Sin a Little》 | 估值择时 5–10 年样本内有效、样本外弱；加动量改善；只做温和偏离 | 支持「估值 + 趋势 + 温和战术」 |
| Morgan Stanley Ten Rules of Thumb | VIX 在极端时是逆向情绪指标 | 极端恐慌可战术加仓 |

**决定：VIX 与 CNN F&G 不进入战略评分，进入战术层。**

## 3. 设计决策

### 3.1 战术层（不影响战略评分）

- QQQ/VOO 弹窗新增「战术情绪（不计入战略评分）」区块，展示：
  - VIX、CNN F&G、Put/Call、VIX/VIX3M 比值
  - 当前战术系数与触发原因
- 现有 F&G 规则保留：F&G ≤25 → 加速部分 ×1.25；F&G ≥75 → ×0.75；1x 底仓不因贪婪减速。
- 新增 VIX/VIX3M 确认：VIX/VIX3M > 1.15 → ×1.15，可与 F&G 叠加，总系数上限 1.5。
- 战术层只调整定投倍数，不改变 `composite_score`。

### 3.2 战略层新增指标

**Forward P/E**
- 来源：StockAnalysis.com ETF 页面（`https://stockanalysis.com/etf/{symbol}/`），每日抓取 `Forward PE` 行。
- 原因：Yahoo 对 QQQ/VOO 等 ETF 的 `summaryDetail.forwardPE` 返回空对象，不可用。
- 交叉验证：JPM Guide 2026-09-30 S&P 500 19.0x；SPY 单张 FY1 20.38x；Siblis NDX 21.24x；StockAnalysis QQQ 19.80x / VOO 18.12x。
- 缺失时：该指标分数为 null，权重按现有逻辑重新归一化；不阻塞其他指标。

**EY spread vs Baa**
- 定义：`100 / forward_pe - Moody's Baa 公司债收益率`；forward PE 缺失时用 trailing PE。
- 来源：优先 FRED `DBAA`（Moody's Baa 公司债收益率）。
- 备选：FRED 在 Workers 出口常返回 520，此时用 JPM Guide 2026-09-30 隐含 Baa≈6.26%（forward P/E 19.0x、EY spread −1.0%）加 10Y 国债变动近似：
  `baa = 6.26 + (current_10y - 5.3)`。季度校准，弹窗标注来源。
- 作用：JPM 估值表口径；与现有「EY − TIPS」互补，提供信用调整后的估值视角。
- 评分曲线（0=便宜，100=贵）：
  - ≥3% → 10；2% → 20；1% → 35；0.7%（JPM 30 年均值）→ 42；0% → 55；−1% → 72；−2% → 85；≤−3% → 95。

### 3.3 QQQ/VOO 权重（暂定，先做敏感性分析）

QQQ（S&P CAPE 是代理，降权）：
```
pe_composite 30%, cape 15%, forward_pe 15%,
erp_real 20%, ey_spread_baa 10%, ma200_risk 10%
```
VOO（CAPE 仍是主锚）：
```
pe_composite 15%, cape 35%, forward_pe 10%,
erp_real 20%, ey_spread_baa 10%, ma200_risk 10%
```

权重先按上述方案实现，并在本计划 Task 5 输出「旧权重 vs 新权重」的评分敏感性对比；不做历史收益回测（缺少历史 forward PE/Baa 序列），避免把敏感性分析伪装成回测。

### 3.4 数据透明度

- PE 指标返回 `source` 与 `as_of`（Yahoo trailingPE 的抓取时间），弹窗显示。
- 新指标 `forward_pe`、`ey_spread_baa` 同样显示来源。
- 数据覆盖不足 50% 时仍返回「等待数据」，不触发加速（v2.1.3 已实现）。

## 4. 非目标

- 不把 VIX/F&G 加进 `composite_score`。
- 不改其他标的（GLD/HSI/红利/银行/长电/紫金）的评分公式；只做数据核对。
- 不做真正的历史收益回测；本期只做权重敏感性分析。
- 不引入新的前端框架；沿用现有 Bootstrap 单页。

## 5. 风险与约束

- Yahoo `forwardPE` 对 ETF 返回空对象：改用 StockAnalysis.com 日更；失败时该指标 N/A，不阻塞。
- FRED `DBAA` 在 Workers 出口不可用：用 JPM 隐含 Baa 锚 + 10Y 调整；失败时指标 N/A。
- `^VIX3M` 可能无数据：战术块显示 N/A，系数不受影响。
- 东财 PB 偶发空 data：腾讯快照优先（PB/PE/股息率一次请求），东财兜底。
- Yahoo `.SS` 技术指标偶发失败：腾讯未复权日线优先，MA200/回撤与 Yahoo 口径对齐。
- 新权重可能让 QQQ/VOO 分数短期跳变：上线前记录旧值，上线后对比并报告。
- 1x 底仓保护：任何战术系数都不能把 1x 降到 1x 以下。
- 数据覆盖 <90% 时强制 1x，避免单一数据源缺失触发加速。

## 6. 验收标准

1. QQQ/VOO 弹窗出现战术情绪区块，显示 VIX/F&G/Put-Call/VIX3M 比值和当前系数。
2. `composite_score` 不包含 VIX/F&G；战术系数只影响 `strategy.multiple`。
3. QQQ/VOO 指标列表出现 `Forward P/E`、`EY spread vs Baa`，并显示来源；生产值非空（Forward PE 来自 StockAnalysis，EY spread 的 Baa 来自 FRED 或 JPM 锚+10Y 调整）。
4. QQQ 的 S&P CAPE 权重从 30% 降到 15%；VOO 的 CAPE 仍为 35%。
5. 生产 `/api/data` 返回 `tactical`、`forward_pe`、`baa_yield`、`data_coverage` 字段；页面无 JS 错误。
6. 旧权重 vs 新权重的评分对比表输出到验收报告。
7. 所有标的 `data_coverage` ≥90%（本次核验为 100%）；A股 PB/MA200 有腾讯兜底，缺失时不超过 1x。
