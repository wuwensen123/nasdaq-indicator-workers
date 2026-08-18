/**
 * 邮件通知模块 — 通过 Resend API 发送
 * 只有当存在溢价率 < 阈值的基金时才发邮件
 */

async function sendEmail(env, to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
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
    throw new Error(`Resend ${res.status}: ${text}`);
  }
  return res.json();
}

function buildEmailHTML(results, threshold) {
  const low = results.filter(r => r.premium != null && r.premium < threshold);
  let rows = results.map(r => {
    const prem = r.premium != null ? r.premium.toFixed(2) + '%' : 'N/A';
    const cls = r.premium != null && r.premium < threshold ? 'color:#2da44e;font-weight:bold;' : 'color:#cf222e;';
    return `<tr><td style="padding:6px 12px;">${r.name}</td><td style="padding:6px 12px;">${r.code}</td><td style="padding:6px 12px;">${r.nav || '--'}</td><td style="padding:6px 12px;">${r.price || '--'}</td><td style="padding:6px 12px;${cls}">${prem}</td></tr>`;
  }).join('');

  return `<html><body style="font-family:sans-serif;">
<h2 style="color:#1a1a2e;">QDII ETF 溢价率日报</h2>
<p style="color:#586069;">${new Date().toISOString().slice(0,16).replace('T',' ')} UTC</p>
<div style="background:#e6f4ea;border:1px solid #2da44e;border-radius:8px;padding:12px 16px;margin:16px 0;">
<strong style="color:#2da44e;">✅ ${low.length} 只基金溢价率 < ${threshold}%，可关注买入机会</strong>
</div>
<table style="border-collapse:collapse;width:100%;font-size:14px;">
<thead><tr style="background:#f0f2f5;"><th style="padding:8px 12px;">基金名称</th><th style="padding:8px 12px;">代码</th><th style="padding:8px 12px;">净值</th><th style="padding:8px 12px;">现价</th><th style="padding:8px 12px;">溢价率</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<p style="color:#8b949e;font-size:12px;margin-top:16px;">数据来源：东方财富 + 腾讯行情 | 本邮件由 Cloudflare Worker 自动发送</p>
</body></html>`;
}

export async function checkQDIIAndNotify(env) {
  const { fetchQDII } = await import('./qdii.js');
  const data = await fetchQDII();
  const results = data.results || [];
  const threshold = parseFloat(env.PREMIUM_THRESHOLD || '3');
  const receivers = (env.RECEIVER_EMAILS || '').split(',').filter(Boolean);

  const lowPremium = results.filter(r => r.premium != null && r.premium < threshold);

  // 没有低溢价基金 → 不发邮件
  if (lowPremium.length === 0) {
    return { sent: false, lowCount: 0, total: results.length, message: `无低溢价基金(${results.length}只全部>=${threshold}%)，跳过邮件` };
  }

  // 有低溢价基金 → 发邮件
  const subject = `✅ ${lowPremium.length} 只 QDII ETF 溢价率低于 ${threshold}%`;
  const html = buildEmailHTML(results, threshold);

  try {
    await sendEmail(env, receivers, subject, html);
    return { sent: true, lowCount: lowPremium.length, total: results.length, message: `邮件已发送，${lowPremium.length}/${results.length} 只基金溢价率 < ${threshold}%` };
  } catch (e) {
    return { sent: false, lowCount: lowPremium.length, total: results.length, message: `邮件发送失败: ${e.message}` };
  }
}