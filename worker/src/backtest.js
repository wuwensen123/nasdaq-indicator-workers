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
function getInvestDates(frequency, startDate, endDate) {
  const dates = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  const current = new Date(start);

  if (frequency === 'monthly') {
    while (current <= end) {
      dates.push(new Date(current).toISOString().slice(0, 10));
      current.setMonth(current.getMonth() + 1);
    }
  } else if (frequency === 'weekly') {
    while (current <= end) {
      dates.push(new Date(current).toISOString().slice(0, 10));
      current.setDate(current.getDate() + 7);
    }
  } else if (frequency === 'quarterly') {
    while (current <= end) {
      dates.push(new Date(current).toISOString().slice(0, 10));
      current.setMonth(current.getMonth() + 3);
    }
  }
  return dates;
}

// 主回测函数
export function runBacktest(config) {
  const { assets, amount, frequency, startDate, endDate } = config;
  // assets: [{ symbol, weight, prices[], dates[], dividends{} }]
  // amount: 每次定投总金额
  // weight: 该标的占比（小数，如 0.5）

  if (!assets.length || !amount) return null;

  const totalAmount = amount;
  const investDates = getInvestDates(frequency, startDate, endDate);

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
        shares[i] += investAmt / price;
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

  // 计算总投入
  const totalInvested = cashflows.reduce((s, v) => s + Math.abs(v), 0);

  // 计算期末价值
  const endDateStr = new Date(endDate).toISOString().slice(0, 10);
  let finalValue = 0;
  for (let i = 0; i < assets.length; i++) {
    // 找最后一个交易日价格
    const lastPrice = findPrice(i, endDateStr) || 0;
    finalValue += shares[i] * lastPrice;
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
        if (price && price > 0) cumShares[i] += investAmt / price;
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
  // 跟踪每个投资日期的组合市值
  const portfolioValues = [];
  const portfolioDates = [];
  const tempShares = assets.map(() => 0);
  for (const date of investDates) {
    for (let i = 0; i < assets.length; i++) {
      const investAmt = totalAmount * assets[i].weight;
      const price = findPrice(i, date);
      if (price && price > 0) tempShares[i] += investAmt / price;
    }
    let value = 0;
    for (let i = 0; i < assets.length; i++) {
      const price = findPrice(i, date) || 0;
      value += tempShares[i] * price;
    }
    portfolioValues.push(value);
    portfolioDates.push(date);
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

  return {
    totalInvested: Math.round(totalInvested * 100) / 100,
    finalValue: Math.round(finalValue * 100) / 100,
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
  };
}