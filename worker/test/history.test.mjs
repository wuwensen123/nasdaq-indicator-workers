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
