import test from 'node:test';
import assert from 'node:assert/strict';
import { Analyzer } from '../src/analyzer.js';

test('tactical signals: fear + VIX backwardation stack, capped at 1.5', () => {
  const a = new Analyzer();
  const r = a._tacticalSignals({
    fear_greed: { value: 20 },
    vix: { value: 30 },
    vix3m: { value: 22 },
    put_call_ratio: { value: 1.2 },
  });
  assert.equal(r.coeff, 1.4375);
  assert.match(r.reason, /恐惧/);
  assert.match(r.reason, /VIX/);
});

test('tactical signals: no extreme returns coeff 1', () => {
  const a = new Analyzer();
  const r = a._tacticalSignals({
    fear_greed: { value: 33 },
    vix: { value: 19.5 },
    vix3m: { value: 20.5 },
    put_call_ratio: { value: 1.1 },
  });
  assert.equal(r.coeff, 1);
  assert.equal(r.vix_ratio, 0.95);
  assert.equal(r.reason, null);
});

test('tactical signals: missing VIX3M does not produce Infinity', () => {
  const a = new Analyzer();
  const r = a._tacticalSignals({ fear_greed: { value: 50 }, vix: { value: 20 }, vix3m: { value: null } });
  assert.equal(r.vix_ratio, null);
  assert.equal(r.coeff, 1);
});

test('forward PE scores against its own forward-PE anchor table', () => {
  const a = new Analyzer();
  const qqq = a.targets.find(t => t.id === 'qqq');
  const forward = a._strategicScore('forward_pe', qqq, { forward_pe: 25 }, {});
  assert.equal(forward.value, 25);
  assert.ok(forward.score > 0 && forward.score < 100);
});

test('EY spread vs Baa: -1.2% is expensive, +3% is cheap', () => {
  const a = new Analyzer();
  const qqq = a.targets.find(t => t.id === 'qqq');
  const expensive = a._strategicScore('ey_spread_baa', qqq, { forward_pe: 25 }, { baa_yield: { value: 5.2 } });
  assert.equal(expensive.value, -1.2);
  assert.ok(expensive.score > 65);
  assert.ok(a._eySpreadBaaScore(3) < 15);
});

test('QQQ/VOO configs include forward_pe and ey_spread_baa with weights summing to 1', () => {
  const a = new Analyzer();
  for (const id of ['qqq', 'voo']) {
    const t = a.targets.find(x => x.id === id);
    assert.ok(t.indicators.includes('forward_pe'));
    assert.ok(t.indicators.includes('ey_spread_baa'));
    const sum = t.indicators.reduce((s, k) => s + t.weights[k], 0);
    assert.equal(Math.round(sum * 100), 100);
  }
});

test('coverage below 90% forces 1x and adds a warning', () => {
  const a = new Analyzer();
  const base = { multiple: 1.5, action: '1.5倍定投', description: '综合评分38≤40', color: '#ffc107', icon: '📊' };
  const capped = a._capForCoverage(base, 0.8);
  assert.equal(capped.multiple, 1);
  assert.equal(capped.action, '1倍定投');
  assert.match(capped.description, /80%/);
  assert.equal(a._capForCoverage(base, 0.95).multiple, 1.5);
});

test('QQQ strategic result includes tactical block and new indicators', () => {
  const a = new Analyzer();
  const global = {
    fear_greed: { value: 33.37 }, vix: { value: 19.46 }, vix3m: { value: 20.5 },
    put_call_ratio: { value: 1.1 }, baa_yield: { value: 5.2 }, shiller_pe: { value: 39.7 },
    real_yield_10y: { value: 2.78 }, treasury_10y: { value: 4.98 },
  };
  const data = {
    qqq: {
      pe_ratio: 27.79, forward_pe: 25.5,
      pe_data: { source: 'Yahoo Finance', updated_at: '2026-11-11T07:30:00.000Z' },
      technical: { ma200_pct: -0.98, pct_from_52w_high: -2 },
    },
  };
  const r = a.analyzeTarget('qqq', data, global);
  assert.ok(r.tactical);
  assert.equal(r.tactical.coeff, 1);
  assert.ok(r.indicators.some(i => i.name === 'Forward P/E'));
  assert.ok(r.indicators.some(i => i.name === 'EY spread vs Baa'));
  assert.ok(r.indicators.find(i => i.name === 'Forward P/E').source.startsWith('Yahoo Finance'));
  assert.equal(typeof r.composite_score, 'number');
});

test('bank pb_pct_hist prefers per-stock percentile over index-wide', () => {
  const a = new Analyzer();
  const global = { danjuan: { map: { '中证银行': { pb: 0.9, pb_pct: 0.72 } }, source: 'danjuan' } };
  const data = {
    abc_bank: {
      pb: 0.88,
      pb_data: { source: '腾讯' },
      pb_pct_hist: { pct: 0.087, current_pb: 0.88, count: 2160, median: 1.02, source: '东方财富估值分析(RPT_VALUEANALYSIS_DET,2018至今)', updated_at: '2026-11-12T07:30:00Z' },
      technical: { ma200_pct: 7.45 },
    },
  };
  const r = a.analyzeTarget('abc_bank', data, global);
  const ind = r.indicators.find(i => i.name === 'PB历史分位');
  assert.equal(ind.score, 8.7); // 0.087*100
  assert.ok(ind.source.includes('东方财富') && ind.source.includes('2018'), ind.source);
});

test('bank pb_pct_hist falls back to index percentile when per-stock missing', () => {
  const a = new Analyzer();
  const global = { danjuan: { map: { '中证银行': { pb: 0.9, pb_pct: 72 } }, source: 'danjuan' } };
  const data = { abc_bank: { pb: 0.88, technical: { ma200_pct: 7.45 } } };
  const r = a.analyzeTarget('abc_bank', data, global);
  const ind = r.indicators.find(i => i.name === 'PB历史分位');
  assert.equal(ind.score, 72);
  // fallback 无个股数据时用指数分位（韭圈儿/蛋卷），score 仍为 0-100
});

test('forward_pe uses dynamic history percentile when series present', () => {
  const a = new Analyzer();
  const series = Array.from({ length: 100 }, (_, i) => ({ date: `20${String(i).padStart(2, '0')}-01-01`, value: 10 + i * 0.2 })); // 10..29.8
  const global = { fwd_pe_hist: { ndx: { series, source: 'historyofmarket.com', updated_at: '2026-11-12T00:00:00Z' } } };
  const data = { qqq: { pe_ratio: 28, forward_pe: 25.5, pe_data: { source: 'Yahoo Finance', updated_at: '2026-11-11T07:30:00.000Z' } } };
  const r = a.analyzeTarget('qqq', data, global);
  const ind = r.indicators.find(i => i.name === 'Forward P/E');
  assert.ok(Math.abs(ind.score - 77.5) < 1.5, `score=${ind.score}`); // 25.5 在 10..29.8 ≈ 77.5 分位
  assert.ok(ind.source.includes('historyofmarket'), ind.source);
});
