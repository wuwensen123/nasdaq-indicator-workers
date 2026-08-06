/**
 * nasdaq-indicator — Cloudflare Worker
 * 提供数据 API，前端由 Cloudflare Pages 托管
 * 定时缓存到 D1 数据库，秒级响应
 */

import { Fetcher } from './fetchers.js';
import { Analyzer } from './analyzer.js';

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

// 初始化数据库表
async function initDB(env) {
  if (!env.nasdaq_cache) return;
  try {
    await env.nasdaq_cache.prepare(`
      CREATE TABLE IF NOT EXISTS market_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        data TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
  } catch (e) {
    console.error('DB init error:', e.message);
  }
}

// 从 D1 读取缓存
async function getCache(env) {
  if (!env.nasdaq_cache) return null;
  try {
    const result = await env.nasdaq_cache.prepare(
      'SELECT data, fetched_at FROM market_cache ORDER BY id DESC LIMIT 1'
    ).first();
    if (result) {
      return { data: JSON.parse(result.data), fetched_at: result.fetched_at };
    }
  } catch {}
  return null;
}

// 写入 D1 缓存
async function setCache(env, data, fetchedAt) {
  if (!env.nasdaq_cache) return;
  try {
    // 清空旧数据，保留最近1条
    await env.nasdaq_cache.prepare('DELETE FROM market_cache WHERE id NOT IN (SELECT id FROM market_cache ORDER BY id DESC LIMIT 1)').run();
    await env.nasdaq_cache.prepare(
      'INSERT INTO market_cache (data, fetched_at) VALUES (?, ?)'
    ).bind(JSON.stringify(data), fetchedAt).run();
  } catch (e) {
    console.error('DB write error:', e.message);
  }
}

// 获取新鲜数据（实时抓取）
async function fetchFreshData() {
  const fetcher = new Fetcher();
  const analyzer = new Analyzer();
  const start = Date.now();
  const targets = analyzer.getTargets();

  const [vix, fearGreed, treasury, putCall, dxy, shillerPE] = await Promise.all([
    fetcher.getVIX(), fetcher.getFearGreed(), fetcher.getTreasuryYield(),
    fetcher.getPutCallRatio(), fetcher.getDXY(), fetcher.getShillerPE(),
  ]);

  const globalData = {
    vix, fear_greed: fearGreed, treasury_10y: treasury,
    put_call_ratio: putCall, dxy, shiller_pe: shillerPE,
    updated_at: new Date().toISOString(),
  };

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
    refreshed: false,
  };
}

export default {
  // 初始化
  async start(env) {
    await initDB(env);
  },

  // HTTP 请求处理
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    const url = new URL(request.url);
    const path = url.pathname;

    // 确保数据库已初始化
    await initDB(env);

    // 健康检查
    if (path === '/api/health') {
      return json({ status: 'ok', server_time: new Date().toISOString() });
    }

    // 数据 API
    if (path === '/api/data' || path === '/api/refresh') {
      const isRefresh = path === '/api/refresh';

      // 强制刷新：实时抓取并更新缓存
      if (isRefresh) {
        try {
          const freshData = await fetchFreshData();
          await setCache(env, freshData, freshData.fetched_at);
          freshData.refreshed = true;
          freshData.from_cache = false;
          return json(freshData);
        } catch (e) {
          return error(e.message);
        }
      }

      // 普通请求：优先从缓存读取
      try {
        const cached = await getCache(env);
        if (cached) {
          cached.data.from_cache = true;
          cached.data.cached_at = cached.fetched_at;
          return json(cached.data);
        }
      } catch {}

      // 无缓存：实时抓取
      try {
        const freshData = await fetchFreshData();
        // 异步写入缓存，不阻塞响应
        ctx.waitUntil(setCache(env, freshData, freshData.fetched_at));
        return json(freshData);
      } catch (e) {
        return error(e.message);
      }
    }

    return error('Not found', 404);
  },

  // 定时任务（每天 7:30 和 13:30 自动抓取数据）
  async scheduled(event, env, ctx) {
    await initDB(env);
    console.log(`[Scheduler] 开始定时抓取数据 at ${new Date().toISOString()}`);
    try {
      const freshData = await fetchFreshData();
      await setCache(env, freshData, freshData.fetched_at);
      console.log(`[Scheduler] 数据抓取完成，耗时 ${freshData.fetch_time_seconds}s`);
    } catch (e) {
      console.error(`[Scheduler] 抓取失败: ${e.message}`);
    }
  },
};