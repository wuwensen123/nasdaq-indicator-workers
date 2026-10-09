/**
 * 定投（DCA）回测计算引擎
 * 支持多标的组合、分红再投资、XIRR、CAGR、逐年收益
 */

// XIRR 计算（牛顿迭代法）
export function calcXIRR(cashflows, dates) {
  if (cashflows.length < 2) return 0;
  const DAYS = 365.0;
  const t0 = Math.min(...dates.map(d => new Date(d).getTime()));
  const dayDiffs = dates.map(d => (new Date(d).getTime() - t0) / (1000 * 60 * 60 * 24));

  function npv(rate) {
    return cashflows.reduce((sum, cf, i) => sum + cf / Math.pow(1 + rate, dayDiffs[i] / DAYS), 0);
  }

  let rate = 0.1;
  for (let i = 0; i < 200; i++) {
    const f = npv(rate);
    const eps = 0.0001;
    const df = (npv(rate + eps) - npv(rate - eps)) / (2 * eps);
    if (Math.abs(f) < 1e-7) break;
    if (Math.abs(df) < 1e-12) break;
    rate = rate - f / df;
    if (rate < -0.9999) rate = -0.9999;
  }
  return rate;
}

// 计算 CAGR
function calcCAGR(finalValue, totalInvested, years) {
  if (years <= 0 || totalInvested <= 0) return 0;
  return Math.pow(finalValue / totalInvested, 1 / years) - 1;
}

// 按频率生成定投日期
// investMode: 'dca'(定投,默认) | 'lump'(一次性)
// investEndDate: 投入阶段结束日(可选), 之后进入持有期不再投入
function getInvestDates(frequency, startDate, endDate, investMode, investEndDate) {
  const dates = [];
  const start = new Date(startDate);
  // 投入阶段截止日: 若指定 investEndDate 则用它, 否则用 endDate(全程投入)
  // 若 investEndDate 早于 startDate 或非法, 视为无效 → 用 endDate
  let investEnd = new Date(investEndDate);
  if (!investEndDate || isNaN(investEnd.getTime()) || investEnd < start) {
    investEnd = new Date(endDate);
  }
  const current = new Date(start);

  // 一次性投入: 只在 start 日投入一次
  if (investMode === 'lump') {
    dates.push(new Date(start).toISOString().slice(0, 10));
    return dates;
  }

  // 定投模式: 按 frequency 在 [start, investEnd] 生成
  if (frequency === 'monthly') {
    while (current <= investEnd) {
      dates.push(new Date(current).toISOString().slice(0, 10));
      current.setMonth(current.getMonth() + 1);
    }
  } else if (frequency === 'weekly') {
    while (current <= investEnd) {
      dates.push(new Date(current).toISOString().slice(0, 10));
      current.setDate(current.getDate() + 7);
    }
  } else if (frequency === 'quarterly') {
    while (current <= investEnd) {
      dates.push(new Date(current).toISOString().slice(0, 10));
      current.setMonth(current.getMonth() + 3);
    }
  }
  return dates;
}

// 生成再平衡日期
function getRebalanceDates(frequency, startDate, endDate) {
  if (frequency === 'none') return [];
  const dates = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  const startStr = startDate.slice(0, 10);
  const endStr = endDate.slice(0, 10);
  for (let y = start.getFullYear(); y <= end.getFullYear(); y++) {
    const candidates = [`${y}-01-01`];
    if (frequency === 'semi-annual' || frequency === 'quarterly') candidates.push(`${y}-07-01`);
    if (frequency === 'quarterly') { candidates.push(`${y}-04-01`); candidates.push(`${y}-10-01`); }
    for (const d of candidates) {
      if (d >= startStr && d <= endStr) dates.push(d);
    }
  }
  return dates;
}

// 执行再平衡（按目标权重重新分配份额）
function applyRebalance(shares, assets, findPrice, date) {
  let totalValue = 0;
  const values = [];
  for (let i = 0; i < assets.length; i++) {
    const price = findPrice(i, date) || 0;
    const value = shares[i] * price;
    values.push(value);
    totalValue += value;
  }
  if (totalValue <= 0) return;
  for (let i = 0; i < assets.length; i++) {
    const targetValue = totalValue * assets[i].weight;
    shares[i] = targetValue / (findPrice(i, date) || 1);
  }
}

// 按市场构建费率方案
function buildFeePlan(assets, fees) {
  const enabled = !!(fees && fees.enabled);
  const customRate = fees && fees.customCommission ? parseFloat(fees.customCommission) / 100 : null;
  const minCommission = fees && fees.minCommission ? parseFloat(fees.minCommission) : null;

  // 每个资产按其市场生成费率
  return assets.map(a => {
    const market = a.market || 'A股基金';
    let buyRate = 0.00025, sellRate = 0.00025, sellStamp = 0, minFee = 5;
    if (market === '美股') { buyRate = 0.0003; sellRate = 0.0003; minFee = 1; }
    else if (market === '港股') { buyRate = 0.00025; sellRate = 0.00025; minFee = 5; }
    // 自定义佣金覆盖买入/卖出
    if (customRate != null) { buyRate = customRate; sellRate = customRate; }
    return {
      enabled,
      buyRate, sellRate, sellStamp, minFee,
    };
  });
}

// 计算买入到账份额（含手续费）
function investShares(amount, price, feePlan) {
  if (!price || price <= 0) return 0;
  if (!feePlan.enabled) return amount / price;
  const fee = amount * feePlan.buyRate;
  const actualFee = Math.max(fee, feePlan.minFee || 0);
  return (amount - actualFee) / price;
}

// 计算卖出净额（含手续费）
function exitValue(gross, feePlan) {
  if (!feePlan.enabled) return gross;
  let net = gross;
  const sellFee = net * feePlan.sellRate;
  net -= Math.max(sellFee, feePlan.minFee || 0);
  net -= net * feePlan.sellStamp;
  return net;
}

// 主回测函数
export function runBacktest(config) {
  const { assets, amount, frequency, startDate, endDate, rebalance, investMode, investEndDate, fees } = config;
  // assets: [{ symbol, weight, prices[], dates[], dividends{}, market }]
  // fees: { enabled, customCommission, minCommission } 可选
  // 按市场取默认费率
  const feePlan = buildFeePlan(assets, fees);

  if (!assets.length || !amount) return null;

  const totalAmount = amount;
  const investDates = getInvestDates(frequency, startDate, endDate, investMode || 'dca', investEndDate);

  // 为每个标的维护份额
  const shares = assets.map(() => 0);
  // 现金流记录（用于 XIRR）
  const cashflows = [];
  const cashflowDates = [];

  // 构建交易日价格索引: { date: price }
  const priceMaps = assets.map(a => {
    const map = {};
    for (let i = 0; i < a.dates.length; i++) {
      map[a.dates[i]] = a.prices[i];
    }
    return map;
  });

  // 构建每个资产的有序日期数组（用于找最近价格）
  const sortedDates = assets.map(a => [...a.dates].sort());

  // 查找最近的有效价格（优先当日，其次下一个交易日）
  function findPrice(assetIdx, date) {
    if (priceMaps[assetIdx][date]) return priceMaps[assetIdx][date];
    const dates = sortedDates[assetIdx];
    let lo = 0, hi = dates.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid] >= date) { ans = mid; hi = mid - 1; }
      else lo = mid + 1;
    }
    if (ans >= 0) return priceMaps[assetIdx][dates[ans]];
    return dates.length ? priceMaps[assetIdx][dates[dates.length - 1]] : 0;
  }

  // 构建分红索引: { date: dividendAmount }
  const divMaps = assets.map(a => a.dividends || {});

  // 获取所有交易日（用于年底计算）
  const allDates = [...new Set(assets.flatMap(a => a.dates))].sort();

  // 逐次定投
  for (const date of investDates) {
    for (let i = 0; i < assets.length; i++) {
      const investAmt = totalAmount * assets[i].weight;
      const price = findPrice(i, date);
      if (price && price > 0) {
        shares[i] += investShares(investAmt, price, feePlan[i]);
        cashflows.push(-investAmt);
        cashflowDates.push(date);
      }
    }
  }

  // 分红再投资
  for (let i = 0; i < assets.length; i++) {
    for (const [date, divAmt] of Object.entries(divMaps[i])) {
      const price = findPrice(i, date);
      if (price && price > 0) {
        shares[i] += shares[i] * divAmt / price;
      }
    }
  }

  // 再平衡（在副本上执行）
  const endDateStr = new Date(endDate).toISOString().slice(0, 10);
  const rebalShares = [...shares];
  const rebalanceDates = getRebalanceDates(rebalance || 'none', startDate, endDate);
  for (const rbDate of rebalanceDates) {
    if (rbDate > endDateStr) continue;
    applyRebalance(rebalShares, assets, findPrice, rbDate);
  }

  // 计算总投入
  const totalInvested = cashflows.reduce((s, v) => s + Math.abs(v), 0);

  // 计算期末价值（含卖出费）
  let finalValue = 0;
  let grossValue = 0;
  for (let i = 0; i < assets.length; i++) {
    // 找最后一个交易日价格
    const lastPrice = findPrice(i, endDateStr) || 0;
    const val = shares[i] * lastPrice;
    grossValue += val;
    finalValue += exitValue(val, feePlan[i]);
  }

  // 加入期末现金流（用于 XIRR）
  cashflows.push(finalValue);
  cashflowDates.push(endDateStr);

  // 计算年数
  const years = (new Date(endDate).getTime() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24 * 365.25);

  // CAGR
  const cagr = calcCAGR(finalValue, totalInvested, years);

  // XIRR
  const xirr = calcXIRR(cashflows, cashflowDates);

  // 逐年收益
  const yearly = [];
  const startYear = new Date(startDate).getFullYear();
  const endYear = new Date(endDate).getFullYear();

  // 逐年计算，跟踪每年底的累计份额
  const cumShares = assets.map(() => 0);
  for (let year = startYear; year <= endYear; year++) {
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;

    // 计算该年投入
    const yearInvested = investDates
      .filter(d => d.startsWith(`${year}-`))
      .length * totalAmount;

    // 计算该年新增的份额（按该年投资日期逐笔买入）
    for (const date of investDates) {
      if (!date.startsWith(`${year}-`)) continue;
      for (let i = 0; i < assets.length; i++) {
        const investAmt = totalAmount * assets[i].weight;
        const price = findPrice(i, date);
        if (price && price > 0) cumShares[i] += investShares(investAmt, price, feePlan[i]);
      }
    }

    // 计算该年末市值（用累计份额 × 年末价格）
    let yearEndValue = 0;
    for (let i = 0; i < assets.length; i++) {
      const price = findPrice(i, yearEnd) || 0;
      yearEndValue += cumShares[i] * price;
    }

    // 累计投入
    const cumulativeInvested = investDates
      .filter(d => d <= yearEnd)
      .length * totalAmount;

    // 年收益率 = (年末市值 - 年初市值 - 当年投入) / (年初市值 + 当年投入)
    let yearReturn = 0;
    if (year === startYear) {
      // 第一年: 年初市值=0，收益率用年末总值/累计投入-1
      yearReturn = cumulativeInvested > 0
        ? ((yearEndValue / cumulativeInvested) - 1)
        : 0;
    } else {
      const startValue = yearly[yearly.length - 1].value;
      yearReturn = startValue > 0
        ? (yearEndValue - startValue - yearInvested) / (startValue + yearInvested)
        : 0;
    }

    yearly.push({
      year,
      invested: cumulativeInvested,
      yearlyInvested: yearInvested,
      value: Math.round(yearEndValue * 100) / 100,
      return: Math.round(yearReturn * 10000) / 100,
    });
  }

  // 计算最大回撤、夏普比率等指标
  // 跟踪投资期+持有期的组合市值（按月采样，确保回撤有意义）
  const portfolioValues = [];
  const portfolioDates = [];
  const tempShares = assets.map(() => 0);
  // 定投日逐笔买入
  for (const date of investDates) {
    for (let i = 0; i < assets.length; i++) {
      const investAmt = totalAmount * assets[i].weight;
      const price = findPrice(i, date);
      if (price && price > 0) tempShares[i] += investShares(investAmt, price, feePlan[i]);
    }
    let value = 0;
    for (let i = 0; i < assets.length; i++) {
      const price = findPrice(i, date) || 0;
      value += tempShares[i] * price;
    }
    portfolioValues.push(value);
    portfolioDates.push(date);
  }
  // 持有期补充采样点（从投资期结束到期末，每月末取样一次，让回撤有数据）
  if (portfolioDates.length) {
    const lastInvestDate = portfolioDates[portfolioDates.length - 1];
    // 从投资期结束后第一个月起，到期末，逐月采样
    const sampleStart = new Date(lastInvestDate);
    sampleStart.setMonth(sampleStart.getMonth() + 1);
    let cur = new Date(sampleStart);
    const endDt = new Date(endDateStr);
    while (cur <= endDt) {
      const d = new Date(cur).toISOString().slice(0, 10);
      let value = 0;
      for (let i = 0; i < assets.length; i++) {
        const price = findPrice(i, d) || 0;
        value += tempShares[i] * price;
      }
      if (value > 0) {
        portfolioValues.push(value);
        portfolioDates.push(d);
      }
      cur.setMonth(cur.getMonth() + 1);
    }
  }

  // 最大回撤
  let peak = 0, maxDrawdown = 0;
  for (const v of portfolioValues) {
    if (v > peak) peak = v;
    const dd = (peak - v) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // 年化收益序列（用于夏普比率）
  const annualReturnSeries = yearly
    .filter(y => y.return !== 0 && y.year > startYear)
    .map(y => y.return / 100);

  // 年化波动率（基于年收益率的标准差）
  const avgReturn = annualReturnSeries.length > 0
    ? annualReturnSeries.reduce((s, r) => s + r, 0) / annualReturnSeries.length
    : 0;
  const variance = annualReturnSeries.length > 0
    ? annualReturnSeries.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / annualReturnSeries.length
    : 0;
  const annualVol = Math.sqrt(variance);

  // 夏普比率（假设无风险利率 2%）
  const riskFreeRate = 0.02;
  const sharpeRatio = annualVol > 0
    ? (avgReturn - riskFreeRate) / annualVol
    : 0;

  // 卡玛比率
  const calmarRatio = maxDrawdown > 0 && cagr > 0
    ? cagr / maxDrawdown
    : 0;

  // 最好/最差年份
  const yearReturns = yearly.filter(y => y.return !== 0).map(y => y.return);
  const bestYear = yearReturns.length > 0 ? Math.max(...yearReturns) : 0;
  const worstYear = yearReturns.length > 0 ? Math.min(...yearReturns) : 0;

  // 再平衡后逐年收益
  const rebalYearly = [];
  const rebalCumShares = assets.map(() => 0);
  for (let year = startYear; year <= endYear; year++) {
    const yearEnd = `${year}-12-31`;
    for (const date of investDates) {
      if (!date.startsWith(`${year}-`)) continue;
      for (let i = 0; i < assets.length; i++) {
        const investAmt = totalAmount * assets[i].weight;
        const price = findPrice(i, date);
        if (price && price > 0) rebalCumShares[i] += investShares(investAmt, price, feePlan[i]);
      }
    }
    for (let i = 0; i < assets.length; i++) {
      const divMap = divMaps[i];
      for (const [date, divAmt] of Object.entries(divMap)) {
        if (!date.startsWith(`${year}-`)) continue;
        const price = findPrice(i, date);
        if (price && price > 0) rebalCumShares[i] += rebalCumShares[i] * divAmt / price;
      }
    }
    for (const rbDate of rebalanceDates) {
      if (!rbDate.startsWith(`${year}-`)) continue;
      if (rbDate > yearEnd) continue;
      applyRebalance(rebalCumShares, assets, findPrice, rbDate);
    }
    let yearEndValue = 0;
    for (let i = 0; i < assets.length; i++) {
      const price = findPrice(i, yearEnd) || 0;
      yearEndValue += rebalCumShares[i] * price;
    }
    const cumulativeInvested = investDates.filter(d => d <= yearEnd).length * totalAmount;
    const yearInvested = investDates.filter(d => d.startsWith(`${year}-`)).length * totalAmount;
    let yearReturn = 0;
    if (year === startYear) {
      yearReturn = cumulativeInvested > 0 ? ((yearEndValue / cumulativeInvested) - 1) : 0;
    } else {
      const startValue = rebalYearly[rebalYearly.length - 1].value;
      yearReturn = startValue > 0 ? (yearEndValue - startValue - yearInvested) / (startValue + yearInvested) : 0;
    }
    rebalYearly.push({
      year, invested: cumulativeInvested, yearlyInvested: yearInvested,
      value: Math.round(yearEndValue * 100) / 100,
      return: Math.round(yearReturn * 10000) / 100,
    });
  }

  // 再平衡后最终指标
  const rebalCagr = calcCAGR(finalValue, totalInvested, years);
  const rebalFinalValue = (() => {
    let v = 0;
    for (let i = 0; i < assets.length; i++) {
      v += rebalShares[i] * (findPrice(i, endDateStr) || 0);
    }
    return v;
  })();
  const rebalCagrVal = calcCAGR(rebalFinalValue, totalInvested, years);
  const rebalReturns = rebalYearly.filter(y => y.return !== 0 && y.year > startYear).map(y => y.return / 100);
  const rebalAvgRet = rebalReturns.length > 0 ? rebalReturns.reduce((s, r) => s + r, 0) / rebalReturns.length : 0;
  const rebalVar = rebalReturns.length > 0 ? rebalReturns.reduce((s, r) => s + (r - rebalAvgRet) ** 2, 0) / rebalReturns.length : 0;
  const rebalVol = Math.sqrt(rebalVar);
  const rebalSharpe = rebalVol > 0 ? (rebalAvgRet - 0.02) / rebalVol : 0;
  // 再平衡后最大回撤
  const rebalPortValues = [];
  const rebalTempShares = assets.map(() => 0);
  for (const date of investDates) {
    for (let i = 0; i < assets.length; i++) {
      const investAmt = totalAmount * assets[i].weight;
      const price = findPrice(i, date);
      if (price && price > 0) rebalTempShares[i] += investShares(investAmt, price, feePlan[i]);
    }
    if (rebalanceDates.includes(date)) {
      applyRebalance(rebalTempShares, assets, findPrice, date);
    }
    let value = 0;
    for (let i = 0; i < assets.length; i++) value += rebalTempShares[i] * (findPrice(i, date) || 0);
    rebalPortValues.push(value);
  }
  let rebalPeak = 0, rebalDrawdown = 0;
  for (const v of rebalPortValues) {
    if (v > rebalPeak) rebalPeak = v;
    const dd = (rebalPeak - v) / rebalPeak;
    if (dd > rebalDrawdown) rebalDrawdown = dd;
  }

  return {
    totalInvested: Math.round(totalInvested * 100) / 100,
    finalValue: Math.round(finalValue * 100) / 100,
    grossValue: Math.round(grossValue * 100) / 100,
    totalFees: Math.round((grossValue - finalValue) * 100) / 100,
    multiple: totalInvested > 0 ? Math.round((finalValue / totalInvested) * 100) / 100 : 0,
    cagr: Math.round(cagr * 10000) / 100,
    xirr: Math.round(xirr * 10000) / 100,
    sharpeRatio: Math.round(sharpeRatio * 100) / 100,
    maxDrawdown: Math.round(maxDrawdown * 10000) / 100,
    annualVol: Math.round(annualVol * 10000) / 100,
    calmarRatio: Math.round(calmarRatio * 100) / 100,
    bestYear: Math.round(bestYear * 100) / 100,
    worstYear: Math.round(worstYear * 100) / 100,
    yearly,
    rebalanced: {
      finalValue: Math.round(rebalFinalValue * 100) / 100,
      totalInvested: Math.round(totalInvested * 100) / 100,
      multiple: totalInvested > 0 ? Math.round((rebalFinalValue / totalInvested) * 100) / 100 : 0,
      cagr: Math.round(rebalCagrVal * 10000) / 100,
      sharpeRatio: Math.round(rebalSharpe * 100) / 100,
      maxDrawdown: Math.round(rebalDrawdown * 10000) / 100,
      annualVol: Math.round(rebalVol * 10000) / 100,
      yearly: rebalYearly,
    },
  };
}

// 批量回测（多方案对比）
// schemes: [{ label, assets, amount, frequency, startDate, endDate, rebalance, investMode, investEndDate }]
export function compareBacktests(schemes) {
  return schemes.map(s => {
    const { label, ...config } = s;
    const result = runBacktest(config);
    return { label, ...result };
  });
}

// 定投时机分布（错开起始日滚动回测）
// config: { assets, amount, frequency, holdYears, step, endDate, rebalance, investEndDate, fees }
// step: 'yearly'(每年1月1日) | 'monthly'(每月1日)
export function rollingStartBacktest(config) {
  const { assets, amount, frequency, holdYears, step, endDate, rebalance, investEndDate, fees } = config;
  const results = [];
  const endDt = new Date(endDate);

  // 起始日范围：最早从数据可用年份开始，到 endDate - holdYears
  // 简化：从 endDate 往前推 30 年作为最早可选起始
  const startWindow = 30;
  const latestStart = new Date(endDt);
  latestStart.setFullYear(latestStart.getFullYear() - holdYears);
  const earliestStart = new Date(endDt);
  earliestStart.setFullYear(earliestStart.getFullYear() - holdYears - startWindow);

  // 生成所有候选起始日
  const candidates = [];
  if (step === 'monthly') {
    let cur = new Date(earliestStart.getFullYear(), 0, 1);
    while (cur <= latestStart) {
      candidates.push(new Date(cur).toISOString().slice(0, 10));
      cur.setMonth(cur.getMonth() + 1);
    }
  } else {
    for (let y = earliestStart.getFullYear(); y <= latestStart.getFullYear(); y++) {
      candidates.push(`${y}-01-01`);
    }
  }

  for (const startDate of candidates) {
    const holdEnd = new Date(startDate);
    holdEnd.setFullYear(holdEnd.getFullYear() + holdYears);
    const holdEndStr = holdEnd.toISOString().slice(0, 10);
    // 持有结束不能超过 endDate
    if (holdEndStr > endDate) continue;
    try {
      const result = runBacktest({
        assets,
        amount, frequency,
        startDate, endDate: holdEndStr,
        rebalance: rebalance || 'none',
        investMode: 'dca',
        investEndDate,
        fees,
      });
      results.push({
        startDate,
        endDate: holdEndStr,
        totalInvested: result.totalInvested,
        finalValue: result.finalValue,
        cagr: result.cagr,
        multiple: result.multiple,
        xirr: result.xirr,
      });
    } catch (e) {
      // 跳过无法回测的起始日
    }
  }

  if (!results.length) return { success: false, error: '无可回测的起始日，请检查持有年限' };

  // 统计分布
  const cagrs = results.map(r => r.cagr).filter(v => v != null);
  cagrs.sort((a, b) => a - b);
  const sorted = results.slice().sort((a, b) => a.cagr - b.cagr);

  const q = (arr, pct) => {
    if (!arr.length) return null;
    const idx = Math.min(arr.length - 1, Math.floor(arr.length * pct));
    return arr[idx];
  };

  return {
    success: true,
    count: results.length,
    best: sorted[sorted.length - 1] || null,
    worst: sorted[0] || null,
    median: q(cagrs, 0.5),
    p25: q(cagrs, 0.25),
    p75: q(cagrs, 0.75),
    avgCagr: cagrs.length ? Math.round(cagrs.reduce((s, v) => s + v, 0) / cagrs.length * 100) / 100 : null,
    results,
  };
}