/**
 * 分析引擎 — 计算综合评分和投资策略
 */

export class Analyzer {
  constructor() {
    this.targets = [
      { id: 'qqq', name: 'QQQ 纳斯达克100 ETF', symbol: 'QQQ', type: '美国ETF', indicators: ['vix', 'pe_qqq', 'fear_greed', 'rsi', 'put_call', 'yield_10y', 'dxy', 'ma200'],
        weights: { vix: 0.20, pe_qqq: 0.20, fear_greed: 0.15, rsi: 0.15, put_call: 0.10, yield_10y: 0.10, dxy: 0.05, ma200: 0.05 }, pe_normal: 25 },
      { id: 'voo', name: 'VOO 标普500 ETF', symbol: 'VOO', type: '美国ETF', indicators: ['vix', 'pe_sp500', 'fear_greed', 'rsi', 'put_call', 'yield_10y', 'dxy', 'ma200'],
        weights: { vix: 0.20, pe_sp500: 0.20, fear_greed: 0.15, rsi: 0.15, put_call: 0.10, yield_10y: 0.10, dxy: 0.05, ma200: 0.05 }, pe_normal: 22 },
      { id: 'gld', name: '黄金 GLD ETF', symbol: 'GLD', type: '商品ETF', indicators: ['rsi', 'dxy', 'yield_10y', 'ma200', 'vix', 'fear_greed'],
        weights: { rsi: 0.20, dxy: 0.25, yield_10y: 0.20, ma200: 0.15, vix: 0.10, fear_greed: 0.10 }, pe_normal: null },
      { id: 'hsi', name: '恒生指数', symbol: '^HSI', type: '香港指数', indicators: ['pe_hsi', 'rsi', 'fear_greed', 'ma200', 'vix', 'dxy'],
        weights: { pe_hsi: 0.25, rsi: 0.20, fear_greed: 0.15, ma200: 0.15, vix: 0.15, dxy: 0.10 }, pe_normal: 12 },
    ];
  }

  getTargets() { return this.targets; }

  analyzeTarget(targetId, data, global) {
    const cfg = this.targets.find(t => t.id === targetId);
    if (!cfg) return null;
    const td = data[targetId] || {};

    let weightedSum = 0, totalWeight = 0;
    const indicators = [];

    for (const ind of cfg.indicators) {
      const r = this._score(ind, td, global, cfg);
      indicators.push(r);
      if (r.score != null) { weightedSum += r.score * r.weight; totalWeight += r.weight; }
    }

    const composite = totalWeight > 0 ? round(weightedSum / totalWeight) : null;
    const pos = this._marketPosition(composite);
    const strategy = this._strategy(composite);

    return {
      target_id: targetId, target_name: cfg.name, target_type: cfg.type, symbol: cfg.symbol,
      current_price: td.current_price, composite_score: composite, market_position: pos.label,
      position_color: pos.color, strategy, indicators,
      formula: `综合评分 = ${cfg.indicators.map(i => `${this._indName(i)}×${cfg.weights[i]*100}%`).join(' + ')}`,
      formula_detail: '0=强烈买入 → 100=强烈卖出，每项指标归一化到0-100分后加权平均',
    };
  }

  _score(ind, td, g, cfg) {
    const w = cfg.weights[ind] || 0;
    const base = { score: null, label: 'N/A', value: null, weight: w, unit: '' };
    const norm = this[`_${ind}`] || (() => ({}));

    const globalIndicators = {
      'vix': () => { const v = g.vix?.value; const s = normVIX(v); return { ...s, value: v }; },
      'fear_greed': () => { const v = g.fear_greed?.value; const s = normFG(v); return { ...s, value: v }; },
      'put_call': () => { const v = g.put_call_ratio?.value; const s = normPC(v); return { ...s, value: v }; },
      'yield_10y': () => { const v = g.treasury_10y?.value; const s = normYield(v); return { ...s, value: v, unit: '%' }; },
      'dxy': () => { const v = g.dxy?.value; const s = normDXY(v); return { ...s, value: v }; },
      'pe_qqq': () => { const v = td.pe_ratio ?? g.shiller_pe?.value; const s = normPE(v, cfg.pe_normal || 25); return { ...s, value: v }; },
      'pe_sp500': () => { const v = td.pe_ratio ?? g.shiller_pe?.value; const s = normPE(v, cfg.pe_normal || 22); return { ...s, value: v }; },
      'pe_hsi': () => { const v = td.pe_ratio; const s = normPE_HSI(v); return { ...s, value: v }; },
    };

    if (globalIndicators[ind]) return { ...base, ...globalIndicators[ind]() };

    if (['rsi', 'ma200'].includes(ind)) {
      const tech = td.technical || {};
      if (ind === 'rsi') { const v = tech.rsi; const s = normRSI(v); return { ...base, ...s, value: v }; }
      if (ind === 'ma200') { const v = tech.ma200_pct; const s = normMA200(v); return { ...base, ...s, value: v, unit: '%' }; }
    }
    return base;
  }

  _marketPosition(s) {
    if (s == null) return { label: '数据不足', color: '#6c757d' };
    if (s <= 20) return { label: '历史低位', color: '#dc3545' };
    if (s <= 40) return { label: '低位区域', color: '#fd7e14' };
    if (s <= 60) return { label: '正常区间', color: '#28a745' };
    if (s <= 80) return { label: '高位区域', color: '#ffc107' };
    return { label: '历史高位', color: '#dc3545' };
  }

  _strategy(s) {
    if (s == null) return { action: '等待数据', multiple: 0, description: '数据不足，请稍后刷新', color: '#6c757d', icon: '⏳' };
    if (s <= 10) return { action: 'ALL IN', multiple: 999, description: '市场极度低迷，历史性买入机会！', color: '#dc3545', icon: '🚀' };
    if (s <= 25) return { action: '3倍定投', multiple: 3, description: '市场明显低估，建议加大定投金额至3倍', color: '#fd7e14', icon: '📈' };
    if (s <= 40) return { action: '2倍定投', multiple: 2, description: '市场偏低估，建议增加定投金额至2倍', color: '#ffc107', icon: '📊' };
    if (s <= 60) return { action: '1倍定投', multiple: 1, description: '市场估值正常，建议维持正常定投金额', color: '#28a745', icon: '✅' };
    if (s <= 75) return { action: '0.5倍定投', multiple: 0.5, description: '市场偏贵，建议减少定投金额至0.5倍', color: '#ffc107', icon: '⚠️' };
    if (s <= 90) return { action: '暂停定投', multiple: 0, description: '市场明显高估，建议暂停定投', color: '#fd7e14', icon: '🛑' };
    return { action: '减仓/卖出', multiple: -1, description: '市场极度高估，建议分批减仓', color: '#dc3545', icon: '🔴' };
  }

  _indName(k) {
    const names = {
      vix: 'VIX波动率', fear_greed: '恐惧与贪婪指数', put_call: '看跌/看涨比率',
      yield_10y: '10年期国债收益率', dxy: '美元指数DXY',
      pe_qqq: '纳斯达克100市盈率', pe_sp500: '标普500市盈率', pe_hsi: '恒生指数市盈率',
      rsi: 'RSI(14)', ma200: '200日均线偏离度',
    };
    return names[k] || k;
  }
}

// ========== 归一化函数 ==========
function normVIX(v) {
  if (v == null) return { score: null, label: 'N/A' };
  if (v < 12) return { score: cap(90 + (12 - v) * 3.33), label: '极低波动' };
  if (v < 15) return { score: cap(70 + (15 - v) * 6.67), label: '低波动' };
  if (v < 20) return { score: cap(50 + (20 - v) * 4), label: '正常偏低' };
  if (v < 25) return { score: cap(25 + (25 - v) * 5), label: '正常偏高' };
  if (v < 30) return { score: cap(10 + (30 - v) * 3), label: '高波动' };
  return { score: cap(10 - (v - 30) * 1), label: '极高波动(恐慌)' };
}

function normPE(v, n) {
  if (v == null || n == null) return { score: null, label: 'N/A' };
  if (v < n * 0.6) return { score: 0, label: '严重低估' };
  if (v < n * 0.8) return { score: cap((v - n * 0.6) / (n * 0.2) * 20), label: '低估' };
  if (v < n * 1.0) return { score: cap(20 + (v - n * 0.8) / (n * 0.2) * 30), label: '正常偏低' };
  if (v < n * 1.2) return { score: cap(50 + (v - n) / (n * 0.2) * 25), label: '正常偏高' };
  if (v < n * 1.5) return { score: cap(75 + (v - n * 1.2) / (n * 0.3) * 15), label: '高估' };
  return { score: cap(90 + Math.min(10, (v - n * 1.5) / (n * 0.5) * 10)), label: '严重高估' };
}

function normPE_HSI(v) {
  if (v == null) return { score: null, label: 'N/A' };
  if (v < 8) return { score: 0, label: '历史低位' };
  if (v < 10) return { score: cap((v - 8) / 2 * 25), label: '偏低' };
  if (v < 12) return { score: cap(25 + (v - 10) / 2 * 25), label: '正常偏低' };
  if (v < 14) return { score: cap(50 + (v - 12) / 2 * 20), label: '正常' };
  if (v < 16) return { score: cap(70 + (v - 14) / 2 * 15), label: '偏高' };
  return { score: cap(85 + Math.min(15, (v - 16) / 5 * 15)), label: '历史高位' };
}

function normFG(v) {
  if (v == null) return { score: null, label: 'N/A' };
  return { score: cap(v), label: v <= 25 ? '极度恐惧' : v <= 40 ? '恐惧' : v <= 60 ? '中性' : v <= 75 ? '贪婪' : '极度贪婪' };
}

function normRSI(v) {
  if (v == null) return { score: null, label: 'N/A' };
  if (v < 20) return { score: 0, label: '严重超卖' };
  if (v < 30) return { score: cap((v - 20) / 10 * 15), label: '超卖' };
  if (v < 40) return { score: cap(15 + (v - 30) / 10 * 15), label: '偏弱' };
  if (v < 50) return { score: cap(30 + (v - 40) / 10 * 20), label: '中性偏弱' };
  if (v < 60) return { score: cap(50 + (v - 50) / 10 * 20), label: '中性偏强' };
  if (v < 70) return { score: cap(70 + (v - 60) / 10 * 15), label: '偏强' };
  if (v < 80) return { score: cap(85 + (v - 70) / 10 * 15), label: '超买' };
  return { score: 100, label: '严重超买' };
}

function normPC(v) {
  if (v == null) return { score: null, label: 'N/A' };
  if (v < 0.5) return { score: 90, label: '极度乐观' };
  if (v < 0.6) return { score: cap(80 + (0.6 - v) * 100), label: '过度乐观' };
  if (v < 0.7) return { score: cap(70 + (0.7 - v) * 100), label: '乐观' };
  if (v < 0.85) return { score: cap(50 + (0.85 - v) * 133), label: '中性偏乐观' };
  if (v < 1.0) return { score: cap(30 + (1.0 - v) * 133), label: '中性偏悲观' };
  if (v < 1.2) return { score: cap(15 + (1.2 - v) * 75), label: '悲观' };
  return { score: cap(15 - (v - 1.2) * 25), label: '极度悲观' };
}

function normYield(v) {
  if (v == null) return { score: null, label: 'N/A' };
  if (v < 2.0) return { score: 10, label: '低利率环境' };
  if (v < 3.0) return { score: cap(10 + (v - 2.0) * 20), label: '正常偏低' };
  if (v < 4.0) return { score: cap(30 + (v - 3.0) * 20), label: '正常' };
  if (v < 5.0) return { score: cap(50 + (v - 4.0) * 20), label: '偏高' };
  if (v < 6.0) return { score: cap(70 + (v - 5.0) * 15), label: '高利率' };
  return { score: cap(85 + Math.min(15, (v - 6.0) * 10)), label: '极高利率' };
}

function normDXY(v) {
  if (v == null) return { score: null, label: 'N/A' };
  if (v < 90) return { score: 20, label: '美元弱势' };
  if (v < 95) return { score: cap(20 + (v - 90) / 5 * 20), label: '美元偏弱' };
  if (v < 100) return { score: cap(40 + (v - 95) / 5 * 20), label: '美元中性' };
  if (v < 105) return { score: cap(60 + (v - 100) / 5 * 20), label: '美元偏强' };
  if (v < 110) return { score: cap(80 + (v - 105) / 5 * 15), label: '美元强势' };
  return { score: cap(95 + Math.min(5, (v - 110) / 5 * 5)), label: '美元极强' };
}

function normMA200(v) {
  if (v == null) return { score: null, label: 'N/A' };
  if (v < -20) return { score: 0, label: '严重低于均线' };
  if (v < -10) return { score: cap((v + 20) / 10 * 10), label: '大幅低于均线' };
  if (v < -5) return { score: cap(10 + (v + 10) / 5 * 15), label: '低于均线' };
  if (v < 0) return { score: cap(25 + (v + 5) / 5 * 25), label: '略低于均线' };
  if (v < 5) return { score: cap(50 + v / 5 * 20), label: '略高于均线' };
  if (v < 10) return { score: cap(70 + (v - 5) / 5 * 15), label: '高于均线' };
  if (v < 20) return { score: cap(85 + (v - 10) / 10 * 10), label: '大幅高于均线' };
  return { score: cap(95 + Math.min(5, (v - 20) / 10 * 5)), label: '严重高于均线' };
}

function round(v, d = 2) { return v != null ? parseFloat(v.toFixed(d)) : null; }
function cap(v) { return Math.max(0, Math.min(100, round(v))); }