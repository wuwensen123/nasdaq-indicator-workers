import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

// D1 mock：支持 valuation_cache 读写（getCachedDaily 的缓存命中路径）
function mockD1() {
  const store = new Map();
  const env = {
    nasdaq_cache: {
      prepare(sql) {
        let args = [];
        const stmt = {
          sql,
          bind(...a) { args = a; return stmt; },
          async run() {
            if (sql.includes('INSERT INTO valuation_cache')) store.set(args[0], args[1]);
            return {};
          },
          async first() {
            if (sql.includes('FROM valuation_cache')) {
              const v = store.get(args[0]);
              return v ? { data: v, updated_at: new Date().toISOString() } : null;
            }
            return null;
          },
          async all() { return { results: [] }; },
        };
        return stmt;
      },
      batch: async (stmts) => stmts.map(() => ({})),
    },
  };
  return { env, store };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

// 腾讯周K fixture：60 行，前 8 行占位 → slice(-52) 后首根为 2026-11-13
function tencentWeeklyRows() {
  const rows = [];
  for (let i = 0; i < 8; i++) {
    const d = new Date(Date.UTC(2026, 8, 18) + i * 7 * 86400000).toISOString().slice(0, 10);
    rows.push([d, '1.10', '1.11', '1.12', '1.09', '100']);
  }
  rows.push(['2026-11-13', '1.21', '1.23', '1.24', '1.20', '100']);
  for (let i = 1; i <= 51; i++) {
    const d = new Date(Date.UTC(2026, 10, 13) + i * 7 * 86400000).toISOString().slice(0, 10);
    rows.push([d, '1.30', '1.31', '1.32', '1.29', '100']);
  }
  return rows;
}

// Yahoo 月K fixture：70 个月 → slice(-60) 后首根为 2021-11-01
function yahooMonthlyFixture() {
  const timestamps = [];
  const open = [], high = [], low = [], close = [];
  for (let i = 0; i < 70; i++) {
    timestamps.push(Date.UTC(2021 + Math.floor(i / 12), i % 12, 1) / 1000);
    open.push(i + 1); high.push(i + 2); low.push(i + 0.5); close.push(i + 1.5);
  }
  return {
    chart: {
      result: [{
        timestamp: timestamps,
        indicators: { quote: [{ open, high, low, close }] },
      }],
    },
  };
}

// Yahoo 周K fixture：60 周 → slice(-52) 后首根为第 8 个点
function yahooWeeklyFixture() {
  const timestamps = [];
  const open = [], high = [], low = [], close = [];
  for (let i = 0; i < 60; i++) {
    timestamps.push(Date.UTC(2025, 9, 6) / 1000 + i * 7 * 86400);
    open.push(i + 1); high.push(i + 2); low.push(i + 0.5); close.push(i + 1.5);
  }
  return {
    chart: {
      result: [{
        timestamp: timestamps,
        indicators: { quote: [{ open, high, low, close }] },
      }],
    },
  };
}

test('GET /api/ohlc series=ndx fetches Yahoo ^NDX weekly and slices to 52', async () => {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('chart/%5ENDX') && String(url).includes('interval=1wk')) return jsonResponse(yahooWeeklyFixture());
    throw new Error('unexpected url ' + url);
  };
  try {
    const { env } = mockD1();
    const res = await worker.fetch(new Request('https://x/api/ohlc?target=qqq&period=weekly&series=ndx'), env, { waitUntil() {} });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.target, 'qqq');
    assert.equal(body.period, 'weekly');
    assert.equal(body.candles.length, 52);
    assert.equal(body.candles[0].o, 9);
    assert.equal(body.candles[51].c, 60.5);
    assert.ok(calls.some(u => u.includes('chart/%5ENDX') && u.includes('interval=1wk')));
    assert.ok(!calls.some(u => u.includes('chart/QQQ')));
  } finally {
    globalThis.fetch = saved;
  }
});

test('GET /api/ohlc rejects unknown series with 400', async () => {
  const { env } = mockD1();
  const res = await worker.fetch(new Request('https://x/api/ohlc?target=qqq&period=weekly&series=bogus'), env, { waitUntil() {} });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.match(body.error, /unknown series/);
});

test('GET /api/ohlc uses a separate cache key for series', async () => {
  const saved = globalThis.fetch;
  let qqqCalls = 0, ndxCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('chart/QQQ')) { qqqCalls++; return jsonResponse(yahooWeeklyFixture()); }
    if (String(url).includes('chart/%5ENDX')) { ndxCalls++; return jsonResponse(yahooWeeklyFixture()); }
    throw new Error('unexpected url ' + url);
  };
  try {
    const { env, store } = mockD1();
    const base = 'https://x/api/ohlc?target=qqq&period=weekly';
    await worker.fetch(new Request(base), env, { waitUntil() {} });
    await worker.fetch(new Request(base), env, { waitUntil() {} });
    await worker.fetch(new Request(base + '&series=ndx'), env, { waitUntil() {} });
    await worker.fetch(new Request(base + '&series=ndx'), env, { waitUntil() {} });
    assert.equal(qqqCalls, 1);
    assert.equal(ndxCalls, 1);
    assert.ok(store.has('daily:ohlc_qqq_weekly'));
    assert.ok(store.has('daily:ohlc_qqq_ndx_weekly'));
  } finally {
    globalThis.fetch = saved;
  }
});

test('GET /api/ohlc weekly uses Tencent fqkline and slices to 52 candles', async () => {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('sh512890,week')) return jsonResponse({ data: { sh512890: { qfqweek: tencentWeeklyRows() } } });
    throw new Error('unexpected url ' + url);
  };
  try {
    const { env } = mockD1();
    const res = await worker.fetch(new Request('https://x/api/ohlc?target=dividend_low_vol_etf&period=weekly'), env, { waitUntil() {} });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.target, 'dividend_low_vol_etf');
    assert.equal(body.period, 'weekly');
    assert.equal(body.candles.length, 52);
    assert.deepEqual(body.candles[0], { date: '2026-11-13', o: 1.21, c: 1.23, h: 1.24, l: 1.2 });
    assert.ok(calls.some(u => u.includes('sh512890,week')));
  } finally {
    globalThis.fetch = saved;
  }
});

test('GET /api/ohlc uses tech_symbol proxy for dividend_low_vol_100', async () => {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    // 兼容腾讯返回键名 week（非 qfqweek）
    if (String(url).includes('sh563020,week')) return jsonResponse({ data: { sh563020: { week: tencentWeeklyRows() } } });
    throw new Error('unexpected url ' + url);
  };
  try {
    const { env } = mockD1();
    const res = await worker.fetch(new Request('https://x/api/ohlc?target=dividend_low_vol_100&period=weekly'), env, { waitUntil() {} });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.candles.length, 52);
    assert.ok(calls.some(u => u.includes('sh563020')));
    assert.ok(!calls.some(u => u.includes('930955')));
  } finally {
    globalThis.fetch = saved;
  }
});

test('GET /api/ohlc monthly uses Yahoo interval=1mo and slices to 60 candles', async () => {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('chart/QQQ') && String(url).includes('interval=1mo')) return jsonResponse(yahooMonthlyFixture());
    throw new Error('unexpected url ' + url);
  };
  try {
    const { env } = mockD1();
    const res = await worker.fetch(new Request('https://x/api/ohlc?target=qqq&period=monthly'), env, { waitUntil() {} });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.candles.length, 60);
    assert.deepEqual(body.candles[0], { date: '2021-11-01', o: 11, c: 11.5, h: 12, l: 10.5 });
    assert.deepEqual(body.candles[59], { date: '2026-10-01', o: 70, c: 70.5, h: 71, l: 69.5 });
    assert.ok(calls.some(u => u.includes('chart/QQQ') && u.includes('interval=1mo')));
  } finally {
    globalThis.fetch = saved;
  }
});

test('GET /api/ohlc rejects invalid target and period with 400', async () => {
  const { env } = mockD1();
  const badTarget = await worker.fetch(new Request('https://x/api/ohlc?target=bogus&period=weekly'), env, { waitUntil() {} });
  assert.equal(badTarget.status, 400);
  const b1 = await badTarget.json();
  assert.equal(b1.success, false);

  const badPeriod = await worker.fetch(new Request('https://x/api/ohlc?target=qqq&period=daily'), env, { waitUntil() {} });
  assert.equal(badPeriod.status, 400);
  const b2 = await badPeriod.json();
  assert.equal(b2.success, false);
});

test('GET /api/ohlc serves second call from D1 cache without fetching', async () => {
  const saved = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('sh512890,week')) { fetchCount++; return jsonResponse({ data: { sh512890: { qfqweek: tencentWeeklyRows() } } }); }
    throw new Error('unexpected url ' + url);
  };
  try {
    const { env } = mockD1();
    const r1 = await worker.fetch(new Request('https://x/api/ohlc?target=dividend_low_vol_etf&period=weekly'), env, { waitUntil() {} });
    const r2 = await worker.fetch(new Request('https://x/api/ohlc?target=dividend_low_vol_etf&period=weekly'), env, { waitUntil() {} });
    assert.equal((await r1.json()).candles.length, 52);
    assert.equal((await r2.json()).candles.length, 52);
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = saved;
  }
});
