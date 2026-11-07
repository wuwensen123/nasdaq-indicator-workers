/**
 * 数据获取 — 对接 Yahoo Finance / CNN / CBOE 等公开数据源
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// FRED 对完整浏览器 UA + 非浏览器 TLS 指纹会 tarpit（实测 Chrome/120 UA 12s+ 无响应，短 UA 正常），FRED 请求专用
const UA_PLAIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function fetchJSONWithHeaders(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...extraHeaders } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

// ========== Yahoo cookie+crumb 认证 ==========
// quoteSummary 接口现已强制 crumb 校验（无 crumb 返回 Invalid Crumb），
// 需先拿 cookie 再换 crumb，凭证在 isolate 内存中缓存 6 小时
let yahooAuth = null; // { cookie, crumb, ts }

async function getYahooAuth() {
  if (yahooAuth && Date.now() - yahooAuth.ts < 6 * 3600 * 1000) return yahooAuth;
  // 1. 获取 cookie
  let cookie = '';
  try {
    const res1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'follow' });
    const sc = res1.headers.getSetCookie ? res1.headers.getSetCookie() : [];
    cookie = sc.map(c => c.split(';')[0]).join('; ');
  } catch {}
  if (!cookie) {
    try {
      const res1b = await fetch('https://finance.yahoo.com', { headers: { 'User-Agent': UA } });
      const sc = res1b.headers.getSetCookie ? res1b.headers.getSetCookie() : [];
      cookie = sc.map(c => c.split(';')[0]).join('; ');
    } catch {}
  }
  if (!cookie) throw new Error('Yahoo cookie 获取失败');
  // 2. 用 cookie 换 crumb
  const res2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, 'Cookie': cookie, 'Referer': 'https://finance.yahoo.com/' },
  });
  if (!res2.ok) throw new Error(`HTTP ${res2.status}: getcrumb`);
  const crumb = (await res2.text()).trim();
  if (!crumb || crumb.length > 24 || crumb.includes('<')) throw new Error('Yahoo crumb 获取失败');
  yahooAuth = { cookie, crumb, ts: Date.now() };
  return yahooAuth;
}

async function fetchYahooTrailingPE(symbol) {
  // crumb 失效（401/403）时清缓存重取一次
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { cookie, crumb } = await getYahooAuth();
      const url = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' + encodeURIComponent(symbol) + '?modules=summaryDetail&crumb=' + encodeURIComponent(crumb);
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Cookie': cookie, 'Referer': 'https://finance.yahoo.com/' } });
      if ((res.status === 401 || res.status === 403) && attempt === 0) { yahooAuth = null; continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      const pe = d?.quoteSummary?.result?.[0]?.summaryDetail?.trailingPE?.raw;
      return pe != null ? pe : null;
    } catch { yahooAuth = null; }
  }
  return null;
}

export class Fetcher {
  // ========== VIX ==========
  async getVIX() {
    try {
      const d = await fetchJSON('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?range=5d&interval=1d');
      const meta = d.chart?.result?.[0]?.meta;
      const quotes = d.chart?.result?.[0]?.indicators?.quote?.[0];
      if (!meta || !quotes) return { value: null, change: 0, source: 'Yahoo Finance' };
      const close = quotes.close?.filter(c => c != null);
      const value = meta.regularMarketPrice ?? close?.[close.length - 1];
      const change = close?.length >= 2 ? ((close[close.length - 1] - close[close.length - 2]) / close[close.length - 2]) * 100 : 0;
      return { value: round(value), change: round(change), source: 'Yahoo Finance (^VIX)', updated_at: now() };
    } catch { return { value: null, change: 0, source: 'Yahoo Finance', updated_at: now() }; }
  }

  // ========== Fear & Greed ==========
  async getFearGreed() {
    // 方案1: CNN 官方 API（美股市场 Fear & Greed）
    try {
      const d = await fetchJSONWithHeaders('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
        'Referer': 'https://edition.cnn.com/', 'Origin': 'https://edition.cnn.com'
      });
      const score = d?.fear_and_greed?.score;
      if (score != null) return { value: round(score), label: this._fgLabel(score), source: 'CNN', updated_at: now() };
    } catch {}
    // 方案2: alternative.me（加密货币 FG，备选）
    try {
      const d = await fetchJSON('https://api.alternative.me/fng/?limit=1');
      const score = d?.data?.[0]?.value;
      if (score != null) return { value: round(parseFloat(score)), label: this._fgLabel(parseFloat(score)), source: 'alternative.me', updated_at: now() };
    } catch {}
    // 方案3: 从 VIX 估算
    try {
      const v = await this.getVIX();
      if (v?.value) {
        const estimated = Math.max(0, Math.min(100, 100 - (v.value - 10) * 3.33));
        return { value: round(estimated), label: this._fgLabel(estimated), source: '根据VIX估算', updated_at: now() };
      }
    } catch {}
    return { value: null, label: '未知', source: 'CNN', updated_at: now() };
  }
  _fgLabel(v) {
    if (v <= 25) return '极度恐惧'; if (v <= 40) return '恐惧'; if (v <= 60) return '中性'; if (v <= 75) return '贪婪';
    return '极度贪婪';
  }

  // ========== 10Y Treasury ==========
  async getTreasuryYield() {
    try {
      const d = await fetchJSON('https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX?range=5d&interval=1d');
      const quotes = d.chart?.result?.[0]?.indicators?.quote?.[0];
      const close = quotes?.close?.filter(c => c != null);
      if (!close?.length) return { value: null, change: 0, source: 'Yahoo Finance', updated_at: now() };
      const value = close[close.length - 1];
      const change = close.length >= 2 ? ((close[close.length - 1] - close[close.length - 2]) / close[close.length - 2]) * 100 : 0;
      return { value: round(value), change: round(change), source: 'Yahoo Finance (^TNX)', updated_at: now() };
    } catch { return { value: null, change: 0, source: 'Yahoo Finance', updated_at: now() }; }
  }

  // ========== Put/Call Ratio ==========
  async getPutCallRatio() {
    // 尝试从 CBOE 获取实时数据
    try {
      const d = await fetchJSON('https://cdn.cboe.com/api/global/us_statistics/trading_summary_current.json');
      const pc = d?.data?.put_call_ratio;
      if (pc != null && pc > 0.1 && pc < 5) return { value: round(pc), label: this._pcLabel(pc), source: 'CBOE', updated_at: now() };
    } catch {}
    // 从 Nasdaq 获取 SPY 期权成交量比率（最近到期日，真实数据）
    try {
      const NH = { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9', 'Origin': 'https://www.nasdaq.com', 'Referer': 'https://www.nasdaq.com/' };
      const listRes = await fetch('https://api.nasdaq.com/api/quote/SPY/option-chain?assetclass=etf&limit=3', { headers: NH });
      if (listRes.ok) {
        const list = await listRes.json();
        const eg = list?.data?.table?.rows?.[0]?.expirygroup; // 如 "November 9, 2026"
        const ed = eg ? new Date(eg).toISOString().slice(0, 10) : null;
        if (ed) {
          const chainRes = await fetch('https://api.nasdaq.com/api/quote/SPY/option-chain?assetclass=etf&date=' + ed + '&limit=250', { headers: NH });
          if (chainRes.ok) {
            const chain = await chainRes.json();
            const rows = chain?.data?.table?.rows || [];
            const vol = x => { if (x == null) return 0; if (typeof x === 'object') x = x.value; const n = parseInt(String(x).replace(/,/g, '')); return isNaN(n) ? 0 : n; };
            const calls = rows.reduce((s, r) => s + vol(r.c_Volume), 0);
            const puts = rows.reduce((s, r) => s + vol(r.p_Volume), 0);
            if (calls > 100 && puts > 100) {
              const ratio = puts / calls;
              if (ratio > 0.1 && ratio < 5) return { value: round(ratio), label: this._pcLabel(ratio), source: 'SPY期权(Nasdaq)', updated_at: now() };
            }
          }
        }
      }
    } catch {}
    // 从 VIX 估算
    try {
      const v = await this.getVIX();
      if (v?.value) {
        const estimated = 0.4 + (v.value - 10) * 0.03;
        return { value: round(estimated), label: this._pcLabel(estimated), source: '根据VIX估算', updated_at: now() };
      }
    } catch {}
    return { value: null, label: '未知', source: 'CBOE', updated_at: now() };
  }
  _pcLabel(v) {
    if (v < 0.7) return '极度看涨'; if (v < 0.85) return '看涨'; if (v < 1.0) return '中性'; if (v < 1.2) return '看跌';
    return '极度看跌';
  }

  // ========== DXY ==========
  async getDXY() {
    try {
      const d = await fetchJSON('https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?range=5d&interval=1d');
      const meta = d.chart?.result?.[0]?.meta;
      const quotes = d.chart?.result?.[0]?.indicators?.quote?.[0];
      const close = quotes?.close?.filter(c => c != null);
      const value = meta?.regularMarketPrice ?? close?.[close.length - 1];
      const change = close?.length >= 2 ? ((close[close.length - 1] - close[close.length - 2]) / close[close.length - 2]) * 100 : 0;
      return { value: round(value), change: round(change), source: 'Yahoo Finance (DX-Y.NYB)', updated_at: now() };
    } catch { return { value: null, change: 0, source: 'Yahoo Finance', updated_at: now() }; }
  }

  // ========== Shiller PE ==========
  async getShillerPE() {
    try {
      const html = await fetchText('https://www.multpl.com/shiller-pe');
      // meta description: "Current Shiller PE Ratio is 42.19"
      let m = html.match(/Shiller\s*PE\s*Ratio\s*is\s*(\d+\.?\d*)/i);
      if (!m) {
        // 备用: <div id="current"> 附近找数字
        const idx = html.indexOf('id="current"');
        if (idx >= 0) {
          const near = html.substring(idx, idx + 500);
          m = near.match(/(\d+\.\d+)/);
        }
      }
      if (m) {
        const v = parseFloat(m[1]);
        if (v > 5 && v < 100) return { value: round(v), source: 'multpl.com', updated_at: now() };
      }
    } catch {}
    return { value: null, source: 'multpl.com', updated_at: now() };
  }

  // ========== 10年期TIPS实际收益率（黄金的机会成本锚） ==========
  // 主源 FRED DFII10；Workers 出口对 FRED 会收到 HTTP 520，兜底用美国财政部官方 XML
  async getRealYield10Y() {
    try {
      const csv = await fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFII10', { headers: { 'User-Agent': UA_PLAIN } }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); });
      const lines = csv.trim().split('\n');
      for (let i = lines.length - 1; i >= 1; i--) {
        const v = parseFloat(lines[i].split(',')[1]);
        if (!isNaN(v)) return { value: round(v), source: 'FRED (DFII10)', updated_at: now() };
      }
    } catch {}
    try {
      const xml = await fetch('https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_real_yield_curve&field_tdr_date_value=' + new Date().getUTCFullYear(), { headers: { 'User-Agent': UA_PLAIN } }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); });
      const vals = [...xml.matchAll(/<d:TC_10YEAR[^>]*>([0-9.\-]+)</g)].map(m => parseFloat(m[1])).filter(v => !isNaN(v));
      if (vals.length) return { value: round(vals[vals.length - 1]), source: 'Treasury.gov', updated_at: now() };
    } catch {}
    return { value: null, source: 'FRED+Treasury均失败', updated_at: now() };
  }

  // ========== 黄金实际价格历史分位（GC=F月线 ÷ CPI，黄金的"CAPE"） ==========
  // CPI 主源 FRED；Workers 出口 520 时兜底 multpl.com 月度 CPI 表
  async getCpiMap() {
    try {
      const csv = await fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCSL', { headers: { 'User-Agent': UA_PLAIN } }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); });
      const map = new Map();
      for (const line of csv.trim().split('\n').slice(1)) {
        const [d, v] = line.split(',');
        const c = parseFloat(v);
        if (!isNaN(c)) map.set(d.slice(0, 7), c);
      }
      if (map.size > 120) return map;
    } catch {}
    try {
      const html = await fetchText('https://www.multpl.com/cpi/table/by-month');
      const M = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
      const rows = [...html.matchAll(/<td>([A-Z][a-z]{2})\s+\d{1,2},\s*(\d{4})<\/td>\s*<td>[^0-9]*([0-9.]+)/g)];
      const map = new Map();
      for (const [, mon, yr, v] of rows) map.set(`${yr}-${M[mon]}`, parseFloat(v));
      if (map.size > 120) return map;
    } catch {}
    return null;
  }

  async getGoldRealPricePercentile() {
    try {
      const [chart, cpiMap] = await Promise.all([
        fetchJSON('https://query1.finance.yahoo.com/v8/finance/chart/GC=F?range=max&interval=1mo'),
        this.getCpiMap(),
      ]);
      if (!cpiMap) return { value: null, current: null, source: 'CPI两个源均失败', updated_at: now() };
      const stamps = chart.chart?.result?.[0]?.timestamp || [];
      const closes = chart.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
      const cpiLatest = [...cpiMap.values()].pop();
      const real = [];
      for (let i = 0; i < stamps.length; i++) {
        if (closes[i] == null) continue;
        const m = new Date(stamps[i] * 1000).toISOString().slice(0, 7);
        const c = cpiMap.get(m);
        if (c) real.push(closes[i] * (cpiLatest / c));
      }
      if (real.length < 120) return { value: null, current: null, source: '数据不足:' + real.length, updated_at: now() };
      const cur = real[real.length - 1];
      const pct = real.filter(x => x <= cur).length / real.length * 100;
      return { value: round(pct, 1), current: round(cur, 0), source: 'Yahoo(GC=F)+CPI', updated_at: now() };
    } catch (e) {
      return { value: null, current: null, source: '金价分位错误: ' + String(e?.message || e).slice(0, 60), updated_at: now() };
    }
  }

  // ========== DXY 五年周线分位 ==========
  async getDXYPercentile() {
    try {
      const d = await fetchJSON('https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?range=5y&interval=1wk');
      const closes = (d.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter(c => c != null);
      if (closes.length < 100) return { value: null, source: 'Yahoo Finance', updated_at: now() };
      const cur = closes[closes.length - 1];
      const pct = closes.filter(x => x <= cur).length / closes.length * 100;
      return { value: round(pct, 1), current: round(cur), source: 'Yahoo Finance (5y周线)', updated_at: now() };
    } catch {}
    return { value: null, source: 'Yahoo Finance', updated_at: now() };
  }

  // ========== 蛋卷基金指数估值（PE/PB + 近10年分位 + 股息率 + 参考债券收益率） ==========
  async getDanjuanValuations() {
    try {
      const d = await fetchJSONWithHeaders('https://danjuanfunds.com/djapi/index_eva/dj', { 'Referer': 'https://danjuanfunds.com/' });
      const items = d?.data?.items || [];
      if (!items.length) throw new Error('空数据');
      const map = {};
      for (const it of items) {
        map[it.name] = {
          pe: it.pe ?? null, pb: it.pb ?? null,
          pe_pct: it.pe_percentile != null ? round(it.pe_percentile * 100, 1) : null,
          pb_pct: it.pb_percentile != null ? round(it.pb_percentile * 100, 1) : null,
          dy: it.yeild != null ? round(it.yeild * 100, 2) : null,
          bond_yield: it.bond_yeild != null ? round(it.bond_yeild * 100, 2) : null,
          date: it.date || null,
        };
      }
      return { map, source: '蛋卷基金', updated_at: now() };
    } catch (e) {
      return { map: {}, source: '蛋卷错误: ' + String(e?.message || e).slice(0, 40), updated_at: now() };
    }
  }

  // ========== 个股PB（东方财富，银行股估值主锚） ==========
  // 注: f167带×100缩放且字段口径不稳，用 价格(f43/100)÷每股净资产(f92) 自算，f167 兜底
  async getStockPB(symbol) {
    try {
      const code = symbol.replace('.SS', '').replace('.SZ', '');
      const market = symbol.endsWith('.SS') ? '1' : '0';
      const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${market}.${code}&fields=f43,f92,f167`;
      const d = await fetchJSON(url);
      const data = d?.data || {};
      let pb = null;
      if (data.f92 > 0 && data.f43 > 0) pb = (data.f43 / 100) / data.f92;
      if (pb == null && data.f167 != null) pb = data.f167 > 15 ? data.f167 / 100 : data.f167;
      if (pb != null && pb > 0.1 && pb < 30) return { value: round(pb, 2), source: '东方财富', updated_at: now() };
    } catch {}
    return { value: null, source: '东方财富', updated_at: now() };
  }

    // ========== PE Ratio ==========
  async getPERatio(symbol, name = '') {
    // 中国A股: 先用腾讯财经
    if (symbol.endsWith('.SS') || symbol.endsWith('.SZ')) {
      try {
        const code = symbol.replace('.SS', '').replace('.SZ', '');
        const market = symbol.endsWith('.SS') ? 'sh' : 'sz';
        const text = await fetchText('https://qt.gtimg.cn/q=' + market + code);
        const parts = text.split('~');
        if (parts.length >= 41) {
          const pe = parseFloat(parts[39]);
          if (!isNaN(pe) && pe > 0 && pe < 200) {
            return { value: round(pe), source: '腾讯财经', updated_at: now(), name };
          }
        }
      } catch {}
    }
    // Yahoo Finance v10（cookie+crumb 认证，与官网网页口径一致）
    try {
      const pe = await fetchYahooTrailingPE(symbol);
      if (pe != null && pe > 0 && pe < 200) return { value: round(pe), source: 'Yahoo Finance', updated_at: now(), name };
    } catch {}
    // worldperatio.com (QQQ/VOO)
    try {
      let url = '';
      if (symbol === 'QQQ') url = 'https://worldperatio.com/index/nasdaq-100/';
      else if (symbol === 'VOO') url = 'https://worldperatio.com/index/sp-500/';
      if (url) {
        const html = await fetchText(url);
        const m = html.match(/P\/E\s*Ratio:\s*<[^>]*>([0-9.]+)<\/b>/i);
        if (m) {
          const pe = parseFloat(m[1]);
          if (pe > 5 && pe < 100) return { value: round(pe), source: 'worldperatio.com', updated_at: now(), name };
        }
      }
    } catch {}
    return { value: null, source: 'Yahoo Finance', updated_at: now(), name };
  }
// ========== 技术指标（RSI, MA, MACD） ==========
  async getTechnicalIndicators(symbol, period = '1y') {
    const result = { current_price: null, rsi: null, ma200: null, ma200_pct: null, ma50: null, ma50_pct: null, macd: null, macd_signal: null, high_52w: null, low_52w: null, pct_from_52w_high: null, source: 'Yahoo Finance + 计算', updated_at: now() };
    try {
      const d = await fetchJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${period}&interval=1d`);
      const quotes = d.chart?.result?.[0];
      if (!quotes) return result;
      const close = quotes.indicators?.quote?.[0]?.close?.filter(c => c != null) || [];
      if (close.length < 50) return result;
      result.current_price = round(close[close.length - 1]);

      // RSI(14)
      result.rsi = round(calcRSI(close, 14));

      // MA
      result.ma50 = round(calcMA(close, 50));
      result.ma50_pct = round((close[close.length - 1] / result.ma50 - 1) * 100);
      if (close.length >= 200) {
        result.ma200 = round(calcMA(close, 200));
        result.ma200_pct = round((close[close.length - 1] / result.ma200 - 1) * 100);
      }

      // MACD
      const ema12 = calcEMA(close, 12);
      const ema26 = calcEMA(close, 26);
      const macdLine = ema12 - ema26;
      result.macd = round(macdLine);
      // 计算实际 MACD 历史值，再取 EMA(9) 作信号线
      const macdValues = [];
      for (let i = 26; i < close.length; i++) {
        const e12 = calcEMA(close.slice(0, i + 1), 12);
        const e26 = calcEMA(close.slice(0, i + 1), 26);
        macdValues.push(e12 - e26);
      }
      result.macd_signal = macdValues.length >= 9 ? round(calcEMA(macdValues, 9)) : round(macdLine);

      // 52周高低点
      const yearData = close.slice(-252);
      result.high_52w = round(Math.max(...yearData));
      result.low_52w = round(Math.min(...yearData));
      result.pct_from_52w_high = round((close[close.length - 1] / result.high_52w - 1) * 100);
    } catch {}
    return result;
  }
// ========== 股息率（中国 A 股） ==========
  async getDividendYield(symbol, peRatio, stockType) {
    // 方案1: 东方财富 push2 API（从 Worker 调用，网络更稳定）
    try {
      const code = symbol.replace('.SS', '').replace('.SZ', '');
      const market = symbol.endsWith('.SS') ? '1' : '0';
      const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${market}.${code}&fields=f186`;
      const d = await fetchJSON(url);
      const dy = d?.data?.f186;
      if (dy != null && dy > 0) return { value: round(dy / 100), source: '东方财富', updated_at: now() };
    } catch {}
    // 方案2: 从 PE 和行业分红率计算
    if (peRatio && peRatio > 0) {
      let payoutRatio = 0.30; // 默认 30% 分红率
      if (stockType.includes('银行')) payoutRatio = 0.30;
      else if (stockType.includes('电力')) payoutRatio = 0.70;
      else if (stockType.includes('矿业')) payoutRatio = 0.20;
      else if (stockType.includes('红利')) payoutRatio = 0.90;
      else if (stockType.includes('ETF') || stockType.includes('指数')) payoutRatio = 0.85;
      const dy = (payoutRatio / peRatio) * 100;
      return { value: round(dy), source: 'PE×分红率估算', updated_at: now() };
    }
    // 方案3: 红利类 ETF 无 PE 时用默认值
    if (stockType.includes('红利') || stockType.includes('ETF')) return { value: 4.5, source: '红利ETF参考值', updated_at: now() };
    return { value: null, source: '东方财富', updated_at: now() };
  }

// ========== 中国指数 PE（从腾讯财经获取） ==========
  async getChinaIndexPE() {
    const result = { shanghai_pe: null, csi300_pe: null };
    try {
      // 上证指数 PE（字段 40，1-indexed）
      const text1 = await fetchText('https://qt.gtimg.cn/q=sh000001');
      const parts1 = text1.split('~');
      if (parts1.length >= 41) {
        const pe = parseFloat(parts1[39]);
        if (!isNaN(pe) && pe > 0 && pe < 100) result.shanghai_pe = round(pe);
      }
    } catch {}
    try {
      // 沪深300 PE
      const text2 = await fetchText('https://qt.gtimg.cn/q=sh000300');
      const parts2 = text2.split('~');
      if (parts2.length >= 41) {
        const pe = parseFloat(parts2[39]);
        if (!isNaN(pe) && pe > 0 && pe < 100) result.csi300_pe = round(pe);
      }
    } catch {}
    return result;
  }

  // ========== 历史价格（含分红，用于定投回测） ==========
  async getHistoricalPrices(symbol, startDate, endDate) {
    try {
      const start = Math.floor(new Date(startDate).getTime() / 1000);
      const end = Math.floor(new Date(endDate).getTime() / 1000);
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${start}&period2=${end}&interval=1d&events=div%2Csplit&includeAdjustedClose=true`;
      const d = await fetchJSONWithHeaders(url, { 'Referer': 'https://finance.yahoo.com/' });
      const result = d.chart?.result?.[0];
      if (!result) return { dates: [], prices: [], dividends: {} };
      const timestamps = result.timestamp || [];
      const adjclose = result.indicators?.adjclose?.[0]?.adjclose || [];
      const rawclose = result.indicators?.quote?.[0]?.close || [];
      // 优先用 adjclose，回退到 rawclose，过滤 null/0
      const prices = [];
      const dates = [];
      for (let i = 0; i < timestamps.length; i++) {
        let p = adjclose[i] != null ? adjclose[i] : rawclose[i];
        if (p == null || p <= 0) continue; // 跳过无效价格
        prices.push(p);
        dates.push(new Date(timestamps[i] * 1000).toISOString().slice(0, 10));
      }
      // 分红数据
      const divData = result.events?.dividends || {};
      const dividends = {};
      for (const [key, val] of Object.entries(divData)) {
        const ts = parseInt(key) * 1000;
        const date = new Date(ts).toISOString().slice(0, 10);
        dividends[date] = (dividends[date] || 0) + (val.amount || 0);
      }
      return { dates, prices, dividends };
    } catch { return { dates: [], prices: [], dividends: {} }; }
  }
}

// ========== 工具函数 ==========
function round(v, d = 2) { return v != null ? parseFloat(v.toFixed(d)) : null; }
function now() { return new Date().toISOString(); }

function calcRSI(close, period) {
  const gains = [], losses = [];
  for (let i = 1; i < close.length; i++) {
    const diff = close[i] - close[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcMA(close, period) {
  const slice = close.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function calcEMA(close, period) {
  const k = 2 / (period + 1);
  let ema = close[0];
  for (let i = 1; i < close.length; i++) {
    ema = close[i] * k + ema * (1 - k);
  }
  return ema;
}