/**
 * 分析引擎 — 计算综合评分和投资策略
 */

// ========== 历史分位锚点表（Phase 1 固定参照，Phase 3 换 D1 真分位） ==========
// NDX trailing PE：历史区间 10.27-38.26，长期均值 25.71（GuruFocus 口径）
const PE_PCT_NDX = [[10, 0], [15, 8], [20, 28], [25, 50], [27.7, 65], [30, 75], [33, 85], [36, 93], [38.5, 99]];
// SPX trailing PE：长期均值 ~16，2026 高位区
const PE_PCT_SPX = [[10, 1], [12, 6], [14, 18], [15.5, 35], [17, 55], [19, 70], [21, 82], [23, 90], [25, 94], [28, 97], [32, 99]];
// S&P CAPE：中位 ~17.5，2000 峰值 44.2，2021 峰值 38.6（multpl 口径）
const CAPE_PCT = [[10, 1], [13, 8], [15, 20], [17.5, 48], [20, 62], [25, 78], [30, 90], [35, 96], [38.6, 98.5], [44, 99.5]];
// 中国10年期国债收益率静态锚点（2026-11 中债10Y约1.61-1.69%，取1.8留保守余量），股债利差用。
// 中债API无免费接口，季度人工校准
const CN10Y_ANCHOR = 1.8;
// A股银行PB历史区间锚点（行业长期0.45-1.4，2025重估后中枢上移）
const BANK_PB_PCT = [[0.45, 2], [0.55, 10], [0.65, 25], [0.75, 40], [0.85, 55], [0.95, 68], [1.05, 78], [1.2, 88], [1.4, 97]];
// 长江电力 PE/PB 历史区间锚点（2014低点PE10倍出头/股息率5%+；近年PE 19-22、PB 3.0-3.3）
const PE_PCT_CDL = [[11, 3], [13, 10], [15, 22], [17, 40], [19, 55], [20, 62], [21, 70], [22, 78], [24, 90], [26, 97]];
const CDL_PB_PCT = [[2.0, 5], [2.4, 15], [2.7, 30], [3.0, 48], [3.2, 60], [3.4, 72], [3.6, 85], [3.9, 95]];
// 紫金矿业 PB 历史区间锚点（周期股PB宽幅2.2-7）
const ZJ_PB_PCT = [[2.2, 5], [2.8, 15], [3.4, 30], [4.0, 48], [4.6, 62], [5.2, 75], [6.0, 88], [7.0, 97]];
// 长江电力股息率静态锚点（2026-11约3.5-3.7%：承诺2026-2030分红率≥70%，EPS约1.45）。
// 东财f186对600900返回坏数据(0.61%)，季度人工校准
const DY_CDL_ANCHOR = 3.6;

export class Analyzer {
  constructor() {
    this.targets = [
      { id: 'qqq', name: 'QQQ 纳斯达克100 ETF', symbol: 'QQQ', type: '美国ETF', strategic: true, pe_family: 'ndx',
        indicators: ['pe_composite', 'cape', 'erp', 'ma200_risk'],
        weights: { pe_composite: 0.45, cape: 0.25, erp: 0.15, ma200_risk: 0.15 }, pe_normal: 25 },
      { id: 'voo', name: 'VOO 标普500 ETF', symbol: 'VOO', type: '美国ETF', strategic: true, pe_family: 'spx',
        indicators: ['pe_composite', 'cape', 'erp', 'ma200_risk'],
        weights: { pe_composite: 0.45, cape: 0.25, erp: 0.15, ma200_risk: 0.15 }, pe_normal: 22 },
      { id: 'gld', name: '黄金 GLD ETF', symbol: 'GLD', type: '商品ETF', strategic: true, tactical_fg: false,
        indicators: ['real_yield', 'gold_real_pct', 'dxy_pct', 'ma200_risk'],
        weights: { real_yield: 0.30, gold_real_pct: 0.25, dxy_pct: 0.20, ma200_risk: 0.25 }, pe_normal: null },
      { id: 'hsi', name: '恒生指数', symbol: '^HSI', type: '香港指数', strategic: true, tactical_fg: false, dj_index: '恒生指数', dy_source: 'danjuan', dy_map: 'hsi',
        indicators: ['pe_pct_hist', 'erp_hk', 'div_yield_level', 'ma200_risk'],
        weights: { pe_pct_hist: 0.30, erp_hk: 0.30, div_yield_level: 0.20, ma200_risk: 0.20 }, pe_normal: 12 },
      { id: 'dividend_low_vol_etf', name: '红利低波ETF(512890)', symbol: '512890.SS', type: '中国ETF', strategic: true, tactical_fg: false, dj_index: '红利低波', dy_source: 'danjuan',
        indicators: ['dy_spread_cn', 'pe_pct_hist', 'pb_pct_hist', 'ma200_risk'],
        weights: { dy_spread_cn: 0.30, pe_pct_hist: 0.25, pb_pct_hist: 0.25, ma200_risk: 0.20 }, pe_normal: null },
      { id: 'dividend_low_vol_100', name: '红利低波100(930955)', symbol: '000300.SS', type: '中国指数', strategic: true, tactical_fg: false, dj_index: '红利低波', dy_source: 'danjuan',
        indicators: ['dy_spread_cn', 'pe_pct_hist', 'pb_pct_hist', 'ma200_risk'],
        weights: { dy_spread_cn: 0.30, pe_pct_hist: 0.25, pb_pct_hist: 0.25, ma200_risk: 0.20 }, pe_normal: null },
      { id: 'abc_bank', name: '农业银行(601288)', symbol: '601288.SS', type: '中国银行股', strategic: true, tactical_fg: false, dj_index: '中证银行', dy_source: 'td',
        indicators: ['dy_spread_cn', 'pb_pct_hist', 'stock_pb', 'ma200_risk'],
        weights: { dy_spread_cn: 0.30, pb_pct_hist: 0.25, stock_pb: 0.25, ma200_risk: 0.20 }, pe_normal: null },
      { id: 'ccb_bank', name: '建设银行(601939)', symbol: '601939.SS', type: '中国银行股', strategic: true, tactical_fg: false, dj_index: '中证银行', dy_source: 'td',
        indicators: ['dy_spread_cn', 'pb_pct_hist', 'stock_pb', 'ma200_risk'],
        weights: { dy_spread_cn: 0.30, pb_pct_hist: 0.25, stock_pb: 0.25, ma200_risk: 0.20 }, pe_normal: null },
      { id: 'yangtze_power', name: '长江电力(600900)', symbol: '600900.SS', type: '中国电力股', strategic: true, tactical_fg: false, dy_source: 'anchor', dy_anchor: DY_CDL_ANCHOR, dy_map: 'cdl', pe_family: 'cdl', pb_family: 'cdl',
        indicators: ['dy_spread_cn', 'pe_composite', 'stock_pb', 'ma200_risk'],
        weights: { dy_spread_cn: 0.35, pe_composite: 0.25, stock_pb: 0.20, ma200_risk: 0.20 }, pe_normal: null },
      { id: 'cmb_bank', name: '招商银行(600036)', symbol: '600036.SS', type: '中国银行股', strategic: true, tactical_fg: false, dj_index: '中证银行', dy_source: 'td',
        indicators: ['dy_spread_cn', 'pb_pct_hist', 'stock_pb', 'ma200_risk'],
        weights: { dy_spread_cn: 0.30, pb_pct_hist: 0.25, stock_pb: 0.25, ma200_risk: 0.20 }, pe_normal: null },
      { id: 'zijin_mining', name: '紫金矿业(601899)', symbol: '601899.SS', type: '中国矿业股', strategic: true, tactical_fg: false, pb_family: 'zj',
        indicators: ['copper_pct', 'gold_real_pct', 'stock_pb', 'ma200_risk'],
        weights: { copper_pct: 0.35, gold_real_pct: 0.15, stock_pb: 0.25, ma200_risk: 0.25 }, pe_normal: null },
    ];
  }

  getTargets() { return this.targets; }

  analyzeTarget(targetId, data, global) {
    const cfg = this.targets.find(t => t.id === targetId);
    if (!cfg) return null;
    const td = data[targetId] || {};
    if (cfg.strategic) return this._analyzeStrategic(cfg, td, global);

    let weightedSum = 0, totalWeight = 0;
    const indicators = [];

    for (const ind of cfg.indicators) {
      const r = this._score(ind, td, global, cfg);
      const ni = this._indInfo(ind);
      r.name = ni.name;
      r.description = ni.desc;
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
      'pe_qqq': () => { const v = td.pe_ratio; const s = normPE(v, cfg.pe_normal || 25); return { ...s, value: v }; },
      'pe_sp500': () => { const v = td.pe_ratio; const s = normPE(v, cfg.pe_normal || 22); return { ...s, value: v }; },
      'pe_hsi': () => { const v = td.pe_ratio; const s = normPE_HSI(v); return { ...s, value: v }; },
      'pe_shanghai': () => { const v = g.cn_market?.shanghai_pe ?? td.pe_ratio; const s = normPE_Shanghai(v); return { ...s, value: v }; },
      'pe_csi300': () => { const v = g.cn_market?.csi300_pe ?? td.pe_ratio; const s = normPE_CSI300(v); return { ...s, value: v }; },
      'pe_stock': () => { const v = td.pe_ratio; const s = normPE_Stock(v); return { ...s, value: v }; },
      'pe_utility': () => { const v = td.pe_ratio; const s = normPE_Utility(v); return { ...s, value: v }; },
      'pe_mining': () => { const v = td.pe_ratio; const s = normPE_Mining(v); return { ...s, value: v }; },
      'dividend_yield': () => { const v = td.dividend_yield; const s = normDividendYield(v); return { ...s, value: v, unit: '%' }; },
    };

    if (globalIndicators[ind]) return { ...base, ...globalIndicators[ind]() };

    if (['rsi', 'ma200'].includes(ind)) {
      const tech = td.technical || {};
      if (ind === 'rsi') { const v = tech.rsi; const s = normRSI(v); return { ...base, ...s, value: v }; }
      if (ind === 'ma200') { const v = tech.ma200_pct; const s = normMA200(v); return { ...base, ...s, value: v, unit: '%' }; }
    }
    return base;
  }

  // ========== 战略×战术双层评分（美国ETF，十年定投导向） ==========
  // 战略层：估值为主（PE综合45% + CAPE25% + ERP15% + MA200风控15%），分数 0=强烈买入 → 100=强烈卖出
  // 战术层：情绪只在极端触发，作为定投节奏乘数（封顶[0.5,1.5]），不进入评分
  // 依据：Vanguard(期初估值是10年收益最好预测器，情绪/技术在10年期≈0)、Faber 10月均线(唯一有百年证据的技术项，角色=回撤风控)
  _analyzeStrategic(cfg, td, global) {
    const w = cfg.weights;
    const indicators = [];
    for (const key of cfg.indicators) {
      const { value, score, unit, family } = this._strategicScore(key, cfg, td, global);
      indicators.push(this._mkInd(key, w[key], value, score, unit || '', family));
    }
    let weightedSum = 0, totalWeight = 0;
    for (const r of indicators) if (r.score != null) { weightedSum += r.score * r.weight; totalWeight += r.weight; }
    const composite = totalWeight > 0 ? round(weightedSum / totalWeight) : null;

    const pos = this._marketPosition(composite);
    const base = this._strategy(composite);
    let coeff = 1, reason = null;
    if (cfg.tactical_fg !== false) {
      ({ coeff, reason } = this._tacticalCoeff(global.fear_greed?.value));
    }
    const strategy = this._applyTactical(base, coeff, reason);

    const fw = (k) => `${this._indName(k)}×${w[k] * 100}%`;
    return {
      target_id: cfg.id, target_name: cfg.name, target_type: cfg.type, symbol: cfg.symbol,
      current_price: td.current_price, composite_score: composite, market_position: pos.label,
      position_color: pos.color, strategy, indicators,
      formula: `战略评分 = ${cfg.indicators.map(fw).join(' + ')}${cfg.tactical_fg !== false ? `｜最终倍数 = 基础倍数 × 情绪系数${coeff !== 1 ? `(${coeff})` : ''}` : '（黄金无情绪叠加：金价趋势已含恐慌定价）'}`,
      formula_detail: `十年定投双层架构：战略层只看基本面代理与趋势（0=强烈买入→100=强烈卖出，估值/分位项分数≈历史分位）；情绪/技术不做评分。依据：Vanguard十年期研究、Faber均线风控`,
    };
  }

  // 各战略指标取值+打分（0=强烈买入 → 100=强烈卖出）
  _strategicScore(key, cfg, td, global) {
    if (key === 'pe_composite') {
      const pe = td.pe_ratio;
      const tbl = cfg.pe_family === 'spx' ? PE_PCT_SPX : cfg.pe_family === 'cdl' ? PE_PCT_CDL : PE_PCT_NDX;
      const score = pe != null ? this._pctFromAnchors(pe, tbl) : null;
      return { value: pe, score: score == null ? null : round(score), family: cfg.pe_family };
    }
    if (key === 'cape') {
      const cape = global.shiller_pe?.value;
      const score = cape != null ? this._pctFromAnchors(cape, CAPE_PCT) : null;
      return { value: cape, score: score == null ? null : round(score) };
    }
    if (key === 'erp') {
      const pe = td.pe_ratio, y10 = global.treasury_10y?.value;
      if (pe == null || y10 == null || pe <= 0) return { value: null, score: null, unit: '%' };
      const v = round(100 / pe - y10, 2);
      return { value: v, score: round(this._erpScore(v)), unit: '%' };
    }
    if (key === 'ma200_risk') {
      const v = td.technical?.ma200_pct;
      return { value: v, score: v != null ? round(this._ma200RiskScore(v)) : null, unit: '%' };
    }
    if (key === 'real_yield') {
      const v = global.real_yield_10y?.value;
      return { value: v, score: v != null ? round(this._realYieldScore(v)) : null, unit: '%' };
    }
    if (key === 'gold_real_pct') {
      const v = global.gold_real_pct?.value;
      return { value: v, score: v };
    }
    if (key === 'dxy_pct') {
      const v = global.dxy_pct?.value;
      return { value: v, score: v };
    }
    if (key === 'pe_pct_hist') {
      const dj = global.danjuan?.map?.[cfg.dj_index];
      return { value: dj?.pe ?? null, score: dj?.pe_pct ?? null };
    }
    if (key === 'stock_pb') {
      // 个股PB绝对水平（按 cfg.pb_family 选锚点表：bank=A股银行 / cdl=长电 / zj=紫金）
      const v = td.pb;
      const tbl = cfg.pb_family === 'cdl' ? CDL_PB_PCT : cfg.pb_family === 'zj' ? ZJ_PB_PCT : BANK_PB_PCT;
      return { value: v, score: v != null ? round(this._pctFromAnchors(v, tbl)) : null };
    }
    if (key === 'copper_pct') {
      const v = global.copper_pct?.value;
      return { value: v, score: v };
    }
    if (key === 'pb_pct_hist') {
      const dj = global.danjuan?.map?.[cfg.dj_index];
      return { value: dj?.pb ?? null, score: dj?.pb_pct ?? null };
    }
    if (key === 'erp_hk') {
      const dj = global.danjuan?.map?.[cfg.dj_index];
      const y10 = global.treasury_10y?.value;
      if (dj?.pe == null || y10 == null || dj.pe <= 0) return { value: null, score: null, unit: '%' };
      const v = round(100 / dj.pe - y10, 2);
      return { value: v, score: round(this._erpScoreHK(v)), unit: '%' };
    }
    if (key === 'div_yield_level') {
      const v = cfg.dy_source === 'danjuan' ? (global.danjuan?.map?.[cfg.dj_index]?.dy ?? null) : (td.dividend_yield ?? null);
      return { value: v, score: v != null ? round(this._divYieldScore(v, cfg.dy_map || 'a_share')) : null, unit: '%' };
    }
    if (key === 'dy_spread_cn') {
      // 股债利差：股息率 − 中国10Y国债（中金红利策略核心标尺；cdl=长电类债息差口径）
      const dy = cfg.dy_source === 'danjuan' ? (global.danjuan?.map?.[cfg.dj_index]?.dy ?? null)
        : cfg.dy_source === 'anchor' ? cfg.dy_anchor
        : (td.dividend_yield ?? null);
      if (dy == null) return { value: null, score: null, unit: '%' };
      const v = round(dy - CN10Y_ANCHOR, 2);
      return { value: v, score: round(this._dySpreadScore(v, cfg.dy_map === 'cdl' ? 'cdl' : 'hongli')), unit: '%' };
    }
    return { value: null, score: null };
  }

  _mkInd(key, weight, value, score, unit, family) {
    const ni = this._indInfo(key);
    const r = { score, label: 'N/A', value, weight, unit, name: ni.name, description: ni.desc };
    if (score != null) r.label = this._strategicLabel(key, score, family);
    return r;
  }

  _strategicLabel(key, score, peFamily) {
    if (key === 'pe_composite') {
      const fam = peFamily === 'spx' ? '标普' : peFamily === 'cdl' ? '长电PE历史' : '纳指100';
      return score < 30 ? `${fam}低估` : score < 55 ? `${fam}合理` : score < 75 ? `${fam}偏高` : score < 90 ? `${fam}高估` : `${fam}严重高估`;
    }
    if (key === 'cape') return score < 30 ? 'CAPE低估' : score < 55 ? 'CAPE合理' : score < 75 ? 'CAPE偏高' : score < 90 ? 'CAPE高估' : 'CAPE历史极值区';
    if (key === 'erp') return score < 30 ? '股票相对债券便宜' : score < 55 ? '股票相对债券中性' : score < 75 ? '股票相对债券偏贵' : '股票相对债券昂贵';
    if (key === 'ma200_risk') return score < 30 ? '趋势完好' : score < 55 ? '略低于均线' : score < 75 ? '跌破均线(不加速)' : '深度水下(回撤风险)';
    if (key === 'real_yield') return score < 30 ? '实际利率低位(利多黄金)' : score < 55 ? '实际利率中性' : score < 75 ? '实际利率偏高(利空黄金)' : '实际利率高位(利空黄金)';
    if (key === 'gold_real_pct') return score < 30 ? '实际金价低估' : score < 55 ? '实际金价合理' : score < 75 ? '实际金价偏高' : score < 90 ? '实际金价高估' : '实际金价历史极值区';
    if (key === 'dxy_pct') return score < 30 ? '美元弱势(利多黄金)' : score < 60 ? '美元中性' : score < 80 ? '美元偏强(利空黄金)' : '美元历史高位(利空黄金)';
    if (key === 'pe_pct_hist') return score < 30 ? 'PE历史低估' : score < 55 ? 'PE历史合理' : score < 75 ? 'PE历史偏高' : score < 90 ? 'PE历史高估' : 'PE历史极值区';
    if (key === 'pb_pct_hist') return score < 30 ? 'PB历史低估' : score < 55 ? 'PB历史合理' : score < 75 ? 'PB历史偏高' : score < 90 ? 'PB历史高估' : 'PB历史极值区';
    if (key === 'erp_hk') return score < 25 ? '港股ERP丰厚(极有吸引力)' : score < 50 ? '港股ERP偏正(有吸引力)' : score < 65 ? '港股ERP中性' : '港股ERP为负(债券占优)';
    if (key === 'copper_pct') return score < 30 ? '铜价低位(周期底部)' : score < 55 ? '铜价中位' : score < 75 ? '铜价偏高' : '铜价历史高位(周期顶部风险)';
    if (key === 'div_yield_level') return score < 30 ? '股息率丰厚' : score < 50 ? '股息率正常偏低' : score < 70 ? '股息率偏低' : '股息率历史低位';
    if (key === 'dy_spread_cn') return score < 25 ? '股债利差丰厚(红利极有吸引力)' : score < 45 ? '股债利差偏正(红利有吸引力)' : score < 65 ? '股债利差中性' : '股债利差偏薄(债券占优)';
    if (key === 'stock_pb') return score < 30 ? 'PB处低位' : score < 55 ? 'PB偏低' : score < 75 ? 'PB中位' : score < 90 ? 'PB偏高' : 'PB历史高位';
    return 'N/A';
  }

  // 分段线性插值：v → 历史分位(0-100)
  _pctFromAnchors(v, anchors) {
    if (v == null) return null;
    if (v <= anchors[0][0]) return anchors[0][1];
    for (let i = 1; i < anchors.length; i++) {
      if (v <= anchors[i][0]) {
        const [x0, y0] = anchors[i - 1], [x1, y1] = anchors[i];
        return y0 + (v - x0) / (x1 - x0) * (y1 - y0);
      }
    }
    return anchors[anchors.length - 1][1];
  }

  // ERP打分：≥+2%→10分 … <−2%→90+（机构口径：ERP越高股票越有吸引力）
  _erpScore(v) {
    if (v >= 2) return 10;
    if (v >= 0) return 10 + (2 - v) / 2 * 35;
    if (v >= -1) return 45 + (0 - v) * 25;
    if (v >= -2) return 70 + (-1 - v) * 20;
    return Math.min(95, 90 + (-2 - v) * 5);
  }

  // 实际利率打分（黄金机会成本）：实际收益率越高 → 持金成本越高 → 高分（利空）
  // 注：2022后央行购金使此链条减弱（PIMCO/RBC/Apollo），故权重30%而非主导
  _realYieldScore(v) {
    if (v <= 0) return 15;
    if (v <= 1) return 15 + v * 20;
    if (v <= 2) return 35 + (v - 1) * 20;
    if (v <= 3) return 55 + (v - 2) * 20;
    return Math.min(90, 75 + (v - 3) * 15);
  }

  // 港股ERP打分（高息市场，ERP中枢高于美股；港币联系汇率 → 无风险利率用美债10Y）
  _erpScoreHK(v) {
    if (v >= 5) return 5;
    if (v >= 3) return 5 + (5 - v) / 2 * 20;
    if (v >= 1) return 25 + (3 - v) / 2 * 25;
    if (v >= 0) return 50 + (1 - v) * 15;
    if (v >= -1) return 65 + (-v) * 15;
    return Math.min(95, 80 + (-1 - v) * 7.5);
  }

  // 股息率水平打分：越高越便宜 → 低分（hsi=恒生区间；a_share=A股区间）
  _divYieldScore(v, market) {
    if (market === 'hsi') {
      if (v >= 4.5) return 15;
      if (v >= 4) return 15 + (4.5 - v) / 0.5 * 15;
      if (v >= 3.5) return 30 + (4 - v) / 0.5 * 15;
      if (v >= 3) return 45 + (3.5 - v) / 0.5 * 15;
      if (v >= 2.5) return 60 + (3 - v) / 0.5 * 15;
      return Math.min(90, 75 + (2.5 - v) * 7.5);
    }
    if (v >= 6) return 10;
    if (v >= 5) return 10 + (6 - v) * 8;
    if (v >= 4) return 18 + (5 - v) * 17;
    if (v >= 3) return 35 + (4 - v) * 20;
    if (v >= 2) return 55 + (3 - v) * 20;
    return Math.min(92, 75 + (2 - v) * 8);
  }

  // 股债利差打分（股息率−中国10Y国债，中金红利策略核心框架）
  // hongli参照系：2022上半年高位约2.3-3%，红利低波2026-11约2.9%
  // cdl参照系：长电历史息差约1.0-2.2%，2026年约1.9-2.0%处历史高位（类债溢价）
  _dySpreadScore(v, market = 'hongli') {
    if (market === 'cdl') {
      if (v >= 2.2) return 10;
      if (v >= 1.8) return 10 + (2.2 - v) / 0.4 * 20;
      if (v >= 1.4) return 30 + (1.8 - v) / 0.4 * 25;
      if (v >= 1) return 55 + (1.4 - v) / 0.4 * 20;
      return Math.min(92, 75 + (1 - v) * 20);
    }
    if (v >= 3) return 10;
    if (v >= 2.5) return 10 + (3 - v) / 0.5 * 15;
    if (v >= 2) return 25 + (2.5 - v) / 0.5 * 20;
    if (v >= 1.5) return 45 + (2 - v) / 0.5 * 20;
    if (v >= 1) return 65 + (1.5 - v) / 0.5 * 15;
    return Math.min(95, 80 + (1 - v) * 15);
  }

  // MA200风控打分（Faber方向）：线上越远越安全 → 低分；水下越深回撤风险越高 → 高分
  _ma200RiskScore(v) {
    if (v >= 15) return 15;
    if (v >= 5) return 20 + (15 - v) / 10 * 10;
    if (v >= 0) return 30 + v / 5 * 10;
    if (v >= -5) return 40 + (-v) / 5 * 15;
    if (v >= -10) return 55 + (-v - 5) / 5 * 15;
    if (v >= -20) return 70 + (-v - 10) / 10 * 15;
    return Math.min(95, 85 + (-v - 20) * 0.5);
  }

  // 战术层：情绪系数（只做极端触发，CNN官方分带：0-25极度恐惧 / 75-100极度贪婪）
  _tacticalCoeff(fg) {
    if (fg == null) return { coeff: 1, reason: null };
    let coeff = 1; const reasons = [];
    if (fg <= 25) { coeff *= 1.25; reasons.push(`极度恐惧${round(fg, 1)}，恐慌期保持并小幅加快节奏`); }
    else if (fg >= 75) { coeff *= 0.75; reasons.push(`极度贪婪${round(fg, 1)}，亢奋期小幅放慢节奏`); }
    // Phase 2: VIX/VIX3M > 1.15 → ×1.15 可叠加
    coeff = Math.max(0.5, Math.min(1.5, round(coeff, 3)));
    return { coeff, reason: reasons.join('；') || null };
  }

  // 应用情绪系数（仅作用于常规定投倍数；ALL IN/暂停/减仓等特殊状态不动）
  _applyTactical(base, coeff, reason) {
    if (coeff === 1 || !reason || ![0.5, 1, 2, 3].includes(base.multiple)) return base;
    const m = Math.round(base.multiple * coeff * 100) / 100;
    const fmt = x => String(parseFloat(x.toFixed(2)));
    return { ...base, multiple: m, action: `${fmt(m)}倍定投`, description: `${base.description}｜情绪叠加×${coeff}：${reason}` };
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
      pe_shanghai: '上证指数市盈率', pe_csi300: '沪深300市盈率',
      pe_stock: '银行股市盈率', pe_utility: '电力股市盈率', pe_mining: '矿业股市盈率',
      dividend_yield: '股息率',
      rsi: 'RSI(14)', ma200: '200日均线偏离度',
      pe_composite: 'PE综合估值', cape: 'CAPE周期调整市盈率', erp: '股权风险溢价ERP', ma200_risk: '200日趋势风控',
      real_yield: '10年TIPS实际利率', gold_real_pct: '黄金实际价格分位', dxy_pct: '美元指数5年分位',
      pe_pct_hist: 'PE历史分位', pb_pct_hist: 'PB历史分位', erp_hk: '港股ERP', div_yield_level: '股息率水平',
      dy_spread_cn: '股债利差', stock_pb: '个股PB水平', copper_pct: '铜价10年分位',
    };
    return names[k] || k;
  }
  _indInfo(k) {
    const infos = {
      vix: { name: 'VIX波动率', desc: '衡量市场恐慌程度，越高越恐慌' },
      fear_greed: { name: '恐惧与贪婪指数', desc: '市场情绪，越高越贪婪' },
      put_call: { name: '看跌/看涨期权比率', desc: '期权市场情绪，越低越乐观' },
      yield_10y: { name: '10年期国债收益率', desc: '无风险利率，越高越紧缩' },
      dxy: { name: '美元指数DXY', desc: '美元强弱，越强越不利于风险资产' },
      pe_qqq: { name: '纳斯达克100市盈率', desc: '估值水平，越高越贵' },
      pe_sp500: { name: '标普500市盈率', desc: '估值水平，越高越贵' },
      pe_hsi: { name: '恒生指数市盈率', desc: '估值水平，越高越贵' },
      pe_shanghai: { name: '上证指数市盈率', desc: 'A股整体估值水平' },
      pe_csi300: { name: '沪深300市盈率', desc: '大盘股估值水平' },
      pe_stock: { name: '银行股市盈率', desc: '银行股估值水平' },
      pe_utility: { name: '电力股市盈率', desc: '电力行业估值水平' },
      pe_mining: { name: '矿业股市盈率', desc: '矿业行业估值水平' },
      dividend_yield: { name: '股息率', desc: '分红收益率，越高越适合定投（参考华尔街红利策略）' },
      rsi: { name: 'RSI(14)相对强弱指标', desc: '技术指标，越高越超买' },
      ma200: { name: '200日均线偏离度', desc: '价格相对于200日均线的位置' },
      pe_composite: { name: 'PE综合估值', desc: '市盈率历史分位（forward接入前用trailing）：forward与trailing内混合，主锚' },
      cape: { name: 'CAPE周期调整市盈率', desc: '美股10年平滑估值（S&P口径），跨周期不可操纵的长周期锚，分数≈历史分位' },
      erp: { name: '股权风险溢价ERP', desc: '盈利收益率−10年期国债收益率：持有股票相对无风险债权的补偿' },
      ma200_risk: { name: '200日趋势风控', desc: 'Faber均线证据：水下回撤风险升高，不加速定投' },
      real_yield: { name: '10年TIPS实际利率', desc: '持金机会成本（FRED DFII10）。注：2022后央行购金使此链条减弱，权重已调低' },
      gold_real_pct: { name: '黄金实际价格分位', desc: '金价÷CPI后的50年历史分位——无现金流资产的长周期估值锚' },
      dxy_pct: { name: '美元指数5年分位', desc: '美元越强，以美元计价的黄金越承压（反向驱动）' },
      pe_pct_hist: { name: 'PE历史分位', desc: '指数市盈率近10年历史分位（蛋卷基金口径），估值主锚' },
      pb_pct_hist: { name: 'PB历史分位', desc: '市净率近10年历史分位（蛋卷基金口径）' },
      erp_hk: { name: '港股ERP', desc: '盈利收益率−美债10Y（港币联系汇率下美债即港股无风险利率），中金口径' },
      div_yield_level: { name: '股息率水平', desc: '指数股息率相对其历史区间的位置，越高越便宜' },
      dy_spread_cn: { name: '股债利差', desc: '股息率−中国10Y国债（中金红利策略核心标尺，国债用静态锚点季度校准），越高红利越便宜' },
      stock_pb: { name: '个股PB水平', desc: '个股市净率在其历史区间锚点表中的位置——银行/水电/周期股的估值主锚' },
      copper_pct: { name: '铜价10年分位', desc: 'COMEX铜价10年周线分位——周期股的周期位置锚，高分=周期顶部风险（紫金PE是反向指标，不参与评分）' },
    };
    return infos[k] || { name: k, desc: '' };
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

function normPE_Shanghai(v) {
  if (v == null) return { score: null, label: 'N/A' };
  if (v < 10) return { score: 0, label: '历史低位' };
  if (v < 12) return { score: cap((v - 10) / 2 * 25), label: '偏低' };
  if (v < 14) return { score: cap(25 + (v - 12) / 2 * 25), label: '正常' };
  if (v < 16) return { score: cap(50 + (v - 14) / 2 * 20), label: '偏高' };
  if (v < 18) return { score: cap(70 + (v - 16) / 2 * 15), label: '高估' };
  return { score: cap(85 + Math.min(15, (v - 18) / 2 * 15)), label: '严重高估' };
}

function normPE_CSI300(v) {
  if (v == null) return { score: null, label: 'N/A' };
  if (v < 10) return { score: 0, label: '历史低位' };
  if (v < 12) return { score: cap((v - 10) / 2 * 25), label: '偏低' };
  if (v < 14) return { score: cap(25 + (v - 12) / 2 * 25), label: '正常' };
  if (v < 15) return { score: cap(50 + (v - 14) / 1 * 15), label: '偏高' };
  if (v < 17) return { score: cap(65 + (v - 15) / 2 * 20), label: '高估' };
  return { score: cap(85 + Math.min(15, (v - 17) / 3 * 15)), label: '严重高估' };
}

function normPE_Stock(v) {
  if (v == null) return { score: null, label: 'N/A' };
  if (v < 4) return { score: 0, label: '严重低估' };
  if (v < 5) return { score: cap((v - 4) / 1 * 20), label: '低估' };
  if (v < 6) return { score: cap(20 + (v - 5) / 1 * 25), label: '正常偏低' };
  if (v < 7) return { score: cap(45 + (v - 6) / 1 * 25), label: '正常' };
  if (v < 8) return { score: cap(70 + (v - 7) / 1 * 15), label: '偏高' };
  return { score: cap(85 + Math.min(15, (v - 8) / 2 * 15)), label: '高估' };
}

function normPE_Utility(v) {
  if (v == null) return { score: null, label: 'N/A' };
  if (v < 10) return { score: 0, label: '严重低估' };
  if (v < 13) return { score: cap((v - 10) / 3 * 20), label: '低估' };
  if (v < 16) return { score: cap(20 + (v - 13) / 3 * 25), label: '正常偏低' };
  if (v < 20) return { score: cap(45 + (v - 16) / 4 * 25), label: '正常' };
  if (v < 25) return { score: cap(70 + (v - 20) / 5 * 15), label: '偏高' };
  return { score: cap(85 + Math.min(15, (v - 25) / 5 * 15)), label: '高估' };
}

function normDividendYield(v) {
  // 华尔街红利投资策略：高股息率 = 低估 = 适合定投
  // 参考 Dogs of the Dow 策略和红利因子模型
  if (v == null) return { score: null, label: 'N/A' };
  if (v >= 6) return { score: 5, label: '极高股息' };        // >6% 极度低估
  if (v >= 5) return { score: 15, label: '高股息' };          // 5-6% 严重低估
  if (v >= 4) return { score: 25, label: '较高股息' };         // 4-5% 低估
  if (v >= 3) return { score: 40, label: '中等股息' };         // 3-4% 正常偏低
  if (v >= 2) return { score: 55, label: '低股息' };           // 2-3% 正常
  if (v >= 1) return { score: 70, label: '极低股息' };        // 1-2% 偏高
  return { score: 85, label: '无分红' };                       // <1% 高估
}

function normPE_Mining(v) {
  if (v == null) return { score: null, label: 'N/A' };
  if (v < 8) return { score: 0, label: '严重低估' };
  if (v < 10) return { score: cap((v - 8) / 2 * 20), label: '低估' };
  if (v < 12) return { score: cap(20 + (v - 10) / 2 * 25), label: '正常偏低' };
  if (v < 15) return { score: cap(45 + (v - 12) / 3 * 25), label: '正常' };
  if (v < 18) return { score: cap(70 + (v - 15) / 3 * 15), label: '偏高' };
  return { score: cap(85 + Math.min(15, (v - 18) / 3 * 15)), label: '高估' };
}

function round(v, d = 2) { return v != null ? parseFloat(v.toFixed(d)) : null; }
function cap(v) { return Math.max(0, Math.min(100, round(v))); }