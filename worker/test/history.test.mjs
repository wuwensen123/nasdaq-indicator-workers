import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { saveScoreHistory } from '../src/index.js';

function mockD1({ historyRows = [] } = {}) {
  const written = [];
  const env = {
    nasdaq_cache: {
      prepare: (sql) => {
        const stmt = {
          sql,
          bind: (...args) => {
            written.push({ sql, args });
            return { ...stmt, args };
          },
          run: async () => ({}),
          all: async () => ({ results: historyRows }),
          first: async () => null,
        };
        return stmt;
      },
      batch: async (stmts) => stmts.map(() => ({})),
    },
  };
  return { env, written };
}

const sampleData = {
  analysis: {
    results: [
      {
        target_id: 'qqq', composite_score: 64.17, strategy: { multiple: 1 },
        indicators: [{ name: 'PE综合估值', value: 28.44, score: 68.22 }, { name: 'CAPE周期调整市盈率', value: 40.24, score: 98.8 }],
      },
      { target_id: 'voo', composite_score: 74.89, strategy: { multiple: 1 }, indicators: [] },
    ],
  },
};

test('saveScoreHistory writes one row per target with INSERT OR REPLACE', async () => {
  const { env, written } = mockD1();
  await saveScoreHistory(env, sampleData, '2026-11-12');
  const inserts = written.filter(w => w.sql.includes('INSERT OR REPLACE INTO score_history'));
  assert.equal(inserts.length, 2);
  assert.equal(inserts[0].args[0], 'qqq');
  assert.equal(inserts[0].args[1], '2026-11-12');
  assert.equal(inserts[0].args[2], 64.17);
  assert.equal(inserts[0].args[3], 1);
  const parsed = JSON.parse(inserts[0].args[4]);
  assert.equal(parsed['PE综合估值'].s, 68.22);
});

test('saveScoreHistory merges global sentiment into indicators JSON', async () => {
  const { env, written } = mockD1();
  const data = {
    analysis: {
      results: [{
        target_id: 'hsi', composite_score: null, strategy: { multiple: 0 },
        indicators: [{ name: '200日趋势风控', value: -4.86, score: 54.58 }],
        sentiment: { vix: 19.1, vix3m: 19.3, vix_ratio: 0.99, fear_greed: 36.6, put_call: 0.868 },
      }],
    },
  };
  await saveScoreHistory(env, data, '2026-11-12');
  const ins = written.find(w => w.sql.includes('INSERT OR REPLACE INTO score_history'));
  const parsed = JSON.parse(ins.args[4]);
  assert.equal(parsed['VIX波动率'].v, 19.1);
  assert.equal(parsed['VIX/VIX3M'].v, 0.99);
  assert.equal(parsed['恐惧与贪婪指数'].v, 36.6);
  assert.equal(parsed['看跌/看涨期权比率'].v, 0.868);
  assert.equal(parsed['VIX波动率'].s, null);
  assert.equal(parsed['200日趋势风控'].s, 54.58);
});

test('saveScoreHistory skips sentiment fields that are null', async () => {
  const { env, written } = mockD1();
  const data = {
    analysis: {
      results: [{
        target_id: 'qqq', composite_score: 62, strategy: { multiple: 1 },
        indicators: [], sentiment: { vix: 19.1, vix3m: null, vix_ratio: null, fear_greed: null, put_call: null },
      }],
    },
  };
  await saveScoreHistory(env, data, '2026-11-12');
  const parsed = JSON.parse(written.find(w => w.sql.includes('INSERT')).args[4]);
  assert.deepEqual(Object.keys(parsed), ['VIX波动率']);
});

test('saveScoreHistory skips empty results', async () => {
  const { env, written } = mockD1();
  await saveScoreHistory(env, { analysis: { results: [] } }, '2026-11-12');
  assert.equal(written.filter(w => w.sql.includes('INSERT') || w.sql.includes('DELETE')).length, 0);
});

test('GET /api/history groups rows by target', async () => {
  const { env } = mockD1({
    historyRows: [
      { target_id: 'qqq', date: '2026-11-10', composite_score: 63.5, multiple: 1 },
      { target_id: 'qqq', date: '2026-11-11', composite_score: 64.1, multiple: 1 },
      { target_id: 'voo', date: '2026-11-11', composite_score: 74.2, multiple: 1 },
    ],
  });
  const res = await worker.fetch(new Request('https://x/api/history?days=90'), env, { waitUntil() {} });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.history.qqq.series.length, 2);
  assert.equal(body.history.qqq.series[1].score, 64.1);
  assert.deepEqual(body.history.qqq.indicators, {});
  assert.equal(body.history.voo.series.length, 1);
});

test('GET /api/history returns per-indicator series with value and score', async () => {
  const { env } = mockD1({
    historyRows: [
      {
        target_id: 'qqq', date: '2026-11-10', composite_score: 63.5, multiple: 1,
        indicators: JSON.stringify({ 'PE综合估值': { v: 28.1, s: 66 }, 'CAPE周期调整市盈率': { v: 40.0, s: 98 } }),
      },
      {
        target_id: 'qqq', date: '2026-11-11', composite_score: 64.1, multiple: 1,
        indicators: JSON.stringify({ 'PE综合估值': { v: 28.4, s: 68 }, 'CAPE周期调整市盈率': { v: 40.2, s: 98 } }),
      },
      // 坏 JSON 行不影响其它行
      { target_id: 'voo', date: '2026-11-11', composite_score: 74.2, multiple: 1, indicators: '{{{not-json' },
    ],
  });
  const res = await worker.fetch(new Request('https://x/api/history?days=90'), env, { waitUntil() {} });
  const body = await res.json();
  const pe = body.history.qqq.indicators['PE综合估值'];
  assert.equal(pe.length, 2);
  assert.deepEqual(pe[1], { date: '2026-11-11', v: 28.4, s: 68 });
  assert.equal(body.history.qqq.indicators['CAPE周期调整市盈率'].length, 2);
  assert.deepEqual(body.history.voo.indicators, {});
});

test('GET /api/history returns indicator_meta with direction and desc', async () => {
  const { env } = mockD1({
    historyRows: [
      {
        target_id: 'qqq', date: '2026-11-11', composite_score: 64.1, multiple: 1,
        indicators: JSON.stringify({ 'PE综合估值': { v: 28.4, s: 68 }, 'VIX波动率': { v: 19.1, s: null } }),
      },
    ],
  });
  const res = await worker.fetch(new Request('https://x/api/history?days=90'), env, { waitUntil() {} });
  const body = await res.json();
  assert.equal(body.indicator_meta['PE综合估值'].direction, 'low');
  assert.ok(body.indicator_meta['PE综合估值'].desc.includes('便宜'));
  assert.equal(body.indicator_meta['VIX波动率'].direction, 'low');
  assert.equal(body.indicator_meta['实际股权风险溢价'].direction, 'high'); // 未出现的指标也应在元数据表内
  assert.equal(body.indicator_meta['派息率可持续性'].direction, 'mid');
});

test('GET /api/history returns empty object when table missing', async () => {
  const env = {
    nasdaq_cache: {
      prepare: (sql) => ({
        bind: () => ({ all: async () => { throw new Error('no such table: score_history'); } }),
        run: async () => ({}),
        all: async () => { throw new Error('no such table: score_history'); },
        first: async () => null,
      }),
    },
  };
  const res = await worker.fetch(new Request('https://x/api/history'), env, { waitUntil() {} });
  const body = await res.json();
  assert.equal(body.success, true);
  assert.deepEqual(body.history, {});
});
