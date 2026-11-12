# 三个 P0 数据口径缺口修复验收报告

日期：2026-11-12
版本：v2.3.0
线上 Worker：`353f26de-4659-4dd6-8215-a5ad37b6b4de`
计划：[2026-11-12-data-veracity-gaps.md](../plans/2026-11-12-data-veracity-gaps.md)

## 1. 修复内容

| # | 缺口 | 修复前 | 修复后 |
|---|---|---|---|
| 1 | Baa 收益率 | FRED CSV 在 Workers 出口不可用，只有 JPM 锚近似 | 支持 `FRED_API_KEY`（Worker secret）调 FRED 官方 API 每日真值；无 key 时仍回退 JPM 锚 |
| 2 | 银行 PB 历史分位 | 三家银行共享中证银行指数分位 72.19 | 各家个股自身历史分位（东财估值分析 2018 至今，2149 个交易日），D1 缓存 + scheduled 每日刷新 |
| 3 | Forward PE 分位 | 静态锚点表（NDX 按 trailing×0.88 近似） | 真实历史周度序列动态分位（NDX 1303 点 2001 起 / SPX 1559 点 1990 起，historyofmarket.com CC BY 4.0），StockAnalysis 当日值打分 |

## 2. 生产验证（2026-11-12 refresh，fetch 9.0s，覆盖率 11/11 = 100%）

### 2.1 银行个股 PB 分位（修复前全部 72.19）

| 标的 | 修复前评分 | 修复后评分 | PB 分位（新） | 当前 PB | 说明 |
|---|---:|---:|---:|---:|---|
| 农业银行 | 44.47 | 49.80 | **89.86** | 0.877 | 2025 银行重估后处历史高位（2018 以来） |
| 建设银行 | 45.97 | 49.47 | **77.66** | 0.855 | 偏高 |
| 招商银行 | 36.09 | 30.72 | **18.52** | 0.910 | 历史低位（2018 以来中位 1.28） |

三家分位首次真正区分开：农行/建行在重估后高位、招行仍在地板——指数级分位掩盖了这个结构差异。

### 2.2 Forward PE 动态分位

| 标的 | Forward PE（StockAnalysis） | 旧静态分位 | 新动态分位 | 序列点数 |
|---|---:|---:|---:|---:|
| QQQ | 20.57 | 42.85 | **50.12** | 1303（2001-04 起） |
| VOO | 18.55 | 67.56 | **66.13** | 1559（1990-06 起） |

- 序列 = historyofmarket `forward`（terminal 12M blended consensus，周度）+ `forwardOwn`（ETF 持仓加权，日更），两段在 2026-08-05 交汇点差 0.18%（NDX 22.41 vs 22.37）/0.6%（SPX），合并为连续序列。
- 口径交叉验证：StockAnalysis 当日值 vs historyofmarket forwardOwn：NDX 19.80 vs 19.56（+1.2%）、SPX 18.53 vs 18.47（+0.3%）。
- 失败兜底：序列抓取失败时回退原静态锚点表（`静态锚点表(无历史序列时兜底)` 标注）。

### 2.3 Baa

- 当前 `baa_yield.value = null`（未配置 FRED key，属预期）；`EY spread vs Baa` 显示 `JPM锚(2026-09-30)+10Y调整`（−1.10%），兜底路径正常。
- **待用户操作**：注册免费 FRED API key（https://fred.stlouisfed.org/docs/api/api_key.html），在 Cloudflare 配置 Worker secret `FRED_API_KEY`，下次 refresh 即切换为每日真值（source 变为 `FRED API (DBAA)`）。

### 2.4 其他

- QQQ 6 指标齐全：PE 28.44 / CAPE 40.24 / Fwd PE 20.57 / ERP 0.74% / EY spread −1.10% / MA200 +1.27%；战术层 VIX 18.34、F&G 37.46、系数 1.00。
- QQQ 综合 64.17（1x）、VOO 74.16（1x）、农行 49.80（1.5x 回撤触发）、招行 30.72（1.5x 评分≤40）。
- 全部 11 个标的 `data_coverage = 100`。

## 3. 架构与缓存

- 新表 `valuation_cache(key, data, updated_at)`（D1）。
- 银行 PB 历史：部署时预热灌库（3 家 × 2018-2026 共 2149×3 点），refresh 只读 D1 零子请求；scheduled 7:30/14:30 增量刷新（已有年份跳过）。
- Forward PE 历史：每次 refresh 2 个子请求（内存 6h 缓存）。
- refresh 总耗时 9.0s，仍远低于免费版 50 子请求上限。

## 4. 测试与验证记录

```bash
cd worker && npm test   # 34 tests passed
node --check src/index.js   # syntax OK
curl /api/refresh        # success, 9.0s
```

- 新增测试：valuation_cache 读写、东财 PB 解析、分位计算、缓存缺失 null、动态分位评分、序列合并去重、FRED key 路径/无 key 不请求。
- 部署中修复一个 TDZ 错误（`fwd_pe_hist` 引用先于声明），已回归验证。

## 5. 已知遗留

1. **FRED key 未配置**：Baa 仍为 JPM 锚近似（季度校准），配置 key 后自动切换每日真值。
2. 东财个股 PB 序列起点 2018-01（更早历史东财接口不提供），银行分位是"2018 以来"口径。
3. historyofmarket 为第三方聚合源（CC BY 4.0，允许数据再使用并署名），需观察其长期稳定性；失败时静态表兜底。
4. 银行 PB 分位与 `stock_pb` 绝对锚点表（权重 0.20）并存：前者是相对分位、后者是绝对水平，互补设计未变。
