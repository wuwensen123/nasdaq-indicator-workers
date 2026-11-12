// 子请求预算修复：Workers 免费版单次调用 50 子请求上限，抓取流程必须留余量
import test from 'node:test';
import assert from 'node:assert/strict';
import { Fetcher } from '../src/fetchers.js';

function mockResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { getSetCookie: () => [] },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  };
}

test('getRealYield10Y skips FRED CSV (Workers egress 520) and uses Treasury XML directly', async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return mockResponse('<d:TC_10YEAR>2.15</d:TC_10YEAR><d:TC_10YEAR>2.21</d:TC_10YEAR>');
  };
  const r = await new Fetcher().getRealYield10Y();
  assert.equal(r.value, 2.21);
  assert.equal(r.source, 'Treasury.gov');
  assert.ok(!urls.some((u) => u.includes('fredgraph.csv')), `should not try FRED CSV: ${urls.join(', ')}`);
});

test('getCpiMap skips FRED CSV and parses multpl table', async () => {
  const urls = [];
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const rows = Array.from({ length: 130 }, (_, i) => {
    const y = 2015 + Math.floor(i / 12);
    return `<tr><td>${M[i % 12]} 1, ${y}</td><td>100.${i}</td></tr>`;
  }).join('');
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return mockResponse(`<table>${rows}</table>`);
  };
  const map = await new Fetcher().getCpiMap();
  assert.ok(map && map.size >= 120, `cpi map size=${map?.size}`);
  assert.equal(map.get('2015-01'), 100);
  assert.ok(!urls.some((u) => u.includes('fredgraph.csv')), `should not try FRED CSV: ${urls.join(', ')}`);
});

test('getForwardPEHistory serves from D1 cache within TTL without network', async () => {
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error('network not expected'); };
  const payload = { series: [{ date: '2026-11-01', value: 20.5 }], source: 'historyofmarket.com' };
  const env = {
    nasdaq_cache: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ data: JSON.stringify(payload), updated_at: new Date().toISOString() }),
          run: async () => ({}),
        }),
      }),
    },
  };
  const r = await new Fetcher().getForwardPEHistory('ndx', env);
  assert.equal(networkCalls, 0);
  assert.equal(r.series.length, 1);
  assert.equal(r.series[0].value, 20.5);
});

test('getForwardPEHistory writes D1 cache after successful fetch', async () => {
  const writes = [];
  globalThis.fetch = async () => mockResponse({
    forward: [{ date: '2026-10-30', value: 21.0 }, { date: '2026-11-06', value: 20.0 }],
    forwardOwn: [{ date: '2026-11-06', value: 20.1 }, { date: '2026-11-07', value: 20.2 }],
    current: { forwardOwn: 20.2 },
    updated: '2026-11-07',
  });
  const env = {
    nasdaq_cache: {
      prepare: (sql) => ({
        bind: (...args) => ({
          first: async () => null, // D1 无缓存
          run: async () => { writes.push({ sql, args }); },
        }),
      }),
    },
  };
  const r = await new Fetcher().getForwardPEHistory('spx', env);
  assert.equal(r.series.length, 3);
  assert.ok(writes.some((w) => w.sql.includes('INSERT INTO valuation_cache')), 'should persist to D1');
});

test('getCachedDaily serves fresh value from D1 without network', async () => {
  let networkCalls = 0;
  const env = {
    nasdaq_cache: {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ data: JSON.stringify({ value: 34.5, source: 'multpl.com' }), updated_at: new Date().toISOString() }),
          run: async () => ({}),
        }),
      }),
    },
  };
  const r = await new Fetcher().getCachedDaily(env, 'shiller_pe', 24, async () => { networkCalls++; return { value: 99 }; });
  assert.equal(networkCalls, 0);
  assert.equal(r.value, 34.5);
});

test('getCachedDaily refetches when TTL expired and persists success', async () => {
  const writes = [];
  const stale = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const env = {
    nasdaq_cache: {
      prepare: (sql) => ({
        bind: (...args) => ({
          first: async () => ({ data: JSON.stringify({ value: 30 }), updated_at: stale }),
          run: async () => { writes.push(sql); },
        }),
      }),
    },
  };
  const r = await new Fetcher().getCachedDaily(env, 'shiller_pe', 24, async () => ({ value: 40, source: 'multpl.com' }));
  assert.equal(r.value, 40);
  assert.ok(writes.some((s) => s.includes('INSERT INTO valuation_cache')));
});

test('getCachedDaily does not persist null results', async () => {
  const writes = [];
  const env = {
    nasdaq_cache: {
      prepare: (sql) => ({
        bind: () => ({
          first: async () => null,
          run: async () => { writes.push(sql); },
        }),
      }),
    },
  };
  const r = await new Fetcher().getCachedDaily(env, 'shiller_pe', 24, async () => ({ value: null, source: 'multpl.com' }));
  assert.equal(r.value, null);
  assert.equal(writes.filter((s) => s.includes('INSERT')).length, 0);
});

test('prefetchTencentQuotes fetches all A-share snapshots in ONE request', async () => {
  const seg = (name, code, price, pe, pb, dy) => {
    const p = Array(70).fill('0');
    p[0] = '1'; p[1] = name; p[2] = code;
    p[3] = String(price); p[39] = String(pe); p[46] = String(pb); p[64] = String(dy);
    return p.join('~');
  };
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return mockResponse(
      `v_sh600036="${seg('招商银行', '600036', 40.5, 6.2, 0.92, 5.2)}";v_sh601288="${seg('农业银行', '601288', 6.1, 5.1, 0.71, 4.8)}";`
    );
  };
  const f = new Fetcher();
  await f.prefetchTencentQuotes(['600036.SS', '601288.SS', '601939.SS']);
  assert.equal(urls.length, 1, 'one batched request only');
  // 批量结果进入缓存：后续逐个取值不再发请求
  const cmb = await f.getTencentQuote('600036.SS');
  assert.equal(cmb.pb, 0.92);
  assert.equal(urls.length, 1);
  // 响应中缺失的标的标记为 null，不触发逐个重试
  const ccb = await f.getTencentQuote('601939.SS');
  assert.equal(ccb, null);
  assert.equal(urls.length, 1);
});
