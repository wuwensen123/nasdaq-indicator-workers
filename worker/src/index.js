/**
 * nasdaq-indicator — Cloudflare Worker
 * 提供数据 API，前端由 Cloudflare Pages 托管
 */

import { Fetcher } from './fetchers.js';
import { Analyzer } from './analyzer.js';

const fetcher = new Fetcher();
const analyzer = new Analyzer();

// CORS 头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
  });
}

function error(msg, status = 500) {
  return json({ success: false, error: msg }, status);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    const url = new URL(request.url);
    const path = url.pathname;

    // 健康检查
    if (path === '/api/health') {
      return json({ status: 'ok', server_time: new Date().toISOString() });
    }

    // 数据 API
    if (path === '/api/data' || path === '/api/refresh') {
      const isRefresh = path === '/api/refresh';
      try {
        const data = await fetchAllData(isRefresh);
        return json(data);
      } catch (e) {
        return error(e.message);
      }
    }

    // 未知路径
    return error('Not found', 404);
  },
};

async function fetchAllData(forceRefresh = false) {
  const start = Date.now();
  const targets = analyzer.getTargets();

  // 并行获取全局数据
  const [vix, fearGreed, treasury, putCall, dxy, shillerPE] = await Promise.all([
    fetcher.getVIX(),
    fetcher.getFearGreed(),
    fetcher.getTreasuryYield(),
    fetcher.getPutCallRatio(),
    fetcher.getDXY(),
    fetcher.getShillerPE(),
  ]);

  const globalData = {
    vix, fear_greed: fearGreed, treasury_10y: treasury,
    put_call_ratio: putCall, dxy, shiller_pe: shillerPE,
    updated_at: new Date().toISOString(),
  };

  // 并行获取每个标的的技术指标
  const targetsData = {};
  const results = [];

  for (const t of targets) {
    const tech = await fetcher.getTechnicalIndicators(t.symbol);
    const pe = await fetcher.getPERatio(t.symbol, t.name);
    targetsData[t.id] = {
      name: t.name, symbol: t.symbol,
      current_price: tech.current_price,
      pe_ratio: pe.value, technical: tech, pe_data: pe,
    };
  }

  // 运行分析
  for (const t of targets) {
    const result = analyzer.analyzeTarget(t.id, targetsData, globalData);
    if (result) results.push(result);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  return {
    success: true,
    global_summary: {
      vix: { value: vix?.value, change: vix?.change, label: 'VIX波动率指数', source: vix?.source, updated_at: vix?.updated_at },
      fear_greed: { value: fearGreed?.value, label: fearGreed?.label, source: fearGreed?.source, updated_at: fearGreed?.updated_at },
      treasury_10y: { value: treasury?.value, change: treasury?.change, label: '10年期国债收益率', source: treasury?.source, updated_at: treasury?.updated_at },
      put_call_ratio: { value: putCall?.value, label: putCall?.label, source: putCall?.source, updated_at: putCall?.updated_at },
      dxy: { value: dxy?.value, change: dxy?.change, label: '美元指数DXY', source: dxy?.source, updated_at: dxy?.updated_at },
      shiller_pe: { value: shillerPE?.value, label: 'Shiller CAPE比率', source: shillerPE?.source, updated_at: shillerPE?.updated_at },
    },
    analysis: { results, global_data: globalData, total_targets: results.length, fetched_at: new Date().toISOString(), fetch_time_seconds: parseFloat(elapsed) },
    fetched_at: new Date().toISOString(),
    fetch_time_seconds: parseFloat(elapsed),
    server_time: new Date().toISOString(),
    refreshed: forceRefresh,
  };
}