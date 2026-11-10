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
        indicators: ['pe_composite', 'cape', 'erp_real', 'ma200_risk'],
        weights: { pe_composite: 0.35, cape: 0.30, erp_real: 0.20, ma200_risk: 0.15 }, pe_normal: 25,
        method_note: 'CAPE为S&P口径，QQQ只作交叉验证；用实际股权风险溢价（盈利收益率−TIPS实际利率）替代名义ERP，避免Fed模型通胀幻觉' },
      { id: 'voo', name: 'VOO 标普500 ETF', symbol: 'VOO', type: '美国ETF', strategic: true, pe_family: 'spx',
        indicators: ['pe_composite', 'cape', 'erp_real', 'ma200_risk'],
        weights: { pe_composite: 0.20, cape: 0.45, erp_real: 0.20, ma200_risk: 0.15 }, pe_normal: 22,
        method_note: 'CAPE主锚45%；用实际股权风险溢价（盈利收益率−TIPS实际利率）替代名义ERP，避免Fed模型通胀幻觉' },
      { id: 'gld', name: '黄金 GLD ETF', symbol: 'GLD', type: '商品ETF', strategic: true, tactical_fg: false, accel_rich: 'cycle',
        indicators: ['real_yield', 'gold_real_pct', 'dxy_pct', 'ma200_risk'],
        weights: { real_yield: 0.30, gold_real_pct: 0.25, dxy_pct: 0.20, ma200_risk: 0.25 }, pe_normal: null,
        method_note: '黄金不叠加恐惧贪婪指数：金价趋势已含恐慌定价' },
      { id: 'hsi', name: '恒生指数', symbol: '^HSI', type: '香港指数', strategic: true, tactical_fg: false, dj_index: '恒生指数', dy_source: 'danjuan', dy_map: 'hsi',
        indicators: ['pe_pct_hist', 'erp_hk', 'div_yield_level', 'ma200_risk'],
        weights: { pe_pct_hist: 0.35, erp_hk: 0.30, div_yield_level: 0.15, ma200_risk: 0.20 }, pe_normal: 12,
        method_note: '港股高息但股息率只作15%的carry交叉验证，主权重给PE分位与港股ERP' },
      { id: 'dividend_low_vol_etf', name: '红利低波ETF(512890)', symbol: '512890.SS', type: '中国ETF', strategic: true, tactical_fg: false, dj_index: '红利低波', dy_source: 'danjuan', pb_roe_fair_pe: 10,
        indicators: ['pe_pct_hist', 'pb_pct_hist', 'roe_level', 'payout_ratio', 'dy_carry', 'ma200_risk'],
        weights: { pe_pct_hist: 0.25, pb_pct_hist: 0.10, roe_level: 0.20, payout_ratio: 0.15, dy_carry: 0.20, ma200_risk: 0.10 }, pe_normal: null,
        method_note: '股息率是红利策略的收益来源而非估值信号：指标显示实际股息率，按股息率−中国10Y国债作carry评分(20%)；ROE(PB/PE)与派息率(股息率×PE)价格中性，负责质量与可持续性；派息率>75%时高息不加分' },
      { id: 'dividend_low_vol_100', name: '红利低波100(930955)', symbol: '930955.SS', tech_symbol: '563020.SS', type: '中国指数', strategic: true, tactical_fg: false, dj_index: '红利低波', dy_source: 'danjuan', pb_roe_fair_pe: 10,
        indicators: ['pe_pct_hist', 'pb_pct_hist', 'roe_level', 'payout_ratio', 'dy_carry', 'ma200_risk'],
        weights: { pe_pct_hist: 0.25, pb_pct_hist: 0.10, roe_level: 0.20, payout_ratio: 0.15, dy_carry: 0.20, ma200_risk: 0.10 }, pe_normal: null,
        method_note: '同红利低波ETF：股息率作为carry参与评分(20%)，ROE/派息率负责质量与防高息陷阱',
        data_note: '蛋卷无930955独立估值，PE/PB分位借用同因子「红利低波」指数代理；Yahoo无930955历史K线，MA200/回撤用跟踪同一指数的563020 ETF代理' },
      { id: 'abc_bank', name: '农业银行(601288)', symbol: '601288.SS', type: '中国银行股', strategic: true, tactical_fg: false, dj_index: '中证银行', dy_source: 'td', dy_map: 'bank', pb_roe_fair_pe: 8, accel_rich: 'pb',
        indicators: ['div_yield_level', 'pb_pct_hist', 'stock_pb', 'roe_level', 'payout_ratio', 'ma200_risk'],
        weights: { div_yield_level: 0.15, pb_pct_hist: 0.15, stock_pb: 0.20, roe_level: 0.20, payout_ratio: 0.15, ma200_risk: 0.15 }, pe_normal: null,
        method_note: '股息率只保留15%作carry交叉验证；主权重给PB分位、PB-ROE质量与派息可持续性' },
      { id: 'ccb_bank', name: '建设银行(601939)', symbol: '601939.SS', type: '中国银行股', strategic: true, tactical_fg: false, dj_index: '中证银行', dy_source: 'td', dy_map: 'bank', pb_roe_fair_pe: 8, accel_rich: 'pb',
        indicators: ['div_yield_level', 'pb_pct_hist', 'stock_pb', 'roe_level', 'payout_ratio', 'ma200_risk'],
        weights: { div_yield_level: 0.15, pb_pct_hist: 0.15, stock_pb: 0.20, roe_level: 0.20, payout_ratio: 0.15, ma200_risk: 0.15 }, pe_normal: null,
        method_note: '股息率只保留15%作carry交叉验证；主权重给PB分位、PB-ROE质量与派息可持续性' },
      { id: 'yangtze_power', name: '长江电力(600900)', symbol: '600900.SS', type: '中国电力股', strategic: true, tactical_fg: false, dy_source: 'anchor', dy_anchor: DY_CDL_ANCHOR, dy_map: 'cdl', pe_family: 'cdl', pb_family: 'cdl', pb_roe_fair_pe: 20,
        indicators: ['dy_spread_cn', 'pe_composite', 'stock_pb', 'roe_level', 'payout_ratio', 'ma200_risk'],
        weights: { dy_spread_cn: 0.25, pe_composite: 0.25, stock_pb: 0.20, roe_level: 0.10, payout_ratio: 0.10, ma200_risk: 0.10 }, pe_normal: null,
        method_note: '类债资产保留股债利差，但加入派息率上限检验（>75%提示可持续性风险）' },
      { id: 'cmb_bank', name: '招商银行(600036)', symbol: '600036.SS', type: '中国银行股', strategic: true, tactical_fg: false, dj_index: '中证银行', dy_source: 'td', dy_map: 'bank', pb_roe_fair_pe: 8, accel_rich: 'pb',
        indicators: ['div_yield_level', 'pb_pct_hist', 'stock_pb', 'roe_level', 'payout_ratio', 'ma200_risk'],
        weights: { div_yield_level: 0.15, pb_pct_hist: 0.15, stock_pb: 0.20, roe_level: 0.20, payout_ratio: 0.15, ma200_risk: 0.15 }, pe_normal: null,
        method_note: '股息率只保留15%作carry交叉验证；主权重给PB分位、PB-ROE质量与派息可持续性' },
      { id: 'zijin_mining', name: '紫金矿业(601899)', symbol: '601899.SS', type: '中国矿业股', strategic: true, tactical_fg: false, pb_family: 'zj', accel_rich: 'cycle',
        indicators: ['copper_pct', 'gold_real_pct', 'stock_pb', 'ma200_risk'],
        weights: { copper_pct: 0.35, gold_real_pct: 0.15, stock_pb: 0.25, ma200_risk: 0.25 }, pe_normal: null,
        method_note: '周期股PE是反向指标，不参与评分；铜价分位/PB/趋势为主' },
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

  // ========== 战略×战术双层评分（十年定投导向） ==========
  // 战略层：估值/质量/趋势加权，分数 0=便宜 → 100=贵（估值分位项≈历史分位）
  // 定投层：1x底仓 + 估值分位/回撤加速（1.5x/2x/3x），不暂停、不减仓
  // 战术层：恐惧贪婪只在极端做±25%微调，不进入评分
  // 依据：Vanguard(期初估值是10年收益最好预测器)、AQR(Market Timing Sin a Little)、Faber均线(回撤风控)
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
    const accel = this._accelSignals(cfg, td, global);
    const base = this._strategy(composite, accel);
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
      formula: `战略评分 = ${cfg.indicators.map(fw).join(' + ')}｜倍数 = 1x底仓 + 估值/回撤加速${cfg.tactical_fg !== false ? `${coeff !== 1 ? ` × 情绪${coeff}` : ''}` : '（无情绪叠加）'}`,
      formula_detail: `十年定投双层架构：评分0=便宜→100=贵（估值/分位项≈历史分位）；定投倍数以1x为底仓，仅在综合评分≤40、PE分位≤40%或距52周高点回撤≥15%时加速（1.5x/2x/3x）；估值极端高位时回撤不加速（股票PE分位/银行PB分位/商品实际价格分位≥85%）；不暂停、不减仓，1x底仓不因贪婪减速。依据：Vanguard定投现金拖累、AQR Market Timing Sin a Little、Faber均线风控${cfg.method_note ? `｜${cfg.method_note}` : ''}${cfg.data_note ? `｜${cfg.data_note}` : ''}`,
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
    if (key === 'erp_real') {
      // 实际股权风险溢价 = 盈利收益率 − 10年TIPS实际利率（剔除通胀幻觉的ERP）
      const pe = td.pe_ratio, ry = global.real_yield_10y?.value;
      if (pe == null || ry == null || pe <= 0) return { value: null, score: null, unit: '%' };
      const v = round(100 / pe - ry, 2);
      return { value: v, score: round(this._erpRealScore(v)), unit: '%' };
    }
    if (key === 'ma200_risk') {
      const v = td.technical?.ma200_pct;
      return { value: v, score: v != null ? round(this._ma200RiskScore(v)) : null, unit: '%' };
    }
    if (key === 'real_yield') {
      const v = global.real_yield_10y?.value;
      return { value: v, score: v != null ? round(this._realYieldScore(v)) : null, unit: '%', family: cfg.real_yield_context || 'gold' };
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
    if (key === 'dy_carry') {
      // 股息率是红利策略的收益来源（carry），不是估值信号：
      // 指标值显示实际股息率，评分用“股息率−中国10Y国债”；派息率>75%触发高息陷阱保护
      const dj = cfg.dj_index ? global.danjuan?.map?.[cfg.dj_index] : null;
      const dy = cfg.dy_source === 'danjuan' ? (dj?.dy ?? null)
        : cfg.dy_source === 'anchor' ? cfg.dy_anchor
        : (td.dividend_yield ?? null);
      if (dy == null) return { value: null, score: null, unit: '%' };
      const pe = cfg.dy_source === 'danjuan' ? (dj?.pe ?? null)
        : cfg.dy_source === 'anchor' ? (td.pe_ratio ?? dj?.pe ?? null)
        : (td.stock_pe ?? td.pe_ratio ?? dj?.pe ?? null);
      const payout = pe != null && pe > 0 ? dy * pe : null;
      let score = this._dySpreadScore(round(dy - CN10Y_ANCHOR, 2), 'hongli');
      let family = null;
      if (payout != null && payout > 75) { score = Math.max(score, 60); family = 'trap'; }
      return { value: dy, score: round(score), unit: '%', family };
    }
    if (key === 'roe_level') {
      // ROE = PB/PE（价格中性：E/B，不随股价漂移）；用 PB-ROE 合理值做质量调整后的估值
      const dj = cfg.dj_index ? global.danjuan?.map?.[cfg.dj_index] : null;
      // 个股优先用东财同一请求的 PE/PB（口径一致）；指数退到蛋卷，避免个股PB混指数PE
      const hasStockPB = td.pb != null;
      const pe = hasStockPB ? (td.stock_pe ?? td.pe_ratio ?? dj?.pe ?? null) : (dj?.pe ?? td.pe_ratio ?? null);
      const pb = hasStockPB ? td.pb : (dj?.pb ?? null);
      if (pe == null || pb == null || pe <= 0 || pb <= 0) return { value: null, score: null, unit: '%' };
      const roe = round(pb / pe * 100, 1);
      const fairPe = cfg.pb_roe_fair_pe ?? (cfg.type.includes('银行') ? 8 : cfg.type.includes('电力') ? 20 : 10);
      const score = this._pbRoeScore(pb, roe, fairPe);
      return { value: roe, score: score == null ? null : round(score), unit: '%' };
    }
    if (key === 'payout_ratio') {
      // 派息率 = 股息率 × PE（价格中性：D/E）；只检验分红可持续性，不把高股息当便宜
      const dj = cfg.dj_index ? global.danjuan?.map?.[cfg.dj_index] : null;
      let dy = null, pe = null;
      if (cfg.dy_source === 'danjuan') { dy = dj?.dy ?? null; pe = dj?.pe ?? null; }
      else if (cfg.dy_source === 'anchor') { dy = cfg.dy_anchor ?? null; pe = td.pe_ratio ?? dj?.pe ?? null; }
      else if (td.dividend_yield != null) { dy = td.dividend_yield; pe = td.stock_pe ?? td.pe_ratio ?? dj?.pe ?? null; }
      else { dy = dj?.dy ?? null; pe = dj?.pe ?? null; }
      if (dy == null || pe == null || pe <= 0) return { value: null, score: null, unit: '%' };
      const v = round(dy * pe, 1);
      return { value: v, score: round(this._payoutScore(v)), unit: '%' };
    }
    return { value: null, score: null };
  }

  _mkInd(key, weight, value, score, unit, family) {
    const ni = this._indInfo(key);
    const r = { score, label: 'N/A', value, weight, unit, name: ni.name, description: ni.desc };
    if (score != null) r.label = this._strategicLabel(key, score, family, value);
    return r;
  }

  _strategicLabel(key, score, peFamily, value) {
    if (key === 'pe_composite') {
      const fam = peFamily === 'spx' ? '标普' : peFamily === 'cdl' ? '长电PE历史' : '纳指100';
      return score < 30 ? `${fam}低估` : score < 55 ? `${fam}合理` : score < 75 ? `${fam}偏高` : score < 90 ? `${fam}高估` : `${fam}严重高估`;
    }
    if (key === 'cape') return score < 30 ? 'CAPE低估' : score < 55 ? 'CAPE合理' : score < 75 ? 'CAPE偏高' : score < 90 ? 'CAPE高估' : 'CAPE历史极值区';
    if (key === 'erp') return score < 30 ? '股票相对债券便宜' : score < 55 ? '股票相对债券中性' : score < 75 ? '股票相对债券偏贵' : '股票相对债券昂贵';
    if (key === 'erp_real') return score < 25 ? '实际ERP极丰厚' : score < 45 ? '实际ERP偏厚' : score < 68 ? '实际ERP偏薄' : '实际ERP为负(债券占优)';
    if (key === 'ma200_risk') return score < 30 ? '趋势完好' : score < 55 ? '接近均线(低风险)' : score < 75 ? '跌破均线(回撤风险)' : '深度水下(回撤风险)';
    if (key === 'real_yield') {
      if (peFamily === 'equity') return score < 30 ? '实际利率低位(估值支撑)' : score < 55 ? '实际利率中性' : score < 75 ? '实际利率偏高(估值压力)' : '实际利率高位(估值压力)';
      return score < 30 ? '实际利率低位(利多黄金)' : score < 55 ? '实际利率中性' : score < 75 ? '实际利率偏高(利空黄金)' : '实际利率高位(利空黄金)';
    }
    if (key === 'gold_real_pct') return score < 30 ? '实际金价低估' : score < 55 ? '实际金价合理' : score < 75 ? '实际金价偏高' : score < 90 ? '实际金价高估' : '实际金价历史极值区';
    if (key === 'dxy_pct') return score < 30 ? '美元弱势(利多黄金)' : score < 60 ? '美元中性' : score < 80 ? '美元偏强(利空黄金)' : '美元历史高位(利空黄金)';
    if (key === 'pe_pct_hist') return score < 30 ? 'PE历史低估' : score < 55 ? 'PE历史合理' : score < 75 ? 'PE历史偏高' : score < 90 ? 'PE历史高估' : 'PE历史极值区';
    if (key === 'pb_pct_hist') return score < 30 ? 'PB历史低估' : score < 55 ? 'PB历史合理' : score < 75 ? 'PB历史偏高' : score < 90 ? 'PB历史高估' : 'PB历史极值区';
    if (key === 'erp_hk') return score < 25 ? '港股ERP丰厚(极有吸引力)' : score < 50 ? '港股ERP偏正(有吸引力)' : score < 65 ? '港股ERP中性' : '港股ERP为负(债券占优)';
    if (key === 'copper_pct') return score < 30 ? '铜价低位(周期底部)' : score < 55 ? '铜价中位' : score < 75 ? '铜价偏高' : '铜价历史高位(周期顶部风险)';
    if (key === 'div_yield_level') return score < 30 ? '股息率丰厚' : score < 50 ? '股息率正常偏低' : score < 70 ? '股息率偏低' : '股息率历史低位';
    if (key === 'dy_spread_cn') return score < 25 ? '股债利差丰厚(红利极有吸引力)' : score < 45 ? '股债利差偏正(红利有吸引力)' : score < 65 ? '股债利差中性' : '股债利差偏薄(债券占优)';
    if (key === 'dy_carry') {
      const sp = value != null ? round(value - CN10Y_ANCHOR, 2) : null;
      if (sp == null) return 'N/A';
      if (peFamily === 'trap') return `利差${sp}%｜派息率>75%警惕`;
      const tone = score < 25 ? '丰厚' : score < 45 ? '偏厚' : score < 65 ? '中性' : '偏薄';
      return `利差${sp}%｜${tone}`;
    }
    if (key === 'roe_level') return score < 30 ? 'PB明显低于ROE合理值' : score < 45 ? 'PB低于ROE合理值' : score < 60 ? 'PB与ROE匹配' : score < 75 ? 'PB高于ROE合理值' : 'PB显著高于ROE合理值';
    if (key === 'payout_ratio') {
      if (value != null && value > 75) return '派息率过高(可持续性风险)';
      if (value != null && value < 20) return '派息率偏低(红利支撑弱)';
      return '派息率健康';
    }
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

  // 实际ERP打分：≥4%→10 … 0%→65 … <−1%→80+（实际口径下股票相对TIPS的补偿）
  _erpRealScore(v) {
    if (v >= 4) return 10;
    if (v >= 2) return 10 + (4 - v) / 2 * 25;
    if (v >= 0) return 35 + (2 - v) / 2 * 30;
    if (v >= -1) return 65 + (-v) * 15;
    return Math.min(95, 80 + (-1 - v) * 7.5);
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
    if (market === 'bank') {
      // A股银行股息率历史区间约3-6.5%（2025重估行情后整体下移）
      if (v >= 5.5) return 10;
      if (v >= 4.5) return 10 + (5.5 - v) * 2;
      if (v >= 4) return 30 + (4.5 - v) * 4;
      if (v >= 3.5) return 50 + (4 - v) * 4;
      if (v >= 3) return 70 + (3.5 - v) * 4;
      return Math.min(95, 90 + (3 - v) * 5);
    }
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

  // PB-ROE 质量调整估值：ROE=PB/PE 是价格中性的盈利能力；PB 低于 ROE×合理PE 隐含的PB → 低分（便宜）
  _pbRoeScore(pb, roe, fairPe) {
    if (pb == null || roe == null || fairPe == null || roe <= 0) return null;
    const fairPB = roe / 100 * fairPe;
    if (fairPB <= 0) return null;
    const premium = pb / fairPB - 1;
    if (premium <= -0.3) return 15;
    if (premium <= -0.15) return 15 + (premium + 0.3) / 0.15 * 15;
    if (premium <= 0) return 30 + (premium + 0.15) / 0.15 * 15;
    if (premium <= 0.2) return 45 + premium / 0.2 * 15;
    if (premium <= 0.4) return 60 + (premium - 0.2) / 0.2 * 20;
    return Math.min(95, 80 + (premium - 0.4) * 50);
  }

  // 派息率可持续性（价格中性 D/E）：30-60%健康；>75%透支；<20%红利支撑弱
  _payoutScore(v) {
    if (v == null) return null;
    if (v >= 30 && v <= 60) return 20;
    if (v > 60 && v <= 75) return 20 + (v - 60) / 15 * 25;
    if (v > 75 && v <= 90) return 45 + (v - 75) / 15 * 30;
    if (v > 90) return Math.min(92, 75 + (v - 90));
    if (v >= 20) return 20 + (30 - v) / 10 * 15;
    if (v >= 15) return 35 + (20 - v) / 5 * 20;
    return Math.min(80, 55 + (15 - v) * 2);
  }

  // 加速信号：自身估值分位 + 距52周高点回撤 + 估值是否处极端高位
  // rich 按资产选锚：股票用PE分位；银行PE受拨备/盈利周期扭曲，改用PB分位；黄金/铜用商品实际价格分位
  _accelSignals(cfg, td, global) {
    const pePct = this._targetPePercentile(cfg, td, global);
    let rich = false;
    if (cfg.accel_rich === 'cycle') {
      const vals = [];
      if (cfg.indicators.includes('copper_pct')) vals.push(global.copper_pct?.value);
      if (cfg.indicators.includes('gold_real_pct')) vals.push(global.gold_real_pct?.value);
      rich = vals.some(v => v != null && v >= 85);
    } else if (cfg.accel_rich === 'pb') {
      const pbPct = cfg.dj_index ? global.danjuan?.map?.[cfg.dj_index]?.pb_pct : null;
      rich = pbPct != null && pbPct >= 85;
    } else {
      rich = pePct != null && pePct >= 85;
    }
    return {
      pePct,
      dd: td.technical?.pct_from_52w_high ?? null,
      rich,
    };
  }

  _targetPePercentile(cfg, td, global) {
    const dj = cfg.dj_index ? global.danjuan?.map?.[cfg.dj_index] : null;
    if (dj?.pe_pct != null) return dj.pe_pct;
    if (cfg.indicators.includes('pe_composite') && td.pe_ratio != null) {
      const tbl = cfg.pe_family === 'spx' ? PE_PCT_SPX : cfg.pe_family === 'cdl' ? PE_PCT_CDL : PE_PCT_NDX;
      return round(this._pctFromAnchors(td.pe_ratio, tbl), 1);
    }
    return null;
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

  // 应用情绪系数：只微调加速部分，1x底仓不因贪婪降到1x以下；不暂停、不减仓
  _applyTactical(base, coeff, reason) {
    if (coeff === 1 || !reason || ![1, 1.5, 2, 3].includes(base.multiple)) return base;
    const effective = base.multiple <= 1 && coeff < 1 ? 1 : coeff;
    if (effective === 1) {
      return { ...base, description: `${base.description}｜${reason}（1x底仓不减速）` };
    }
    const m = Math.round(base.multiple * effective * 4) / 4;
    const fmt = x => String(parseFloat(x.toFixed(2)));
    const tone = m >= 2
      ? { color: '#fd7e14', icon: '📈' }
      : m > 1
        ? { color: '#ffc107', icon: '📊' }
        : { color: '#28a745', icon: '✅' };
    return { ...base, multiple: m, action: `${fmt(m)}倍定投`, description: `${base.description}｜情绪叠加×${effective}：${reason}`, ...tone };
  }

  _marketPosition(s) {
    if (s == null) return { label: '数据不足', color: '#6c757d' };
    if (s <= 20) return { label: '历史低位', color: '#dc3545' };
    if (s <= 40) return { label: '低位区域', color: '#fd7e14' };
    if (s <= 60) return { label: '正常区间', color: '#28a745' };
    if (s <= 80) return { label: '高位区域', color: '#ffc107' };
    return { label: '历史高位', color: '#dc3545' };
  }

  _strategy(s, accel = {}) {
    if (s == null) return { action: '等待数据', multiple: 0, description: '数据不足，请稍后刷新', color: '#6c757d', icon: '⏳' };
    const { pePct = null, dd = null, rich = false } = accel;
    let multiple = 1;
    const reasons = [];

    // 1) 综合评分加速（估值/质量/趋势的加权结果）
    if (s <= 15) { multiple = 3; reasons.push(`综合评分${s}≤15`); }
    else if (s <= 30) { multiple = 2; reasons.push(`综合评分${s}≤30`); }
    else if (s <= 40) { multiple = 1.5; reasons.push(`综合评分${s}≤40`); }

    // 2) 自身估值分位加速
    if (pePct != null) {
      if (pePct <= 15 && multiple < 3) { multiple = 3; reasons.push(`PE分位${pePct}%≤15%`); }
      else if (pePct <= 25 && multiple < 2) { multiple = 2; reasons.push(`PE分位${pePct}%≤25%`); }
      else if (pePct <= 40 && multiple < 1.5) { multiple = 1.5; reasons.push(`PE分位${pePct}%≤40%`); }
    }

    // 3) 回撤加速：仅在估值未处极端高位时生效，避免在泡沫里接飞刀
    if (dd != null && dd <= -15) {
      const dM = dd <= -35 ? 3 : dd <= -25 ? 2 : 1.5;
      if (rich) {
        reasons.push(`距52周高点${dd}%，但估值处高位，回撤不加速`);
      } else if (dM > multiple) {
        multiple = dM;
        reasons.push(`距52周高点${dd}%`);
      }
    }

    const desc = reasons.length
      ? `${reasons.join('；')}，建议${multiple}倍定投`
      : '未触发估值/回撤加速，维持1倍底仓定投（不暂停）';
    const tone = multiple >= 2
      ? { color: '#fd7e14', icon: '📈' }
      : multiple > 1
        ? { color: '#ffc107', icon: '📊' }
        : { color: '#28a745', icon: '✅' };
    return { action: `${multiple}倍定投`, multiple, description: desc, ...tone };
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
      pe_composite: 'PE综合估值', cape: 'CAPE周期调整市盈率', erp: '股权风险溢价ERP', erp_real: '实际股权风险溢价', ma200_risk: '200日趋势风控',
      real_yield: '10年TIPS实际利率', gold_real_pct: '黄金实际价格分位', dxy_pct: '美元指数5年分位',
      pe_pct_hist: 'PE历史分位', pb_pct_hist: 'PB历史分位', erp_hk: '港股ERP', div_yield_level: '股息率水平',
      dy_spread_cn: '股债利差', dy_carry: '股息率(股债利差)', stock_pb: '个股PB水平', copper_pct: '铜价10年分位',
      roe_level: 'ROE质量估值(PB-ROE)', payout_ratio: '派息率可持续性',
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
      erp_real: { name: '实际股权风险溢价', desc: '盈利收益率−10年TIPS实际利率：剔除通胀后的股票相对债券补偿；负值=债券占优' },
      ma200_risk: { name: '200日趋势风控', desc: 'Faber均线证据：价格越低于200日均线，回撤风险越高，作为风险评分项' },
      real_yield: { name: '10年TIPS实际利率', desc: '无现金流/长久期资产的机会成本（FRED DFII10）；实际利率越高，黄金与成长股估值压力越大' },
      gold_real_pct: { name: '黄金实际价格分位', desc: '金价÷CPI后的50年历史分位——无现金流资产的长周期估值锚' },
      dxy_pct: { name: '美元指数5年分位', desc: '美元越强，以美元计价的黄金越承压（反向驱动）' },
      pe_pct_hist: { name: 'PE历史分位', desc: '指数市盈率近10年历史分位（蛋卷基金口径），估值主锚' },
      pb_pct_hist: { name: 'PB历史分位', desc: '市净率近10年历史分位（蛋卷基金口径）' },
      erp_hk: { name: '港股ERP', desc: '盈利收益率−美债10Y（港币联系汇率下美债即港股无风险利率），中金口径' },
      div_yield_level: { name: '股息率水平', desc: '股息率相对其历史区间的位置；仅作carry交叉验证，单一高股息可能是陷阱（Morgan Stanley）' },
      dy_spread_cn: { name: '股债利差', desc: '股息率−中国10Y国债（中金红利策略核心标尺，国债用静态锚点季度校准），越高红利越便宜' },
      dy_carry: { name: '股息率(股债利差)', desc: '红利策略的收益来源：显示实际股息率，按股息率−中国10Y国债评分；派息率>75%时触发高息陷阱保护，高息不加分' },
      stock_pb: { name: '个股PB水平', desc: '个股市净率在其历史区间锚点表中的位置——银行/水电/周期股的估值主锚' },
      roe_level: { name: 'ROE质量估值(PB-ROE)', desc: 'ROE=PB/PE（价格中性）；实际PB低于ROE×合理PE隐含的PB=质量调整后便宜' },
      payout_ratio: { name: '派息率可持续性', desc: '派息率=股息率×PE（价格中性）；30-60%健康，>75%可持续性风险，<20%红利支撑弱' },
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