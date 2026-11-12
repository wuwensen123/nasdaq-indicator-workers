/**
 * 加速规则历史回测（离线脚本，不部署）
 *
 * 三种定投策略对比（每月第一个交易日投入）：
 *   fixed — 每次 1 单位（无脑定投基线）
 *   score — 复刻生产规则②：forward PE 历史分位 ≤15%→3x / ≤25%→2x / ≤40%→1.5x
 *   combo — 规则② + 规则③：距 52 周高点回撤 ≤-15%→1.5x / ≤-25%→2x / ≤-35%→3x
 *           （估值分位 ≥85% 时回撤不加速，与生产 rich 保护一致）
 *
 * 关键约束：无未来函数——每次定投的分位只用截至当日的 forward PE 历史计算。
 * 用法：node scripts/backtest-accel-rules.mjs
 */
import { Fetcher } from '../src/fetchers.js';
import { pathToFileURL } from 'node:url';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

// 序列（date 升序）中 <= date 的最后一个值
export function asOf(series, date) {
  let lo = 0, hi = series.length - 1, ans = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date <= date) { ans = series[mid].value; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

// 只用截至 date 的历史点计算 value 的分位（0-1）
export function pctRankUpTo(series, date, value) {
  const vals = [];
  for (const p of series) {
    if (p.date <= date) vals.push(p.value);
    else break;
  }
  if (!vals.length || value == null) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  if (value <= sorted[0]) return 0;
  if (value >= sorted[sorted.length - 1]) return 1;
  let le = 0;
  for (const v of sorted) { if (v <= value) le++; else break; }
  return le / sorted.length;
}

// 生产加速规则（analyzer._strategy 的 ②PE分位 + ③回撤，取最大）
export function accelMultiple({ pePct = null, dd = null, rich = false }) {
  let m = 1;
  if (pePct != null) {
    if (pePct <= 15) m = Math.max(m, 3);
    else if (pePct <= 25) m = Math.max(m, 2);
    else if (pePct <= 40) m = Math.max(m, 1.5);
  }
  if (dd != null && dd <= -15 && !rich) {
    const dM = dd <= -35 ? 3 : dd <= -25 ? 2 : 1.5;
    m = Math.max(m, dM);
  }
  return m;
}

// XIRR：二分法求年化内部收益率；无解返回 null
export function computeXirr(flows) {
  if (!flows.length) return null;
  const t0 = new Date(flows[0].date).getTime();
  const pts = flows.map((f) => ({ t: (new Date(f.date).getTime() - t0) / 86400000, a: f.amount }));
  const npv = (r) => pts.reduce((s, p) => s + p.a / Math.pow(1 + r, p.t / 365), 0);
  let lo = -0.9999, hi = 10;
  let flo = npv(lo), fhi = npv(hi);
  if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(fm) < 1e-9) return mid;
    if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

// 每月第一个交易日（prices 升序）
function monthlyFirstTradingDays(prices, start, end) {
  const days = [];
  let lastMonth = '';
  for (const p of prices) {
    if (p.date < start || p.date > end) continue;
    const ym = p.date.slice(0, 7);
    if (ym !== lastMonth) { days.push(p); lastMonth = ym; }
  }
  return days;
}

function maxDrawdown(prices, firstBuyIdx, buyUnitsAt, end) {
  // 逐交易日账户价值 = 已买入份额 × 当日净值；返回最大峰谷回撤（%）
  let units = 0, peak = 0, mdd = 0;
  const buyMap = new Map(buyUnitsAt.map((b) => [b.date, b.units]));
  for (let i = 0; i < prices.length; i++) {
    const p = prices[i];
    if (p.date < firstBuyIdx || p.date > end) continue;
    if (buyMap.has(p.date)) units += buyMap.get(p.date);
    const v = units * p.close;
    if (v > peak) peak = v;
    if (peak > 0) mdd = Math.min(mdd, (v - peak) / peak);
  }
  return mdd * 100;
}

export function runDcaBacktest({ prices, peSeries, start, end, strategy }) {
  const buys = monthlyFirstTradingDays(prices, start, end);
  const flows = [];
  const buyUnitsAt = [];
  let units = 0, invested = 0;
  let triggerCounts = {};

  for (const buy of buys) {
    const pe = asOf(peSeries, buy.date);
    const rank = strategy === 'fixed' ? null : (pe != null ? pctRankUpTo(peSeries, buy.date, pe) : null);
    const pePct = rank == null ? null : rank * 100; // 0-1 → 百分数，与 accelMultiple 阈值同单位
    let dd = null;
    if (strategy === 'combo') {
      const idx = prices.findIndex((p) => p.date === buy.date);
      const win = prices.slice(Math.max(0, idx - 251), idx + 1).map((p) => p.close);
      const hi = Math.max(...win);
      dd = hi > 0 ? (buy.close - hi) / hi * 100 : 0;
    }
    const rich = pePct != null && pePct >= 85;
    const multiple = strategy === 'fixed' ? 1 : accelMultiple({ pePct, dd, rich });
    triggerCounts[multiple] = (triggerCounts[multiple] || 0) + 1;
    const u = multiple / buy.close;
    units += u;
    invested += multiple;
    flows.push({ date: buy.date, amount: -multiple });
    buyUnitsAt.push({ date: buy.date, units: u });
  }

  const lastPrice = prices.filter((p) => p.date >= start && p.date <= end).at(-1);
  if (!lastPrice || !buys.length) return null;
  const finalValue = units * lastPrice.close;
  flows.push({ date: lastPrice.date, amount: finalValue });
  return {
    strategy,
    months: buys.length,
    totalInvested: round2(invested),
    finalValue: round2(finalValue),
    multipleRatio: round2(finalValue / invested),
    xirr: computeXirr(flows),
    maxDrawdown: round2(maxDrawdown(prices, buys[0].date, buyUnitsAt, end)),
    avgCost: round2(invested / units),
    finalPrice: round2(lastPrice.close),
    triggerCounts,
    start: buys[0].date,
    end: lastPrice.date,
  };
}

function round2(v) { return Math.round(v * 100) / 100; }

async function fetchYahooDaily(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=max&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}: ${symbol}`);
  const j = await res.json();
  const r = j.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const closes = r?.indicators?.quote?.[0]?.close ?? [];
  return ts
    .map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i] }))
    .filter((p) => p.close != null && p.close > 0);
}

async function main() {
  const f = new Fetcher();
  console.log('抓取数据...');
  const [ndxPe, spxPe, ndxPrices, spxPrices] = await Promise.all([
    f.getForwardPEHistory('ndx'),
    f.getForwardPEHistory('spx'),
    fetchYahooDaily('^NDX'),
    fetchYahooDaily('^SP500TR'),
  ]);
  if (!ndxPe || !spxPe) throw new Error('forward PE 序列抓取失败');

  const configs = [
    { label: 'QQQ（^NDX 价格，不含分红）', prices: ndxPrices, peSeries: ndxPe.series, start: ndxPe.series[0].date },
    { label: 'VOO（^SP500TR 总回报）', prices: spxPrices, peSeries: spxPe.series, start: spxPe.series[0].date },
  ];

  for (const cfg of configs) {
    const end = cfg.prices.at(-1).date;
    console.log(`\n## ${cfg.label}  ${cfg.start} → ${end}`);
    console.log('| 策略 | 月数 | 总投入 | 期末价值 | Multiple | XIRR | 最大回撤 | 平均成本 | 期末价格 | 倍数分布 |');
    console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---|');
    for (const strategy of ['fixed', 'score', 'combo']) {
      const r = runDcaBacktest({ prices: cfg.prices, peSeries: cfg.peSeries, start: cfg.start, end, strategy });
      if (!r) { console.log(`| ${strategy} | 数据不足 |`); continue; }
      const dist = Object.entries(r.triggerCounts).sort((a, b) => a[0] - b[0]).map(([m, n]) => `${m}x×${n}`).join(' ');
      console.log(`| ${strategy} | ${r.months} | ${r.totalInvested} | ${r.finalValue} | ${r.multipleRatio} | ${(r.xirr * 100).toFixed(2)}% | ${r.maxDrawdown}% | ${r.avgCost} | ${r.finalPrice} | ${dist} |`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
