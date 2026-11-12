import test from 'node:test';
import assert from 'node:assert/strict';
import { Fetcher } from '../src/fetchers.js';

function mockResponse(body, { status = 200, setCookie = [] } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { getSetCookie: () => setCookie },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  };
}

test('getPERatio returns trailing and forward PE from Yahoo summaryDetail', async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).includes('fc.yahoo.com')) return mockResponse('', { setCookie: ['A=1; Path=/'] });
    if (String(url).includes('getcrumb')) return mockResponse('crumb123');
    if (String(url).includes('quoteSummary')) {
      return mockResponse({
        quoteSummary: { result: [{ summaryDetail: {
          trailingPE: { raw: 27.98 }, forwardPE: { raw: 25.5 },
        } }] },
      });
    }
    return mockResponse('not found', { status: 404 });
  };
  const r = await new Fetcher().getPERatio('QQQ');
  assert.equal(r.value, 27.98);
  assert.equal(r.forward_pe, 25.5);
  assert.equal(r.source, 'Yahoo Finance');
  assert.ok(urls.some(u => u.includes('quoteSummary')));
});

test('getPERatio handles missing forwardPE without blocking trailingPE', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('fc.yahoo.com')) return mockResponse('', { setCookie: ['A=1; Path=/'] });
    if (String(url).includes('getcrumb')) return mockResponse('crumb123');
    if (String(url).includes('quoteSummary')) {
      return mockResponse({ quoteSummary: { result: [{ summaryDetail: { trailingPE: { raw: 23.81 } } }] } });
    }
    return mockResponse('not found', { status: 404 });
  };
  const r = await new Fetcher().getPERatio('VOO');
  assert.equal(r.value, 23.81);
  assert.equal(r.forward_pe, null);
});

test('getStockPB uses Tencent snapshot for PB/PE', async () => {
  const fields = Array(88).fill('');
  fields[3] = '7.26'; fields[39] = '8.28'; fields[46] = '0.88'; fields[64] = '3.58';
  const text = `v_sh601288="${fields.join('~')}";`;
  globalThis.fetch = async () => mockResponse(text);
  const r = await new Fetcher().getStockPB('601288.SS');
  assert.equal(r.value, 0.88);
  assert.equal(r.pe, 8.28);
  assert.equal(r.source, '腾讯财经');
});

test('getTencentTechnical parses day/qfqday rows and computes MA200', async () => {
  const rows = [];
  for (let i = 0; i < 250; i++) {
    const close = 10 + i * 0.01;
    rows.push([`2025-01-${(i % 28) + 1}`, String(close), String(close), String(close + 0.1), String(close - 0.1), '1000']);
  }
  globalThis.fetch = async () => mockResponse({ data: { sh601288: { qfqday: rows } } });
  const r = await new Fetcher().getTencentTechnical('601288.SS');
  assert.equal(r.source, '腾讯财经 K线');
  assert.ok(r.ma200_pct > 0);
  assert.ok(r.pct_from_52w_high <= 0);
});

test('getTechnicalIndicators prefers Tencent K-line for A-shares', async () => {
  const rows = [];
  for (let i = 0; i < 250; i++) {
    const close = 10 + i * 0.01;
    rows.push([`2025-01-${(i % 28) + 1}`, String(close), String(close), String(close + 0.1), String(close - 0.1), '1000']);
  }
  globalThis.fetch = async (url) => {
    if (String(url).includes('yahoo')) return mockResponse({ chart: { result: [] } });
    if (String(url).includes('gtimg.cn')) return mockResponse({ data: { sh601288: { qfqday: rows } } });
    return mockResponse('', { status: 404 });
  };
  const r = await new Fetcher().getTechnicalIndicators('601288.SS');
  assert.equal(r.source, '腾讯财经 K线');
  assert.ok(r.ma200_pct != null);
});

test('getStockPB falls back to Eastmoney when Tencent is empty', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('qt.gtimg.cn')) return mockResponse('v_sh601288="1~x~601288";');
    if (String(url).includes('eastmoney')) return mockResponse({ data: { f43: 726, f92: 8.2765, f162: 806, f167: 89 } });
    return mockResponse('', { status: 404 });
  };
  const r = await new Fetcher().getStockPB('601288.SS');
  assert.equal(r.value, 0.88);
  assert.equal(r.source, '东方财富');
});

test('getForwardPE scrapes StockAnalysis Forward PE row', async () => {
  globalThis.fetch = async () => mockResponse('<table><tr><td>Forward PE</td><td class="x">19.80</td></tr></table>');
  const r = await new Fetcher().getForwardPE('QQQ');
  assert.equal(r.value, 19.8);
  assert.equal(r.source, 'StockAnalysis.com');
});

test('getForwardPE returns null on missing row', async () => {
  globalThis.fetch = async () => mockResponse('<table><tr><td>PE Ratio</td><td>26.46</td></tr></table>');
  const r = await new Fetcher().getForwardPE('QQQ');
  assert.equal(r.value, null);
});

test('getVIX3M reads ^VIX3M chart metadata', async () => {
  globalThis.fetch = async () => mockResponse({
    chart: { result: [{ meta: { regularMarketPrice: 18.4 }, indicators: { quote: [{ close: [17.9, 18.4] }] } }] },
  });
  const r = await new Fetcher().getVIX3M();
  assert.equal(r.value, 18.4);
  assert.equal(r.source, 'Yahoo Finance (^VIX3M)');
});

test('getVIX3M returns null value on network failure', async () => {
  globalThis.fetch = async () => { throw new Error('network'); };
  const r = await new Fetcher().getVIX3M();
  assert.equal(r.value, null);
});

test('getBaaYield reads last non-empty FRED DBAA row', async () => {
  globalThis.fetch = async () => mockResponse('observation_date,DBAA\n2026-11-07,5.18\n2026-11-10,5.21\n');
  const r = await new Fetcher().getBaaYield();
  assert.equal(r.value, 5.21);
  assert.equal(r.source, 'FRED (DBAA)');
});

test('getBaaYield skips empty trailing rows', async () => {
  globalThis.fetch = async () => mockResponse('observation_date,DBAA\n2026-11-07,5.18\n2026-11-10,\n');
  const r = await new Fetcher().getBaaYield();
  assert.equal(r.value, 5.18);
});

// ====== Task 1: D1 valuation_cache 通用读写 ======
function fakeCacheEnv() {
  const store = new Map();
  return {
    nasdaq_cache: {
      prepare: (sql) => {
        if (sql.includes('SELECT')) {
          return { bind: () => ({ first: async () => { const v = store.get('k'); return v ? { data: v.data, updated_at: v.updated_at } : null; } }) };
        }
        return { bind: () => ({ run: async () => { store.set('k', { data: JSON.stringify({ pb: 1.0 }), updated_at: '2026-11-12T00:00:00Z' }); } }) };
      },
    },
  };
}

test('getValuationCache reads stored value', async () => {
  const fetcher = new Fetcher();
  const env = fakeCacheEnv();
  await fetcher.setValuationCache(env, 'bank_pb_pct:abc_bank', { pb: 1.0 });
  const r = await fetcher.getValuationCache(env, 'bank_pb_pct:abc_bank');
  assert.equal(r.data.pb, 1.0);
  assert.equal(r.fetched_at, '2026-11-12T00:00:00Z');
});

test('getValuationCache returns null when env missing', async () => {
  const fetcher = new Fetcher();
  assert.equal(await fetcher.getValuationCache(undefined, 'k'), null);
});

// ====== Task 2: 银行个股 PB 历史分位（东财 RPT_VALUEANALYSIS_DET） ======
test('getBankPbHistory parses Eastmoney annual rows', async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const year = /TRADE_DATE%3E%3D%27([0-9]{4})/.exec(String(url))?.[1] || '2018';
    return mockResponse({ result: { data: [
      { TRADE_DATE: `${year}-01-02 00:00:00`, PB_MRQ: 1.67 },
      { TRADE_DATE: `${year}-01-03 00:00:00`, PB_MRQ: 1.69 },
      { TRADE_DATE: `${year}-01-04 00:00:00`, PB_MRQ: 1.68 },
    ] } });
  };
  const rows = await new Fetcher().getBankPbHistory('600036', '2018');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { date: '2018-01-02', pb: 1.67 });
  assert.ok(String(urls[0]).includes('RPT_VALUEANALYSIS_DET'));
});

test('pctRank computes percentile of current in history', () => {
  const f = new Fetcher();
  // 10 个等距点 1..10：current=3 → 10 个点中 ≤3 有 3 个 → 0.3
  const vals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.ok(Math.abs(f._pctRank(vals, 3) - 0.3) < 1e-9, `pct=${f._pctRank(vals, 3)}`);
  assert.equal(f._pctRank(vals, 0.5), 0);
  assert.equal(f._pctRank(vals, 100), 1);
  assert.equal(f._pctRank(vals, 3.5), 0.3); // 线性：3.5 落在 3-4 之间仍按 ≤ 计数
});

test('getBankPbPercentile returns null when cache missing', async () => {
  globalThis.fetch = async () => { throw new Error('should not fetch'); };
  const env = { nasdaq_cache: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } };
  assert.equal(await new Fetcher().getBankPbPercentile(env, 'abc_bank'), null);
});
