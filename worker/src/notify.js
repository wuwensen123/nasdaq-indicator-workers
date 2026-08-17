/**
 * 邮件通知模块 — 使用 Cloudflare Workers 发送邮件
 * 通过外部 SMTP 中转服务发送（Cloudflare Workers 不支持原生 SMTP）
 * 使用 Resend API 免费层（每月 3000 封）
 * 如果没有 Resend API Key，则降级为 Webhook 通知
 */

// 通过 Resend API 发送邮件
async function sendEmailResend(to, subject, html, apiKey) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'QDII Monitor <onboarding@resend.dev>',
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend API ${res.status}: ${text}`);
  }
  return await res.json();
}

// 通过 SMTP 中转发送（使用第三方 SMTP relay）
async function sendEmailSMTP(config, to, subject, html) {
  // 使用 Mailgun-style API 或直接 SMTP
  // Cloudflare Workers 不能直接 TCP 连接 SMTP，所以用 HTTP relay
  // 这里用 Brevo (Sendinblue) 免费 API 作为 SMTP relay
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': config.SENDER_PASSWORD, // Brevo API key 复用此字段
    },
    body: JSON.stringify({
      sender: { name: 'QDII Monitor', email: config.SENDER_EMAIL },
      to: (Array.isArray(to) ? to : [to]).map(email => ({ email })),
      subject,
      htmlContent: html,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brevo API ${res.status}: ${text}`);
  }
  return await res.json();
}

// 构建邮件 HTML 内容
function buildEmailHTML(results, threshold) {
  const low = results.filter(r => r.premium != null && r.premium < threshold);
  const high = results.filter(r => r.premium != null && r.premium >= threshold);

  let rows = results.map(r => {
    const prem = r.premium != null ? r.premium.toFixed(2) + '%' : 'N/A';
    const cls = r.premium != null && r.premium < threshold ? 'color:#2da44e;font-weight:bold;' : 'color:#cf222e;';
    return `<tr>
      <td style="padding:6px 12px;">${r.name}</td>
      <td style="padding:6px 12px;">${r.code}</td>
      <td style="padding:6px 12px;">${r.nav ? r.nav.toFixed(4) : '--'}</td>
      <td style="padding:6px 12px;">${r.price ? r.price.toFixed(3) : '--'}</td>
      <td style="padding:6px 12px;${cls}">${prem}</td>
    </tr>`;
  }).join('');

  return `
  <html><body style="font-family:sans-serif;">
  <h2 style="color:#1a1a2e;">📊 QDII ETF 溢价率日报</h2>
  <p style="color:#586069;">${new Date().toISOString().slice(0,16).replace('T',' ')} UTC</p>

  ${low.length > 0 ? `
  <div style="background:#e6f4ea;border:1px solid #2da44e;border-radius:8px;padding:12px 16px;margin:16px 0;">
    <strong style="color:#2da44e;">✅ ${low.length} 只基金溢价率 < ${threshold}%，可关注买入机会</strong>
  </div>` : ''}

  ${high.length > 0 ? `
  <div style="background:#fce8e6;border:1px solid #cf222e;border-radius:8px;padding:12px 16px;margin:16px 0;">
    <strong style="color:#cf222e;">⚠️ ${high.length} 只基金溢价率 ≥ ${threshold}%，买入需谨慎</strong>
  </div>` : ''}

  <table style="border-collapse:collapse;width:100%;font-size:14px;">
    <thead>
      <tr style="background:#f0f2f5;">
        <th style="padding:8px 12px;text-align:left;">基金名称</th>
        <th style="padding:8px 12px;text-align:left;">代码</th>
        <th style="padding:8px 12px;text-align:left;">最新净值</th>
        <th style="padding:8px 12px;text-align:left;">现价</th>
        <th style="padding:8px 12px;text-align:left;">溢价率</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <p style="color:#8b949e;font-size:12px;margin-top:16px;">
    数据来源：东方财富 fund.eastmoney.com + 腾讯行情 qt.gtimg.cn<br>
    溢价率 = (现价 - 净值) / 净值 × 100%<br>
    QDII 净值通常延迟 1-2 个交易日，实际溢价率可能略有偏差<br>
    本邮件由 Cloudflare Worker 自动发送，仅供参考，不构成投资建议
  </p>
  </body></html>`;
}

/**
 * 主函数：检查 QDII 溢价率并发送邮件通知
 * @param {Object} env - Worker 环境变量
 * @returns {Object} { sent: bool, lowCount: int, total: int }
 */
export async function checkQDIIAndNotify(env) {
  const { fetchQDII } = await import('./qdii.js');
  const data = await fetchQDII();
  const results = data.results || [];
  const threshold = parseFloat(env.PREMIUM_THRESHOLD || '3');

  const lowPremium = results.filter(r => r.premium != null && r.premium < threshold);

  // 构建邮件
  const subject = lowPremium.length > 0
    ? `✅ ${lowPremium.length} 只 QDII ETF 溢价率低于 ${threshold}%`
    : `📊 QDII ETF 溢价率日报（全部 ≥ ${threshold}%）`;

  const html = buildEmailHTML(results, threshold);
  const receivers = (env.RECEIVER_EMAILS || '').split(',').filter(Boolean);

  // 尝试发送邮件
  let sent = false;
  let method = '';

  // 方案1: 用 Resend API（如果有 RESEND_API_KEY）
  if (env.RESEND_API_KEY) {
    try {
      await sendEmailResend(receivers, subject, html, env.RESEND_API_KEY);
      sent = true;
      method = 'Resend';
    } catch (e) {
      console.error('Resend failed:', e.message);
    }
  }

  // 方案2: 直接用 Webhook（如果有 WEBHOOK_URL）
  if (!sent && env.WEBHOOK_URL) {
    try {
      await fetch(env.WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, html, results: lowPremium }),
      });
      sent = true;
      method = 'Webhook';
    } catch (e) {
      console.error('Webhook failed:', e.message);
    }
  }

  // 方案3: 用 Server Send API（免费，无需注册）
  if (!sent) {
    try {
      const res = await fetch('https://api.serversend.com/v1/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.SENDER_EMAIL || 'noreply@qdii.monitor',
          to: receivers,
          subject,
          html,
        }),
      });
      if (res.ok) { sent = true; method = 'ServerSend'; }
      else { throw new Error(`HTTP ${res.status}`); }
    } catch (e) {
      console.error('ServerSend failed:', e.message);
    }
  }

  return {
    sent,
    method,
    lowCount: lowPremium.length,
    total: results.length,
    message: sent
      ? `邮件已通过 ${method} 发送，${lowPremium.length}/${results.length} 只基金溢价率 < ${threshold}%`
      : `邮件发送失败（无可用邮件服务），${lowPremium.length}/${results.length} 只基金溢价率 < ${threshold}%`,
  };
}