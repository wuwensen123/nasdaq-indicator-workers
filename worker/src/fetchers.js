/**
 * 数据获取 — 对接 Yahoo Finance / CNN / CBOE 等公开数据源
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
    // 从 Yahoo Finance SPY 期权数据估算
    try {
      const d = await fetchJSON('https://query2.finance.yahoo.com/v7/finance/options/SPY?formatted=true&lang=en-US&region=US');
      const opt = d?.optionChain?.result?.[0]?.options?.[0];
      if (opt) {
        const calls = (opt.calls || []).reduce((s, c) => s + (c.volume || 0), 0);
        const puts = (opt.puts || []).reduce((s, p) => s + (p.volume || 0), 0);
        if (calls > 100 && puts > 100) {
          const ratio = puts / calls;
          if (ratio > 0.1 && ratio < 5) return { value: round(ratio), label: this._pcLabel(ratio), source: 'SPY期权估算', updated_at: now() };
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
    // Yahoo Finance v10
    try {
      const summary = await fetchJSONWithHeaders('https://query1.finance.yahoo.com/v10/finance/quoteSummary/' + encodeURIComponent(symbol) + '?modules=summaryDetail', {
        'Referer': 'https://finance.yahoo.com/',
      });
      const pe = summary?.quoteSummary?.result?.[0]?.summaryDetail?.trailingPE?.raw;
      if (pe != null && pe > 0 && pe < 200) return { value: round(pe), source: 'Yahoo Finance', updated_at: now(), name };
    } catch {}
    // Yahoo Finance v6
    try {
      const quote = await fetchJSONWithHeaders('https://query1.finance.yahoo.com/v6/finance/quote?symbols=' + encodeURIComponent(symbol), {
        'Referer': 'https://finance.yahoo.com/',
      });
      const pe = quote?.quoteResponse?.result?.[0]?.trailingPE;
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