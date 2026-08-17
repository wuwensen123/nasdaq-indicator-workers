/**
 * QDII ETF 溢价率查询模块
 * 数据源：东方财富 fund.eastmoney.com + 腾讯行情 qt.gtimg.cn
 */

const FUND_LIST = [
  { code: '159509', name: '纳指科技ETF景顺' },
  { code: '159501', name: '纳指ETF嘉实' },
  { code: '513100', name: '纳指ETF国泰' },
  { code: '159941', name: '纳指ETF广发' },
  { code: '159696', name: '纳指ETF易方达' },
  { code: '159659', name: '纳斯达克100ETF招商' },
  { code: '513300', name: '纳斯达克ETF华夏' },
  { code: '159513', name: '纳斯达克100ETF大成' },
  { code: '513870', name: '纳指ETF富国' },
  { code: '159632', name: '纳斯达克ETF华安' },
  { code: '159660', name: '纳指ETF汇添富' },
  { code: '513110', name: '纳指ETF华泰柏瑞' },
  { code: '513390', name: '纳指100ETF博时' },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchText(url, referer) {
  const headers = { 'User-Agent': UA };
  if (referer) headers['Referer'] = referer;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// 获取基金净值 + 近1年收益率
async function fetchFundNav(code) {
  try {
    const text = await fetchText(`https://fund.eastmoney.com/pingzhongdata/${code}.js`, 'https://fund.eastmoney.com');
    let nav = null, return1y = null, navDate = null;
    // 提取 syl_1n（近1年收益率）
    const sylMatch = text.match(/syl_1n\s*=\s*"?([\d.\-]+)"?/);
    if (sylMatch) return1y = parseFloat(sylMatch[1]);
    // 提取 Data_netWorthTrend 中的净值和日期
    const trendMatch = text.match(/Data_netWorthTrend\s*=\s*\[(.*?)\];/s);
    if (trendMatch) {
      const yMatches = [...trendMatch[1].matchAll(/"y":([\d.]+)/g)];
      if (yMatches.length > 0) nav = parseFloat(yMatches[yMatches.length - 1][1]);
      // 提取日期
      const xMatches = [...trendMatch[1].matchAll(/"x":(\d+)/g)];
      if (xMatches.length > 0) {
        const ts = parseInt(xMatches[xMatches.length - 1][1]);
        navDate = new Date(ts).toISOString().slice(0, 10);
      }
    }
    return { nav, return_1y: return1y, nav_date: navDate };
  } catch { return { nav: null, return_1y: null, nav_date: null }; }
}

// 获取纳斯达克100指数涨跌幅
async function fetchIndexChange() {
  try {
    const text = await fetchText('https://qt.gtimg.cn/q=s_usNDX');
    const m = text.match(/v_s_usNDX="(.+?)"/);
    if (m) {
      const parts = m[1].split('~');
      if (parts.length >= 6) return parseFloat(parts[5]) || 0;
    }
  } catch {}
  return 0;
}

// 批量获取ETF行情
async function fetchETFQuotes(codes) {
  const result = {};
  // 构造 secid 列表
  const secids = codes.map(c => (c.startsWith('5') ? 'sh' : 'sz') + c);
  try {
    const text = await fetchText(`https://qt.gtimg.cn/q=${secids.join(',')}`);
    const lines = text.split(';').filter(l => l.trim());
    for (const line of lines) {
      const m = line.match(/v_(\w+)="(.+?)"/);
      if (!m) continue;
      const rawCode = m[1];
      const body = m[2].split('~');
      if (body.length < 5) continue;
      const code = /^\d{6}$/.test(body[2]) ? body[2] : rawCode.replace(/^(sh|sz)/, '');
      result[code] = {
        name: body[1],
        price: parseFloat(body[3]) || null,
        prev_close: parseFloat(body[4]) || null,
      };
    }
  } catch {}
  return result;
}

// 主函数：获取所有 QDII ETF 溢价数据
export async function fetchQDII() {
  const start = Date.now();
  const codes = FUND_LIST.map(f => f.code);

  // 并行获取：指数涨跌 + ETF行情
  const [indexChange, quotes] = await Promise.all([
    fetchIndexChange(),
    fetchETFQuotes(codes),
  ]);

  // 并行获取每只基金的净值
  const fundData = await Promise.all(codes.map(c => fetchFundNav(c)));

  // 组装结果
  const results = FUND_LIST.map((f, i) => {
    const q = quotes[f.code] || {};
    const fd = fundData[i] || {};
    const price = q.price || null;
    const prevClose = q.prev_close || null;
    const nav = fd.nav || null;
    // 日涨幅
    const dailyChange = (price && prevClose) ? Math.round(((price - prevClose) / prevClose) * 10000) / 100 : null;
    // 溢价率
    const premium = (price && nav) ? Math.round(((price - nav) / nav) * 10000) / 100 : null;
    // 跟踪误差
    const trackError = dailyChange != null ? Math.round(Math.abs(dailyChange - indexChange) * 100) / 100 : null;
    return {
      code: f.code,
      name: f.name,
      index_name: '纳斯达克100',
      nav,
      nav_date: fd.nav_date,
      price,
      prev_close: prevClose,
      change_pct: dailyChange,
      premium,
      track_error: trackError,
      return_1y: fd.return_1y,
    };
  });

  // 按溢价率降序排列
  results.sort((a, b) => {
    if (a.premium === null && b.premium === null) return 0;
    if (a.premium === null) return 1;
    if (b.premium === null) return -1;
    return b.premium - a.premium;
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  return {
    success: true,
    results,
    index_change: indexChange,
    fetched_at: new Date().toISOString(),
    fetch_time_seconds: parseFloat(elapsed),
    total: results.length,
  };
}