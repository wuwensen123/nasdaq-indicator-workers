/**
 * 90 天历史回填：逐日重放生产评分公式，写入 score_history（离线脚本，本地跑）
 *
 * 用法：node scripts/backfill-history.mjs <start> <end>   （YYYY-MM-DD，默认 89 天前 ~ 今天）
 * 产物：backfill_YYYYMMDD.sql（INSERT OR REPLACE INTO score_history ...），再灌入 D1：
 *   wrangler d1 execute nasdaq_cache --remote --file backfill_YYYYMMDD.sql
 *
 * 原则：
 *  - 有真实历史序列的指标逐日真值（FRED / historyofmarket / 东财估值 / 日K重算）
 *  - 无历史源（韭圈儿/蛋卷/中证官方当日快照；腾讯实时股息率）→ 该指标当天缺省，不造假
 *  - QQQ/VOO trailing PE 用「最新 TTM EPS 恒定 + 当日价格」回推，source 标注"回填估计"
 *  - 每个自然日一条（与生产 cron 一致；周末 as-of 前值）
 */
import { writeFileSync } from 'node:fs';
import { Analyzer } from '../src/analyzer.js';

const FRED_KEY = '859dd280f996d8b814f0c4fe9df8e739';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const DAY = 86400000;

function dstr(d) { return d.toISOString().slice(0, 10); }
function addDays(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return dstr(d); }
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

// ---------- 抓取 ----------
async function fetchJson(url, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.json();
}
async function fetchText(url, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.text();
}

async function fredSeries(seriesId) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&file_type=json&sort_order=asc&observation_start=2023-01-01&api_key=${FRED_KEY}`;
  const j = await fetchJson(url);
  const map = {};
  for (const o of j.observations ?? []) {
    const v = parseFloat(o.value);
    if (!isNaN(v)) map[o.date.slice(0, 10)] = v;
  }
  return map;
}

async function yahooDaily(symbol, range = '2y') {
  const j = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`);
  const r = j.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const close = r?.indicators?.quote?.[0]?.close ?? [];
  return ts.map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: close[i] }))
    .filter(p => p.close != null && p.close > 0);
}

async function yahooMonthly(symbol) {
  const j = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=max&interval=1mo`);
  const r = j.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const close = r?.indicators?.quote?.[0]?.close ?? [];
  return ts.map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: close[i] }))
    .filter(p => p.close != null && p.close > 0);
}

// CNN Fear&Greed graphdata：F&G 与 Put/Call 各约 252 天日度历史（时间戳 ms）
async function cnnSentimentHistory() {
  const j = await fetchJson('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
    'Referer': 'https://edition.cnn.com/', 'Origin': 'https://edition.cnn.com',
  });
  const toSeries = (arr) => (arr || [])
    .map(p => ({ date: new Date(p.x).toISOString().slice(0, 10), value: p.y }))
    .filter(p => p.value != null)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return { fg: toSeries(j.fear_and_greed_historical?.data), pc: toSeries(j.put_call_options?.data) };
}

async function forwardPeSeries(series) {
  const url = `https://historyofmarket.com/api/${series === 'ndx' ? 'ndx' : 'sp500'}/forward-pe.json`;
  const j = await fetchJson(url);
  const fwd = Array.isArray(j.forward) ? [...j.forward] : [];
  const own = Array.isArray(j.forwardOwn) ? [...j.forwardOwn] : [];
  const lastBase = fwd.length ? fwd[fwd.length - 1].date : null;
  const tail = own.filter(p => lastBase == null || p.date >= lastBase);
  const merged = [...fwd.filter(p => lastBase == null || p.date < lastBase), ...tail];
  merged.sort((a, b) => (a.date < b.date ? -1 : 1));
  const seen = new Set();
  return merged.filter(p => { if (seen.has(p.date)) return false; seen.add(p.date); return true; })
    .map(p => ({ date: p.date, value: p.value }));
}

async function cpiMap() {
  const html = await fetchText('https://www.multpl.com/cpi/table/by-month');
  const M = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  const map = {};
  for (const m of html.matchAll(/<td>([A-Z][a-z]{2})\s+\d{1,2},\s*(\d{4})<\/td>\s*<td>[^0-9]*([0-9.]+)/g)) {
    map[`${m[2]}-${M[m[1]]}`] = parseFloat(m[3]);
  }
  return map;
}

// multpl CAPE 月度表：{date(月首): cape}（FRED 无 SHILLER PE 系列）
async function capeMonthly() {
  const html = await fetchText('https://www.multpl.com/shiller-pe/table/by-month');
  const M = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  const map = {};
  const re = /<td>([A-Z][a-z]{2}) 1, (\d{4})<\/td>\s*<td>\s*&#x2002;\s*([0-9.]+)\s*<\/td>/g;
  let m;
  while ((m = re.exec(html))) {
    map[`${m[2]}-${M[m[1]]}-01`] = parseFloat(m[3]);
  }
  if (Object.keys(map).length < 100) throw new Error('capeMonthly 解析失败: ' + html.slice(0, 200));
  return map;
}

async function eastmoneyVal(secCode, startY) {
  const all = [];
  for (let y = parseInt(startY, 10); y <= 2026; y++) {
    const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_VALUEANALYSIS_DET&columns=TRADE_DATE,PE_TTM,PB_MRQ,CLOSE_PRICE&filter=(SECURITY_CODE%3D%22${secCode}%22)(TRADE_DATE%3E%3D%27${y}-01-01%27)(TRADE_DATE%3C%3D%27${y}-12-31%27)&pageSize=500&sortColumns=TRADE_DATE&sortTypes=1`;
    const j = await fetchJson(url);
    for (const r of j.result?.data ?? []) {
      const v = (x) => (x == null || isNaN(parseFloat(x)) ? null : parseFloat(x));
      all.push({ date: String(r.TRADE_DATE).slice(0, 10), pe: v(r.PE_TTM), pb: v(r.PB_MRQ), close: v(r.CLOSE_PRICE) });
    }
  }
  all.sort((a, b) => (a.date < b.date ? -1 : 1));
  return all;
}

async function tencentKline(symbol) {
  const code = symbol.replace('.SS', '').replace('.SZ', '');
  const mk = symbol.endsWith('.SS') ? 'sh' : 'sz';
  const d = await fetchJson(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${mk}${code},day,,,420,`);
  const item = d?.data?.[`${mk}${code}`];
  const rows = item?.qfqday || item?.day || [];
  return rows.map(r => ({ date: r[0], close: parseFloat(r[2]), high: parseFloat(r[3]) }))
    .filter(p => !isNaN(p.close) && p.close > 0);
}

// ---------- 技术指标（与 fetchers 同口径） ----------
function calcMA(arr, n) { if (arr.length < n) return null; return arr.slice(-n).reduce((a, b) => a + b, 0) / n; }
function calcRSI(arr, n = 14) {
  if (arr.length < n + 1) return null;
  let gain = 0, loss = 0;
  for (let i = arr.length - n; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  const rs = gain / n / (loss / n || 1e-9);
  return 100 - 100 / (1 + rs);
}
function dailyTech(closes) {
  const out = [];
  for (let i = 0; i < closes.length; i++) {
    const hist = closes.slice(0, i + 1);
    const ma200 = calcMA(hist, 200);
    const ma50 = calcMA(hist, 50);
    const hi52 = Math.max(...hist.slice(-252));
    out.push({
      rsi: calcRSI(hist) == null ? null : Math.round(calcRSI(hist)),
      ma200: ma200 == null ? null : Math.round(ma200 * 100) / 100,
      ma200_pct: ma200 == null ? null : Math.round((closes[i] / ma200 - 1) * 10000) / 100,
      ma50: ma50 == null ? null : Math.round(ma50 * 100) / 100,
      high_52w: Math.round(hi52 * 100) / 100,
      pct_from_52w_high: Math.round((closes[i] / hi52 - 1) * 10000) / 100,
      close: closes[i],
    });
  }
  return out;
}

// as-of：list of {date, value} 取 <= date 最近值
function asOf(list, date) {
  let lo = 0, hi = list.length - 1, ans = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].date <= date) { ans = list[mid].value; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}
// map {date: value} as-of（键按字典序取 <= date 最大；源表可能倒序/乱序）
function asOfMap(map, date) {
  let best = null;
  for (const k of Object.keys(map)) {
    if (k <= date && (best === null || k > best)) best = k;
  }
  return best === null ? null : map[best];
}
// 分位（只用 <= date 的点），0-1
function pctRankUpTo(points, date, value) {
  const vals = [];
  for (const p of points) { if (p.date <= date) vals.push(p.value); else break; }
  if (!vals.length || value == null) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  if (value <= sorted[0]) return 0;
  if (value >= sorted[sorted.length - 1]) return 1;
  let le = 0;
  for (const v of sorted) { if (v <= value) le++; else break; }
  return le / sorted.length;
}

// ---------- main ----------
const TODAY = new Date().toISOString().slice(0, 10);
const START = process.argv[2] || addDays(TODAY, -89);
const END = process.argv[3] || TODAY;

console.log(`回填窗口: ${START} ~ ${END}`);
console.log('抓取序列...');

const manual = {};
const [baa, dgs10, tips, shiller, fwdNdx, fwdSpx, cpi, qqqK, vooK, gldK, hsiK, dxK, gcM, hgW, vixK, vix3mK, cnnS] = await Promise.all([
  fredSeries('DBAA'), fredSeries('DGS10'), fredSeries('DFII10'), capeMonthly(),
  forwardPeSeries('ndx'), forwardPeSeries('spx'), cpiMap(),
  yahooDaily('QQQ'), yahooDaily('VOO'), yahooDaily('GLD'), yahooDaily('^HSI'),
  yahooDaily('DX-Y.NYB', '5y'),
  yahooMonthly('GC=F'),
  fetchJson('https://query1.finance.yahoo.com/v8/finance/chart/HG=F?range=10y&interval=1wk').then(j => {
    const r = j.chart?.result?.[0];
    const ts = r?.timestamp ?? [];
    const close = r?.indicators?.quote?.[0]?.close ?? [];
    return ts.map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), value: close[i] }))
      .filter(p => p.value != null && p.value > 0);
  }),
  yahooDaily('^VIX').then(a => a.map(p => ({ date: p.date, value: p.close }))),
  yahooDaily('^VIX3M').then(a => a.map(p => ({ date: p.date, value: p.close }))),
  cnnSentimentHistory(),
]);
console.log('全局序列 OK: baa', Object.keys(baa).length, 'tips', Object.keys(tips).length, 'shiller', Object.keys(shiller).length);
console.log('情绪序列 OK: VIX', vixK.length, 'VIX3M', vix3mK.length, 'F&G', cnnS.fg.length, 'P/C', cnnS.pc.length);

const EM_CODES = { abc_bank: '601288', ccb_bank: '601939', cmb_bank: '600036', yangtze_power: '600900', zijin_mining: '601899' };
const emSeries = {};
for (const [id, code] of Object.entries(EM_CODES)) { emSeries[id] = await eastmoneyVal(code, '2019'); console.log('东财', id, emSeries[id].length, '天'); }

const CN_K = ['601288.SS', '601939.SS', '600036.SS', '600900.SS', '601899.SS', '512890.SS', '563020.SS'];
const cnK = {};
for (const s of CN_K) { cnK[s] = await tencentKline(s); console.log('腾讯K', s, cnK[s].length, '天'); }
const cnTech = {};
for (const [s, rows] of Object.entries(cnK)) {
  cnTech[s] = dailyTech(rows.map(r => r.close)).map((t, i) => ({ date: rows[i].date, ...t }));
}

// 技术指标序列：QQQ/VOO/GLD/HSI（Yahoo 日线）
const usTech = {
  qqq: dailyTech(qqqK.map(p => p.close)).map((t, i) => ({ date: qqqK[i].date, ...t })),
  voo: dailyTech(vooK.map(p => p.close)).map((t, i) => ({ date: vooK[i].date, ...t })),
  gld: dailyTech(gldK.map(p => p.close)).map((t, i) => ({ date: gldK[i].date, ...t })),
  hsi: dailyTech(hsiK.map(p => p.close)).map((t, i) => ({ date: hsiK[i].date, ...t })),
};

// trailing PE 锚（最新 TTM EPS 恒定）：从生产 API 取当日 Yahoo 口径 trailing PE ÷ 生产当日价
// （与 /api/refresh 同源，保证回填分数与生产口径一致）
async function currentPeAnchor(symbol) {
  const d = await fetchJson('https://api.motris.dpdns.org/api/data');
  const res = (d.analysis?.results ?? []).find(x => x.symbol === symbol);
  const price = res?.current_price;
  const peData = (res?.indicators ?? []).find(i => i.name === 'PE综合估值');
  if (!price || !peData?.value) throw new Error(`生产API无 ${symbol} trailing PE`);
  return peData.value / price;
}
console.log('抓当前 trailing PE 锚（生产口径）...');
const [peQqqEps, peVooEps] = await Promise.all([currentPeAnchor('QQQ'), currentPeAnchor('VOO')]);
console.log('EPS锚 QQQ', peQqqEps?.toFixed(4), 'VOO', peVooEps?.toFixed(4));
if (!peQqqEps || !peVooEps) throw new Error('无法获取 trailing PE 锚');

// ---------- 逐日重放 ----------
const analyzer = new Analyzer();
const targets = analyzer.getTargets().filter(t => t.strategic);
const rows = []; // {target_id, date, composite_score, multiple, indicators}

let date = START;
while (date <= END) {
  const globalData = {
    vix: { value: asOf(vixK, date) }, vix3m: { value: asOf(vix3mK, date) },
    fear_greed: { value: asOf(cnnS.fg, date) }, put_call_ratio: { value: asOf(cnnS.pc, date) },
    treasury_10y: { value: asOfMap(dgs10, date), source: 'FRED (DGS10)' },
    dxy: { value: null },
    shiller_pe: { value: asOfMap(shiller, date), source: 'FRED (SHILLER_PE)' },
    baa_yield: { value: asOfMap(baa, date), source: 'FRED (DBAA)' },
    real_yield_10y: { value: asOfMap(tips, date), source: 'FRED (DFII10)' },
    cn_market: { shanghai_pe: null, csi300_pe: null, source: null },
    gold_real_pct: { value: null },
    dxy_pct: { value: (() => {
      const vals = dxK.filter(p => p.date <= date).map(p => p.close);
      if (vals.length < 100) return null;
      const cur = vals[vals.length - 1];
      return Math.round(vals.filter(x => x <= cur).length / vals.length * 1000) / 10;
    })() },
    copper_pct: { value: (() => {
      const vals = hgW.filter(p => p.date <= date).map(p => p.value);
      if (vals.length < 150) return null;
      const cur = vals[vals.length - 1];
      return Math.round(vals.filter(x => x <= cur).length / vals.length * 1000) / 10;
    })() },
    gold_pct_hist: null,
    danjuan: { map: {}, source: null }, jiuquan: { map: {}, source: null },
    csi: { H30269: null, '930955': null },
    // forward PE 历史分位：用截至当日的子序列（无未来函数）
    fwd_pe_hist: {
      ndx: { series: fwdNdx.filter(p => p.date <= date), source: 'historyofmarket.com', updated_at: date },
      spx: { series: fwdSpx.filter(p => p.date <= date), source: 'historyofmarket.com', updated_at: date },
    },
    updated_at: date,
  };

  // 黄金实际价格分位：GC 月线 × CPI（与生产同口径：real = close × cpiLatest/cpiMonth）
  {
    const gc = gcM.filter(p => p.date <= date);
    if (gc.length >= 120) {
      const cpiList = Object.entries(cpi).sort((a, b) => (a[0] < b[0] ? -1 : 1));
      const cpiLatest = cpiList.length ? cpiList[cpiList.length - 1][1] : null;
      const real = [];
      for (const p of gc) {
        const c = cpi[p.date.slice(0, 7)];
        if (c) real.push(p.close * (cpiLatest / c));
      }
      if (real.length >= 120) {
        const cur = real[real.length - 1];
        globalData.gold_real_pct = { value: Math.round(real.filter(x => x <= cur).length / real.length * 1000) / 10 };
      }
    }
  }

  const targetsData = {};
  const techOf = (id) => {
    const arr = id === 'qqq' ? usTech.qqq : id === 'voo' ? usTech.voo : id === 'gld' ? usTech.gld : usTech.hsi;
    let lo = 0, hi = arr.length - 1, ans = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].date <= date) { ans = arr[mid]; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  };
  const cnTechOf = (sym) => {
    const arr = cnTech[sym];
    let lo = 0, hi = arr.length - 1, ans = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].date <= date) { ans = arr[mid]; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  };
  const dailyPriceOf = (arr) => { let lo = 0, hi = arr.length - 1, ans = null; while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].date <= date) { ans = arr[mid].close; lo = mid + 1; } else hi = mid - 1; } return ans; };

  for (const t of targets) {
    const td = targetsData[t.id] = { dividend_data: null, dividend_yield: null, pb: null, pb_source: null, stock_pe: null, pe_data: null, forward_pe_data: null };
    if (t.id === 'qqq' || t.id === 'voo') {
      const k = t.id === 'qqq' ? qqqK : vooK;
      const price = dailyPriceOf(k);
      const eps = t.id === 'qqq' ? peQqqEps : peVooEps; // PE/price
      const pe = price != null && eps ? round2(price * eps) : null;
      const fwd = asOf(t.id === 'qqq' ? fwdNdx : fwdSpx, date);
      td.price = price; td.technical = techOf(t.id);
      td.pe_ratio = pe; td.pe_data = { value: pe, source: 'Yahoo Finance · 回填估计(最新TTM EPS恒定)', updated_at: date };
      td.forward_pe = fwd; td.forward_pe_data = { value: fwd, source: 'historyofmarket.com', updated_at: date };
    } else if (t.id === 'gld' || t.id === 'hsi') {
      const k = t.id === 'gld' ? gldK : hsiK;
      const price = dailyPriceOf(k);
      td.price = price; td.technical = techOf(t.id);
      // HSI: 恒指 PE 历史（腾讯当日快照反推 EPS 恒定）→ 无历史源，不填 pe（蛋卷/韭圈儿无历史）
      if (t.id === 'hsi') {
        td.pe_ratio = null; td.pe_data = null;
      }
    } else if (t.id.startsWith('dividend_low_vol')) {
      // 估值源（韭圈儿/蛋卷/中证）无历史 → 只有技术指标
      const sym = t.id === 'dividend_low_vol_etf' ? '512890.SS' : '563020.SS';
      td.price = cnTechOf(sym)?.close ?? null;
      td.technical = cnTechOf(sym);
    } else {
      // A 股个股：东财每日 PE_TTM/PB_MRQ/ROE=PB/PE
      const em = emSeries[t.id];
      let lo = 0, hi = em.length - 1, row = null;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (em[mid].date <= date) { row = em[mid]; lo = mid + 1; } else hi = mid - 1; }
      const sym = t.symbol;
      const tech = cnTechOf(sym);
      td.price = row?.close ?? tech?.close ?? null;
      td.pe_ratio = row?.pe ?? null;
      td.stock_pe = row?.pe ?? null;
      td.pb = row?.pb ?? null;
      td.pb_source = '东方财富估值分析·回填';
      td.pe_data = row?.pe != null ? { value: row.pe, source: '东方财富估值分析·回填 (PE_TTM)', updated_at: date } : null;
      td.technical = tech;
      // 银行 PB 历史分位（2019 至今逐日）
      if (EM_CODES[t.id]) {
        const pbHist = em.filter(r => r.pb != null).map(r => ({ date: r.date, value: r.pb }));
        if (row?.pb != null && pbHist.length >= 100) {
          const pct = pctRankUpTo(pbHist, date, row.pb);
          td.pb_pct_hist = { current_pb: round2(row.pb), pct, count: pbHist.filter(p => p.date <= date).length, source: '东方财富估值分析', updated_at: date };
          // 生产 analyzer 要求 pct != null && count >= 100 才使用
        } else td.pb_pct_hist = null;
      }
    }
  }

  // 重放评分（与 /api/refresh 同入口）
  const results = [];
  for (const t of targets) {
    const r = analyzer.analyzeTarget(t.id, targetsData, globalData);
    if (r) results.push(r);
  }
  for (const r of results) {
    const ind = {};
    for (const i of r.indicators) ind[i.name] = { v: i.value, s: i.score };
    // 全局战术情绪指标（与生产 saveScoreHistory 同逻辑）
    const st = r.sentiment;
    if (st) {
      if (st.vix != null) ind['VIX波动率'] = { v: st.vix, s: null };
      if (st.vix_ratio != null) ind['VIX/VIX3M'] = { v: st.vix_ratio, s: null };
      if (st.fear_greed != null) ind['恐惧与贪婪指数'] = { v: st.fear_greed, s: null };
      if (st.put_call != null) ind['看跌/看涨期权比率'] = { v: st.put_call, s: null };
    }
    rows.push({
      target_id: r.target_id, date,
      composite_score: r.composite_score, multiple: r.strategy?.multiple ?? null,
      indicators: ind,
    });
  }
  if (date === START || date === END || date.endsWith('-01')) console.log(date, 'OK', results.map(r => `${r.target_id}:${r.composite_score ?? '--'}`).join(' '));
  date = addDays(date, 1);
}

// ---------- 输出 SQL ----------
// 拆成每 100 行一条 INSERT（D1 单语句限长 SQLITE_LIMIT_SQL_LENGTH，990 行一条会 SQLITE_TOOBIG）
const valStrs = [];
for (const r of rows) {
  const t = r.target_id, d = r.date;
  const indJson = JSON.stringify(r.indicators).replace(/'/g, "''");
  valStrs.push(`('${t}', '${d}', ${r.composite_score ?? 'NULL'}, ${r.multiple ?? 'NULL'}, '${indJson}')`);
}
const CHUNK = 100;
const chunks = [];
for (let i = 0; i < valStrs.length; i += CHUNK) {
  chunks.push(`INSERT OR REPLACE INTO score_history (target_id, date, composite_score, multiple, indicators) VALUES\n${valStrs.slice(i, i + CHUNK).join(',\n')};`);
}
const outFile = `backfill_${START.replace(/-/g, '')}_${END.replace(/-/g, '')}.sql`;
writeFileSync(outFile, ['-- backfill ' + START + ' ~ ' + END, `-- ${rows.length} 行`, chunks.join('\n\n'), `-- ${rows.length} 行, ${START}~${END}`].join('\n'), 'utf8');
console.log(`\n写入 ${outFile}: ${rows.length} 行（${chunks.length} 条 INSERT，防 SQLITE_TOOBIG）`);
console.log('灌库: wrangler d1 execute nasdaq_cache --remote --file ' + outFile);