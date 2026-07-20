import * as nodemailer from 'nodemailer';
import { getEmailConfig } from './ssm-config';

/**
 * Create a transporter on demand using SSM-sourced credentials.
 * Cached internally by getEmailConfig() (5-min TTL).
 */
async function getTransporter(): Promise<{ transporter: nodemailer.Transporter | null; user: string; recipient: string }> {
  const config = await getEmailConfig();
  if (!config.gmailUser || !config.gmailAppPassword) {
    return { transporter: null, user: '', recipient: '' };
  }
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: config.gmailUser, pass: config.gmailAppPassword },
  });
  return { transporter, user: config.gmailUser, recipient: config.notificationEmail };
}

function emailWrapper(content: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5ede4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px">
    <!-- Header -->
    <div style="background:linear-gradient(135deg,#4A2C17 0%,#6B4226 50%,#8B5E3C 100%);border-radius:16px 16px 0 0;padding:24px 28px;text-align:center">
      <h1 style="color:#fff;margin:0;font-size:1.4rem;font-weight:700">☕ oneFIVEthree Café</h1>
      <p style="color:rgba(255,255,255,.7);margin:6px 0 0;font-size:.85rem">Oasis of Care (RLC), Petaling Jaya</p>
    </div>
    <!-- Body -->
    <div style="background:#ffffff;padding:28px;border-radius:0 0 16px 16px;box-shadow:0 4px 12px rgba(74,44,23,.08)">
      ${content}
    </div>
    <!-- Footer -->
    <div style="text-align:center;padding:16px;font-size:.75rem;color:#9CA3AF">
      <p>This is an automated notification from the 153 Café POS system.</p>
      <p>Manage settings at <a href="https://153.oasisofcare.org/admin.html" style="color:#6B4226">153.oasisofcare.org/admin</a></p>
    </div>
  </div>
</body></html>`;
}

export async function sendEmail(subject: string, html: string): Promise<boolean> {
  const { transporter, user, recipient } = await getTransporter();
  if (!transporter || !recipient) {
    console.log('[EMAIL] Not configured, skipping:', subject);
    return false;
  }

  try {
    await transporter.sendMail({
      from: `"153 Café POS" <${user}>`,
      to: recipient,
      subject,
      html,
    });
    console.log('[EMAIL] Sent:', subject);
    return true;
  } catch (err) {
    console.error('[EMAIL] Failed:', err);
    return false;
  }
}

export async function sendLowStockAlert(items: { name: string; currentStock: number; unit: string; threshold: number }[]): Promise<boolean> {
  const itemRows = items.map(i =>
    `<tr>
      <td style="padding:12px 14px;border-bottom:1px solid #f5ede4;font-weight:500">${i.name}</td>
      <td style="padding:12px 14px;border-bottom:1px solid #f5ede4;text-align:center;color:#C0392B;font-weight:700">${i.currentStock} ${i.unit}</td>
      <td style="padding:12px 14px;border-bottom:1px solid #f5ede4;text-align:center;color:#7A6355">${i.threshold} ${i.unit}</td>
    </tr>`
  ).join('');

  const content = `
    <div style="text-align:center;margin-bottom:20px">
      <div style="display:inline-block;background:#FEF3C7;border-radius:50%;width:48px;height:48px;line-height:48px;font-size:1.5rem">⚠️</div>
      <h2 style="color:#6B4226;margin:12px 0 4px;font-size:1.3rem">Low Stock Alert</h2>
      <p style="color:#7A6355;margin:0;font-size:.9rem">${items.length} item${items.length>1?'s':''} running low</p>
    </div>
    <table style="width:100%;border-collapse:collapse;margin:20px 0;border:1px solid #f5ede4;border-radius:10px;overflow:hidden">
      <thead>
        <tr style="background:#f9f5f0">
          <th style="padding:10px 14px;text-align:left;font-size:.8rem;text-transform:uppercase;color:#7A6355;letter-spacing:.5px">Item</th>
          <th style="padding:10px 14px;text-align:center;font-size:.8rem;text-transform:uppercase;color:#C0392B;letter-spacing:.5px">Current</th>
          <th style="padding:10px 14px;text-align:center;font-size:.8rem;text-transform:uppercase;color:#7A6355;letter-spacing:.5px">Threshold</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
    </table>
    <div style="background:#FEF3C7;border-radius:10px;padding:14px 18px;margin-top:16px">
      <p style="margin:0;font-size:.9rem;color:#92400E"><strong>Action needed:</strong> Please restock before next Sunday's service.</p>
    </div>`;

  return sendEmail(`⚠️ Low Stock: ${items.length} item${items.length>1?'s':''} need restocking`, emailWrapper(content));
}

export async function sendEndOfDaySummary(data: {
  date: string;
  totalOrders: number;
  totalRevenue: number;
  totalOffsets: number;
  netExpected: number;
  newcomersServed: number;
  topItems: { name: string; qty: number }[];
  lowStockItems: { name: string; currentStock: number; unit: string }[];
}): Promise<boolean> {
  const statsHtml = `
    <div style="display:flex;flex-wrap:wrap;gap:12px;margin:20px 0">
      <div style="flex:1;min-width:120px;background:#f9f5f0;border-radius:10px;padding:16px;text-align:center">
        <div style="font-size:1.6rem;font-weight:800;color:#6B4226">${data.totalOrders}</div>
        <div style="font-size:.75rem;color:#7A6355;text-transform:uppercase;letter-spacing:.5px;margin-top:4px">Orders</div>
      </div>
      <div style="flex:1;min-width:120px;background:#f9f5f0;border-radius:10px;padding:16px;text-align:center">
        <div style="font-size:1.6rem;font-weight:800;color:#2D8A4E">RM${data.netExpected.toFixed(0)}</div>
        <div style="font-size:.75rem;color:#7A6355;text-transform:uppercase;letter-spacing:.5px;margin-top:4px">Net Revenue</div>
      </div>
      <div style="flex:1;min-width:120px;background:#f9f5f0;border-radius:10px;padding:16px;text-align:center">
        <div style="font-size:1.6rem;font-weight:800;color:#6B4226">${data.newcomersServed}</div>
        <div style="font-size:.75rem;color:#7A6355;text-transform:uppercase;letter-spacing:.5px;margin-top:4px">Newcomers</div>
      </div>
    </div>`;

  const breakdownHtml = `
    <table style="width:100%;border-collapse:collapse;margin:16px 0">
      <tr><td style="padding:8px 0;color:#7A6355">Gross Revenue</td><td style="padding:8px 0;text-align:right;font-weight:600">RM ${data.totalRevenue.toFixed(2)}</td></tr>
      <tr><td style="padding:8px 0;color:#7A6355">Discounts & Offsets</td><td style="padding:8px 0;text-align:right;font-weight:600;color:#C0392B">- RM ${data.totalOffsets.toFixed(2)}</td></tr>
      <tr style="border-top:2px solid #f5ede4"><td style="padding:10px 0;font-weight:700">Net Expected</td><td style="padding:10px 0;text-align:right;font-weight:800;font-size:1.1rem;color:#2D8A4E">RM ${data.netExpected.toFixed(2)}</td></tr>
    </table>`;

  const topItemsHtml = data.topItems.length ? `
    <h3 style="color:#6B4226;font-size:1rem;margin:24px 0 12px">🏆 Top Sellers</h3>
    <table style="width:100%;border-collapse:collapse">
      ${data.topItems.map((i, idx) => `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #f5ede4">
            <span style="display:inline-block;width:22px;height:22px;background:${idx<3?'#6B4226':'#D4A574'};color:#fff;border-radius:50%;text-align:center;line-height:22px;font-size:.7rem;font-weight:700;margin-right:8px">${idx+1}</span>
            ${i.name}
          </td>
          <td style="padding:8px 0;border-bottom:1px solid #f5ede4;text-align:right;font-weight:700;color:#6B4226">${i.qty}</td>
        </tr>`).join('')}
    </table>` : '';

  const stockHtml = data.lowStockItems.length ? `
    <div style="background:#FDE8E8;border-radius:10px;padding:14px 18px;margin-top:20px">
      <h4 style="color:#C0392B;margin:0 0 8px;font-size:.9rem">⚠️ Low Stock Items</h4>
      <ul style="margin:0;padding:0 0 0 18px;color:#7A6355;font-size:.85rem">
        ${data.lowStockItems.map(i => `<li style="padding:3px 0"><strong>${i.name}</strong>: ${i.currentStock} ${i.unit}</li>`).join('')}
      </ul>
    </div>` : `
    <div style="background:#E8F5EC;border-radius:10px;padding:14px 18px;margin-top:20px;text-align:center">
      <p style="margin:0;color:#2D8A4E;font-weight:600">✅ All stock levels are healthy</p>
    </div>`;

  const content = `
    <div style="text-align:center;margin-bottom:16px">
      <h2 style="color:#6B4226;margin:0 0 4px;font-size:1.3rem">End-of-Day Summary</h2>
      <p style="color:#7A6355;margin:0;font-size:.9rem">${formatDate(data.date)}</p>
    </div>
    ${statsHtml}
    <h3 style="color:#6B4226;font-size:1rem;margin:24px 0 12px">💰 Revenue Breakdown</h3>
    ${breakdownHtml}
    ${topItemsHtml}
    ${stockHtml}`;

  return sendEmail(`☕ ${formatDate(data.date)}: ${data.totalOrders} orders · RM${data.netExpected.toFixed(0)} revenue`, emailWrapper(content));
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00+08:00');
  return d.toLocaleDateString('en-MY', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
