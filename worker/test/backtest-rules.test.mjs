import test from 'node:test';
import assert from 'node:assert/strict';
import { asOf, pctRankUpTo, accelMultiple, computeXirr, runDcaBacktest } from '../scripts/backtest-accel-rules.mjs';

test('asOf picks latest point on or before date (no future data)', () => {
  const series = [
    { date: '2026-11-03', value: 1 },
    { date: '2026-11-10', value: 2 },
    { date: '2026-11-17', value: 3 },
  ];
  assert.equal(asOf(series, '2026-11-10'), 2);
  assert.equal(asOf(series, '2026-11-12'), 2); // 用上周值，不偷看 11-17
  assert.equal(asOf(series, '2026-11-01'), null);
});

test('pctRankUpTo only uses history up to the target date', () => {
  const series = [
    { date: '2026-01-01', value: 10 },
    { date: '2026-01-08', value: 20 },
    { date: '2026-01-15', value: 30 },
    { date: '2026-01-22', value: 5 },  // 未来点，不得影响 01-15 的分位
    { date: '2026-01-29', value: 5 },
  ];
  // 截至 01-15，序列 [10,20,30]，当前 20 → ≤20 有 2 个 → 2/3
  const p = pctRankUpTo(series, '2026-01-15', 20);
  assert.ok(Math.abs(p - 2 / 3) < 1e-9, `pct=${p}`);
});

test('accelMultiple matches production rules', () => {
  // 生产规则：PE分位≤15→3x，≤25→2x，≤40→1.5x；回撤≤-35→3x，≤-25→2x，≤-15→1.5x；rich 时回撤不加速
  assert.equal(accelMultiple({ pePct: 10 }), 3);
  assert.equal(accelMultiple({ pePct: 20 }), 2);
  assert.equal(accelMultiple({ pePct: 35 }), 1.5);
  assert.equal(accelMultiple({ pePct: 60 }), 1);
  assert.equal(accelMultiple({ pePct: 60, dd: -20 }), 1.5);
  assert.equal(accelMultiple({ pePct: 60, dd: -30 }), 2);
  assert.equal(accelMultiple({ pePct: 60, dd: -40 }), 3);
  assert.equal(accelMultiple({ pePct: 90, dd: -30, rich: true }), 1); // 估值高位时回撤不加速
  assert.equal(accelMultiple({ pePct: 20, dd: -30 }), 2); // 取最大
});

test('computeXirr solves a simple one-year case', () => {
  // 今天投入 100，一年后值 110 → XIRR ≈ 10%
  const flows = [
    { date: '2025-11-12', amount: -100 },
    { date: '2026-11-12', amount: 110 },
  ];
  const r = computeXirr(flows);
  assert.ok(Math.abs(r - 0.1) < 0.005, `xirr=${r}`);
});

test('runDcaBacktest converts rank (0-1) to percent before applying thresholds', () => {
  // 回归测试：rank 是 0-1 小数，必须 ×100 再与 15/25/40 阈值比较。
  // 若直接传小数，0.33 <= 15 恒真 → 全部 3x（曾出现过的 bug）。
  const prices = [
    { date: '2025-01-02', close: 100 },
    { date: '2025-01-31', close: 100 },
    { date: '2025-02-03', close: 100 },
    { date: '2025-02-28', close: 100 },
    { date: '2025-03-03', close: 100 },
    { date: '2025-03-31', close: 100 },
  ];
  const peSeries = [
    { date: '2024-10-04', value: 10 },
    { date: '2024-10-11', value: 30 },
    { date: '2024-10-18', value: 40 },
    { date: '2024-10-25', value: 50 },
    { date: '2025-01-01', value: 20 }, // 01-02: [10,20,30,40,50] 中 20 → 2/5=40% → 1.5x
    { date: '2025-02-01', value: 45 }, // 02-03: 45/50 以下共 5 个 → 5/6≈83% → 1x
    { date: '2025-03-01', value: 5 },  // 03-03: 等于最小值 → 0% → 3x
  ];
  const r = runDcaBacktest({ prices, peSeries, start: '2025-01-01', end: '2025-03-31', strategy: 'score' });
  assert.deepEqual(r.triggerCounts, { 1.5: 1, 1: 1, 3: 1 });
  assert.equal(r.totalInvested, 5.5);
});
