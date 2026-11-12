/**
 * 数据获取 — 对接 Yahoo Finance / CNN / CBOE 等公开数据源
 */

import * as XLSX from 'xlsx';

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

async function fetchYahooPE(symbol) {
  // crumb 失效（401/403）时清缓存重取一次；一次请求同时取 trailing 与 forward
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { cookie, crumb } = await getYahooAuth();
      const url = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' + encodeURIComponent(symbol) + '?modules=summaryDetail&crumb=' + encodeURIComponent(crumb);
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Cookie': cookie, 'Referer': 'https://finance.yahoo.com/' } });
      if ((res.status === 401 || res.status === 403) && attempt === 0) { yahooAuth = null; continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      const sd = d?.quoteSummary?.result?.[0]?.summaryDetail;
      return { trailing: sd?.trailingPE?.raw ?? null, forward: sd?.forwardPE?.raw ?? null };
    } catch { yahooAuth = null; }
  }
  return { trailing: null, forward: null };
}

export class Fetcher {
  // ========== D1 通用估值缓存（银行PB历史分位等低频大数据） ==========
  async getValuationCache(env, key) {
    if (!env?.nasdaq_cache) return null;
    try {
      const r = await env.nasdaq_cache.prepare('SELECT data, updated_at FROM valuation_cache WHERE key = ?').bind(key).first();
      return r ? { data: JSON.parse(r.data), fetched_at: r.updated_at } : null;
    } catch { return null; }
  }

  async setValuationCache(env, key, data) {
    if (!env?.nasdaq_cache) return;
    try {
      await env.nasdaq_cache.prepare(
        'INSERT INTO valuation_cache (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
      ).bind(key, JSON.stringify(data), new Date().toISOString()).run();
    } catch {}
  }

  // ========== 慢变量 D1 缓存（Workers 免费版 50 子请求上限：月线/周线数据不必每次重抓） ==========
  // isOk 判断结果是否值得缓存（默认：有数值 value / 非空 map / csi pe1）；失败结果不缓存
  async getCachedDaily(env, key, ttlHours, fn, isOk) {
    const d1Key = 'daily:' + key;
    if (env?.nasdaq_cache) {
      const cached = await this.getValuationCache(env, d1Key);
      if (cached?.data && cached.fetched_at && Date.now() - new Date(cached.fetched_at).getTime() < ttlHours * 3600 * 1000) {
        return cached.data;
      }
    }
    const fresh = await fn();
    const ok = isOk
      ? isOk(fresh)
      : (fresh && (typeof fresh.value === 'number' || (fresh.map && Object.keys(fresh.map).length > 0) || fresh.pe1 != null));
    if (env?.nasdaq_cache && ok) await this.setValuationCache(env, d1Key, fresh);
    return fresh;
  }

  // ========== 银行个股 PB 历史分位（东方财富估值分析，2018 至今，每日一条） ==========
  // 之前 pb_pct_hist 用中证银行指数分位（四行共享），这里换成分股自身历史序列
  static get BANK_EM_CODES() { return { abc_bank: '601288', ccb_bank: '601939', cmb_bank: '600036' }; }

  async getBankPbHistory(code, year) {
    const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_VALUEANALYSIS_DET&columns=TRADE_DATE,PB_MRQ&filter=(SECURITY_CODE%3D%22${code}%22)(TRADE_DATE%3E%3D%27${year}-01-01%27)(TRADE_DATE%3C%3D%27${year}-12-31%27)&pageSize=500&sortColumns=TRADE_DATE&sortTypes=1`;
    const d = await fetchJSON(url);
    const rows = d?.result?.data ?? [];
    return rows
      .filter(r => r.PB_MRQ != null && !isNaN(parseFloat(r.PB_MRQ)))
      .map(r => ({ date: String(r.TRADE_DATE).slice(0, 10), pb: parseFloat(r.PB_MRQ) }));
  }

  // 当前值在历史序列中的分位（0-1）；边界：<=min→0、>=max→1
  _pctRank(values, current) {
    if (!values?.length || current == null) return null;
    const sorted = [...values].sort((a, b) => a - b);
    if (current <= sorted[0]) return 0;
    const n = sorted.length;
    // 线性插值分位：比 current 小的占多少（含等值）
    let le = 0;
    for (const v of sorted) { if (v <= current) le++; else break; }
    return le / n;
  }

  // 全量刷新：3 家银行 × 2018..今，逐年请求（已有年份跳过），算分位，写 D1
  async refreshBankPbPercentiles(env) {
    const codes = Fetcher.BANK_EM_CODES;
    const nowYear = new Date().getUTCFullYear();
    const updated = {};
    for (const [id, code] of Object.entries(codes)) {
      try {
        const cached = await this.getValuationCache(env, `bank_pb_hist:${id}`);
        const points = (cached?.data?.points ?? []).map(p => ({ date: String(p.d), pb: p.pb }));
        for (let year = 2018; year <= nowYear; year++) {
          const y = String(year);
          if (!points.some(p => p.date.startsWith(y))) {
            const rows = await this.getBankPbHistory(code, y);
            for (const r of rows) if (!points.some(p => p.date === r.date)) points.push(r);
          }
        }
        points.sort((a, b) => a.date < b.date ? -1 : 1);
        if (!points.length) { updated[id] = false; continue; }
        const pbs = points.map(p => p.pb);
        const sorted = [...pbs].sort((a, b) => a - b);
        const current = pbs[pbs.length - 1];
        const pct = this._pctRank(pbs, current);
        const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
        await this.setValuationCache(env, `bank_pb_hist:${id}`, { points: points.map(p => ({ d: p.date, pb: p.pb })) });
        await this.setValuationCache(env, `bank_pb_pct:${id}`, {
          pct, current_pb: current, count: points.length, median,
          source: '东方财富估值分析(RPT_VALUEANALYSIS_DET,2018至今)', updated_at: new Date().toISOString(),
        });
        updated[id] = true;
      } catch (e) { updated[id] = false; }
    }
    return { updated, at: new Date().toISOString() };
  }

  // refresh 流程只读 D1，不现场抓（节省子请求配额）
  async getBankPbPercentile(env, id) {
    if (!Fetcher.BANK_EM_CODES[id]) return null;
    const c = await this.getValuationCache(env, `bank_pb_pct:${id}`);
    return c ? { ...c.data, fetched_at: c.fetched_at } : null;
  }

  // ========== NDX/SPX Forward PE 历史（historyofmarket.com，CC BY 4.0） ==========
  // terminal 12M blended-forward consensus（周度）2001/1990 起；forwardOwn（ETF持仓加权日更）2026-08 起，
  // 两者同口径连续（重叠日差 0.2-0.6%），合并后做 Forward PE 动态历史分位
  _mergeFwdSeries(fwd, fwdOwn) {
    const own = Array.isArray(fwdOwn) ? [...fwdOwn] : [];
    const base = Array.isArray(fwd) ? [...fwd] : [];
    const lastBaseDate = base.length ? base[base.length - 1].date : null;
    const tail = own.filter(p => lastBaseDate == null || p.date >= lastBaseDate);
    const merged = [...base.filter(p => lastBaseDate == null || p.date < lastBaseDate), ...tail];
    merged.sort((a, b) => a.date < b.date ? -1 : 1);
    // 去重（保后者）
    const seen = new Set();
    return merged.filter(p => {
      if (seen.has(p.date)) return false;
      seen.add(p.date);
      return true;
    });
  }

  // 抓取并缓存：内存 6h + D1 12h（cron 冷启动/多 isolate 时省子请求）；失败返回 null（analyzer 回退静态锚点表）
  async getForwardPEHistory(series, env) {
    const key = series === 'ndx' ? 'ndx' : 'spx';
    if (this._fwdHistCache?.[key] && Date.now() - this._fwdHistCache[key].ts < 6 * 3600 * 1000) {
      return this._fwdHistCache[key].data;
    }
    // D1 缓存：序列日更，12h 内直接复用（HTTP refresh 不再重复抓）
    const d1Key = 'fwd_pe_hist:' + key;
    if (env?.nasdaq_cache) {
      const cached = await this.getValuationCache(env, d1Key);
      if (cached?.data?.series?.length && cached.fetched_at && Date.now() - new Date(cached.fetched_at).getTime() < 12 * 3600 * 1000) {
        this._fwdHistCache = { ...(this._fwdHistCache || {}), [key]: { ts: Date.now(), data: cached.data } };
        return cached.data;
      }
    }
    try {
      const url = `https://historyofmarket.com/api/${key === 'ndx' ? 'ndx' : 'sp500'}/forward-pe.json`;
      const j = await fetchJSON(url);
      const seriesData = {
        series: this._mergeFwdSeries(j.forward, j.forwardOwn),
        currentOwn: j.current?.forwardOwn ?? null,
        updated_at: j.updated ?? null,
        source: 'historyofmarket.com',
      };
      if (!seriesData.series.length) return null;
      this._fwdHistCache = { ...(this._fwdHistCache || {}), [key]: { ts: Date.now(), data: seriesData } };
      if (env?.nasdaq_cache) await this.setValuationCache(env, d1Key, seriesData);
      return seriesData;
    } catch { return null; }
  }

  // 值在序列中的分位（0-1）：lowerBound 索引 / n；<=min→0、>=max→1
  _pctInSeries(value, series) {
    if (!Array.isArray(series) || !series.length || value == null) return null;
    const sorted = series.map(p => p.value).sort((a, b) => a - b);
    if (value <= sorted[0]) return 0;
    if (value >= sorted[sorted.length - 1]) return 1;
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= value) lo = mid + 1; else hi = mid; }
    return lo / sorted.length;
  }

  // ========== VIX ==========
  // 进程内短缓存：同一次 refresh 里 put_call 兜底会重复调用，省子请求
  async getVIX() {
    if (this._vixCache && Date.now() - this._vixCache.ts < 60000) return this._vixCache.data;
    try {
      const d = await fetchJSON('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?range=5d&interval=1d');
      const meta = d.chart?.result?.[0]?.meta;
      const quotes = d.chart?.result?.[0]?.indicators?.quote?.[0];
      if (!meta || !quotes) return { value: null, change: 0, source: 'Yahoo Finance' };
      const close = quotes.close?.filter(c => c != null);
      const value = meta.regularMarketPrice ?? close?.[close.length - 1];
      const change = close?.length >= 2 ? ((close[close.length - 1] - close[close.length - 2]) / close[close.length - 2]) * 100 : 0;
      const data = { value: round(value), change: round(change), source: 'Yahoo Finance (^VIX)', updated_at: now() };
      this._vixCache = { ts: Date.now(), data };
      return data;
    } catch { return { value: null, change: 0, source: 'Yahoo Finance', updated_at: now() }; }
  }

  // ========== VIX3M（3个月波动率，用于 VIX/VIX3M 期限结构） ==========
  async getVIX3M() {
    try {
      const d = await fetchJSON('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX3M?range=5d&interval=1d');
      const meta = d.chart?.result?.[0]?.meta;
      const quotes = d.chart?.result?.[0]?.indicators?.quote?.[0];
      if (!meta || !quotes) return { value: null, change: 0, source: 'Yahoo Finance (^VIX3M)', updated_at: now() };
      const close = quotes.close?.filter(c => c != null);
      const value = meta.regularMarketPrice ?? close?.[close.length - 1];
      const change = close?.length >= 2 ? ((close[close.length - 1] - close[close.length - 2]) / close[close.length - 2]) * 100 : 0;
      return { value: round(value), change: round(change), source: 'Yahoo Finance (^VIX3M)', updated_at: now() };
    } catch { return { value: null, change: 0, source: 'Yahoo Finance (^VIX3M)', updated_at: now() }; }
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
  // 只用美国财政部官方 XML：FRED CSV 在 Workers 出口必 520（实测），不再白耗 1 个子请求
  async getRealYield10Y() {
    try {
      const xml = await fetch('https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_real_yield_curve&field_tdr_date_value=' + new Date().getUTCFullYear(), { headers: { 'User-Agent': UA_PLAIN } }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); });
      const vals = [...xml.matchAll(/<d:TC_10YEAR[^>]*>([0-9.\-]+)</g)].map(m => parseFloat(m[1])).filter(v => !isNaN(v));
      if (vals.length) return { value: round(vals[vals.length - 1]), source: 'Treasury.gov', updated_at: now() };
    } catch {}
    return { value: null, source: 'Treasury.gov 失败', updated_at: now() };
  }

  // ========== 穆迪Baa公司债收益率（EY spread vs Baa，JPM估值表口径） ==========
  // 每日真值来自 FRED API（api.stlouisfed.org，Workers 出口可通），需免费 API key 配置为
  // Worker secret FRED_API_KEY；无 key 或请求失败时返回 null，analyzer 回退 JPM 锚 + 10Y 调整
  async getBaaYield(env) {
    const key = env?.FRED_API_KEY;
    if (!key) {
      // 无 key：跳过请求（fredgraph.csv 在 Workers 出口必 520，省子请求），直接走 JPM 锚兜底
      return { value: null, source: 'FRED (DBAA)', updated_at: now() };
    }
    try {
      const j = await fetchJSON(`https://api.stlouisfed.org/fred/series/observations?series_id=DBAA&file_type=json&sort_order=desc&limit=3&api_key=${encodeURIComponent(key)}`);
      const obs = j?.observations ?? [];
      for (const o of obs) {
        const v = parseFloat(o?.value);
        if (!isNaN(v)) return { value: round(v), source: 'FRED API (DBAA)', updated_at: o.date ?? now() };
      }
      return { value: null, source: 'FRED API (DBAA)', updated_at: now() };
    } catch {
      return { value: null, source: 'FRED API (DBAA)', updated_at: now() };
    }
  }

  // ========== 黄金实际价格历史分位（GC=F月线 ÷ CPI，黄金的"CAPE"） ==========
  // CPI 只用 multpl.com 月度表：FRED CSV 在 Workers 出口必 520（实测），不再白耗 1 个子请求
  async getCpiMap() {
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

  // ========== 韭圈儿指数估值（独立指数 PE/PB/股息率 + 10年分位 + ROE） ==========
  // 解决蛋卷只有「红利低波」、没有 930955 的问题：两个红利指数用各自独立代码
  async getJiuquanValuations() {
    try {
      const d = await fetchJSONWithHeaders('https://ai2.jiucaishuo.com/api/index-valuation?category=zt', { 'Referer': 'https://www.jiucaishuo.com/' });
      const rows = d?.rows || [];
      if (!rows.length) throw new Error('空数据');
      const map = {};
      for (const it of rows) {
        if (!it?.code) continue;
        map[it.code] = {
          name: it.name || null,
          pe: it.pe ?? null, pb: it.pb ?? null,
          pe_pct: it.pe_pct ?? null, pb_pct: it.pb_pct ?? null,
          dy: it.xilv ?? null, dy_pct: it.xilv_pct ?? null,
          roe: it.roe != null ? round(it.roe * 100, 2) : null,
          date: it.update_time || null,
          insufficient: !!it.insufficient,
        };
      }
      return { map, source: '韭圈儿', updated_at: now() };
    } catch (e) {
      return { map: {}, source: '韭圈儿错误: ' + String(e?.message || e).slice(0, 40), updated_at: now() };
    }
  }

  // ========== 中证指数官方每日估值（P/E、D/P 的总股本与计算用股本两口径） ==========
  // 官方 Excel 为 BIFF8 .xls，含最近21个交易日；PB/ROE 只在月度指数单张中，见各标的 data_note
  async getCSIIndexValuation(code) {
    try {
      const url = `https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/autofile/indicator/${code}indicator.xls`;
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://www.csindex.com.cn/' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
      if (!rows || rows.length < 2) throw new Error('空数据');
      const r = rows[1]; // 最新交易日
      const num = (v) => { const n = Number(v); return Number.isFinite(n) ? round(n, 2) : null; };
      const raw = String(r[0] ?? '');
      const date = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw;
      return {
        code: String(r[1] ?? code), date,
        pe1: num(r[6]), pe2: num(r[7]),
        dy1: num(r[8]), dy2: num(r[9]),
        source: '中证指数', updated_at: now(),
      };
    } catch (e) {
      return { code, error: String(e?.message || e).slice(0, 80), source: '中证指数', updated_at: now() };
    }
  }

  // ========== 大宗商品价格历史分位（周期股的周期位置锚） ==========
  async getCommodityPercentile(symbol, name) {
    try {
      const d = await fetchJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=10y&interval=1wk`);
      const closes = (d.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter(c => c != null);
      if (closes.length < 150) return { value: null, source: name, updated_at: now() };
      const cur = closes[closes.length - 1];
      const pct = closes.filter(x => x <= cur).length / closes.length * 100;
      return { value: round(pct, 1), current: round(cur), source: `${name} (10y周线)`, updated_at: now() };
    } catch {}
    return { value: null, source: name, updated_at: now() };
  }

  // ========== 腾讯A股快照（一次请求同时拿 PB/PE/股息率/价格） ==========
  // 批量预取：q=sh600036,sh601288,... 一次请求覆盖全部 A 股，省逐个请求（免费版 50 子请求上限）
  async prefetchTencentQuotes(symbols) {
    this._txQuoteCache = this._txQuoteCache || {};
    const todo = symbols.filter(s => this._txQuoteCache[s] === undefined);
    if (!todo.length) return;
    try {
      const q = todo.map(s => (s.endsWith('.SS') ? 'sh' : 'sz') + s.replace(/\.(SS|SZ)$/, '')).join(',');
      const text = await fetchText('https://qt.gtimg.cn/q=' + q);
      const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
      for (const m of text.matchAll(/v_((?:sh|sz)\d+)="([^"]*)"/g)) {
        const code = m[1];
        const symbol = (code.startsWith('sh') ? code.slice(2) + '.SS' : code.slice(2) + '.SZ');
        const parts = m[2].split('~');
        if (parts.length < 65) { this._txQuoteCache[symbol] = null; continue; }
        this._txQuoteCache[symbol] = {
          price: num(parts[3]),
          pe: num(parts[39]),
          pb: num(parts[46]),
          dividend_yield: num(parts[64]),
        };
      }
      // 响应中缺失的标的标记 null（后续走东财/估算兜底，不再逐个重试）
      for (const s of todo) if (this._txQuoteCache[s] === undefined) this._txQuoteCache[s] = null;
    } catch {
      // 批量失败不写缓存，留给 getTencentQuote 逐个兜底
    }
  }

  // 同一次 refresh 内 getPERatio/getStockPB/getDividendYield 共用，省子请求
  async getTencentQuote(symbol) {
    this._txQuoteCache = this._txQuoteCache || {};
    if (this._txQuoteCache[symbol] !== undefined) return this._txQuoteCache[symbol];
    try {
      const code = symbol.replace('.SS', '').replace('.SZ', '');
      const mk = symbol.endsWith('.SS') ? 'sh' : 'sz';
      const text = await fetchText('https://qt.gtimg.cn/q=' + mk + code);
      const parts = text.split('~');
      if (parts.length < 65) { this._txQuoteCache[symbol] = null; return null; }
      const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
      const data = {
        price: num(parts[3]),
        pe: num(parts[39]),
        pb: num(parts[46]),
        dividend_yield: num(parts[64]),
      };
      this._txQuoteCache[symbol] = data;
      return data;
    } catch { this._txQuoteCache[symbol] = null; return null; }
  }

  // ========== 个股PB（腾讯优先，东财兜底） ==========
  // 注: 东财 f167带×100缩放且字段口径不稳，用 价格(f43/100)÷每股净资产(f92) 自算，f167 兜底
  async getStockPB(symbol) {
    // 腾讯字段46=PB、39=PE，一次请求；对连续请求比东财稳
    const q = await this.getTencentQuote(symbol);
    if (q?.pb != null && q.pb > 0.1 && q.pb < 30) {
      return {
        value: round(q.pb, 2),
        pe: q.pe != null && q.pe > 0 && q.pe < 200 ? round(q.pe, 2) : null,
        source: '腾讯财经', updated_at: now(),
      };
    }
    // 东财兜底（单次，避免连续请求被掐）
    try {
      const code = symbol.replace('.SS', '').replace('.SZ', '');
      const market = symbol.endsWith('.SS') ? '1' : '0';
      const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${market}.${code}&fields=f43,f92,f162,f167`;
      const d = await fetchJSON(url);
      const data = d?.data || {};
      let pb = null;
      if (data.f92 > 0 && data.f43 > 0) pb = (data.f43 / 100) / data.f92;
      if (pb == null && data.f167 != null) pb = data.f167 > 15 ? data.f167 / 100 : data.f167;
      let pe = data.f162 != null ? data.f162 / 100 : null;
      if (!(pe > 0 && pe < 200)) pe = null;
      if (pb != null && pb > 0.1 && pb < 30) return { value: round(pb, 2), pe: pe != null ? round(pe) : null, source: '东方财富', updated_at: now() };
      console.error('PB取值异常', symbol, JSON.stringify(data).slice(0, 120));
      if (pe != null) return { value: null, pe, source: '东方财富', updated_at: now() };
    } catch (e) {
      console.error('PB请求失败', symbol, String(e?.message || e).slice(0, 80));
    }
    return { value: null, pe: null, source: '东方财富', updated_at: now() };
  }

    // ========== PE Ratio ==========
  async getPERatio(symbol, name = '') {
    // 中国A股: 先用腾讯财经（与 getStockPB/getDividendYield 共用同一快照）
    if (symbol.endsWith('.SS') || symbol.endsWith('.SZ')) {
      const q = await this.getTencentQuote(symbol);
      if (q?.pe != null && q.pe > 0 && q.pe < 200) {
        return { value: round(q.pe), forward_pe: null, source: '腾讯财经', updated_at: now(), name };
      }
    }
    // Yahoo Finance v10（cookie+crumb 认证，与官网网页口径一致）
    try {
      const pe = await fetchYahooPE(symbol);
      if (pe.trailing != null && pe.trailing > 0 && pe.trailing < 200) {
        return {
          value: round(pe.trailing),
          forward_pe: pe.forward != null && pe.forward > 0 && pe.forward < 200 ? round(pe.forward) : null,
          source: 'Yahoo Finance', updated_at: now(), name,
        };
      }
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
          if (pe > 5 && pe < 100) return { value: round(pe), forward_pe: null, source: 'worldperatio.com', updated_at: now(), name };
        }
      }
    } catch {}
    return { value: null, forward_pe: null, source: 'Yahoo Finance', updated_at: now(), name };
  }

  // ========== Forward P/E（StockAnalysis.com，ETF 日更） ==========
  // Yahoo 对 ETF 的 forwardPE 返回空对象；StockAnalysis 有 QQQ/VOO 的 Forward PE
  async getForwardPE(symbol) {
    try {
      const html = await fetchText(`https://stockanalysis.com/etf/${symbol.toLowerCase()}/`);
      const m = html.match(/Forward PE<\/td>\s*<td[^>]*>([0-9.]+)<\/td>/i);
      const v = m ? parseFloat(m[1]) : null;
      if (v != null && v > 5 && v < 100) return { value: round(v), source: 'StockAnalysis.com', updated_at: now() };
    } catch {}
    return { value: null, source: 'StockAnalysis.com', updated_at: now() };
  }

// ========== 技术指标（RSI, MA, MACD） ==========
  async getTechnicalIndicators(symbol, period = '1y') {
    const result = { current_price: null, rsi: null, ma200: null, ma200_pct: null, ma50: null, ma50_pct: null, macd: null, macd_signal: null, high_52w: null, low_52w: null, pct_from_52w_high: null, source: 'Yahoo Finance + 计算', updated_at: now() };
    const isCN = symbol.endsWith('.SS') || symbol.endsWith('.SZ');
    let txTried = false;
    // A股优先用腾讯前复权日线：Yahoo 对 .SS 偶发限流/无历史，且腾讯一次请求即可算 MA200
    if (isCN) {
      txTried = true;
      const tx = await this.getTencentTechnical(symbol);
      if (tx) return tx;
    }
    try {
      const d = await fetchJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${period}&interval=1d`);
      const quotes = d.chart?.result?.[0];
      const close = quotes?.indicators?.quote?.[0]?.close?.filter(c => c != null) || [];
      if (close.length) {
        // 先取最新价：部分指数（如930955）Yahoo只有单点报价、没有历史K线
        result.current_price = round(close[close.length - 1]);
        if (close.length >= 50) {
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
        }
      }
    } catch {}

    // A股腾讯已优先尝试；此处只处理未尝试过的场景（保留给未来非CN扩展）
    if (!txTried && isCN && (result.current_price == null || result.ma200_pct == null)) {
      const tx = await this.getTencentTechnical(symbol);
      if (tx) return tx;
    }
    return result;
  }

  // 腾讯前复权日线（A股 fallback）：320天，计算 MA50/MA200、RSI、52周高低点
  async getTencentTechnical(symbol) {
    try {
      const code = symbol.replace('.SS', '').replace('.SZ', '');
      const mk = symbol.endsWith('.SS') ? 'sh' : 'sz';
      // 不加 qfq：与 Yahoo chart 的未复权 close 口径一致，避免分红除权造成 MA200 跳变
      const d = await fetchJSON(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${mk}${code},day,,,320,`);
      const item = d?.data?.[`${mk}${code}`];
      const rows = item?.qfqday || item?.day || [];
      const closes = rows.map(r => parseFloat(r[2])).filter(v => !isNaN(v));
      if (closes.length < 200) return null;
      const highs = rows.map(r => parseFloat(r[3])).filter(v => !isNaN(v));
      const lows = rows.map(r => parseFloat(r[4])).filter(v => !isNaN(v));
      const current = closes[closes.length - 1];
      const ma200 = calcMA(closes, 200);
      const ma50 = calcMA(closes, 50);
      const high52 = Math.max(...highs.slice(-252));
      const low52 = Math.min(...lows.slice(-252));
      return {
        current_price: round(current),
        rsi: round(calcRSI(closes, 14)),
        ma200: round(ma200), ma200_pct: round((current / ma200 - 1) * 100),
        ma50: round(ma50), ma50_pct: round((current / ma50 - 1) * 100),
        macd: null, macd_signal: null,
        high_52w: round(high52), low_52w: round(low52),
        pct_from_52w_high: round((current / high52 - 1) * 100),
        source: '腾讯财经 K线', updated_at: now(),
      };
    } catch { return null; }
  }
// ========== 股息率（中国 A 股） ==========
  async getDividendYield(symbol, peRatio, stockType) {
    // 方案0: 腾讯财经字段64（TTM股息率），与 getStockPB 共用同一快照
    const q = await this.getTencentQuote(symbol);
    if (q?.dividend_yield != null && q.dividend_yield > 0.1 && q.dividend_yield < 15) {
      return { value: round(q.dividend_yield), source: '腾讯财经', updated_at: now() };
    }
    // 方案1: 东方财富 push2 API（f186，兜底）
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