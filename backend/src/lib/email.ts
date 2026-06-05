import * as nodemailer from 'nodemailer';

const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || '';
const NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL || '';

const transporter = GMAIL_USER && GMAIL_APP_PASSWORD ? nodemailer.createTransport({
  service: 'gmail',
  auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
}) : null;

export async function sendEmail(subject: string, html: string): Promise<boolean> {
  if (!transporter || !NOTIFICATION_EMAIL) {
    console.log('[EMAIL] Not configured, skipping:', subject);
    return false;
  }

  try {
    await transporter.sendMail({
      from: `"RLC Café 153" <${GMAIL_USER}>`,
      to: NOTIFICATION_EMAIL,
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
  const itemsHtml = items.map(i =>
    `<tr><td style="padding:8px;border-bottom:1px solid #eee"><strong>${i.name}</strong></td><td style="padding:8px;border-bottom:1px solid #eee;color:#C0392B">${i.currentStock} ${i.unit}</td><td style="padding:8px;border-bottom:1px solid #eee">${i.threshold} ${i.unit}</td></tr>`
  ).join('');

  const html = `
    <div style="font-family:sans-serif;max-width:500px">
      <h2 style="color:#6B4226">⚠️ Low Stock Alert</h2>
      <p>The following items are running low and may need restocking:</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <tr style="background:#f9f5f0"><th style="padding:8px;text-align:left">Item</th><th style="padding:8px;text-align:left">Current</th><th style="padding:8px;text-align:left">Threshold</th></tr>
        ${itemsHtml}
      </table>
      <p style="color:#7A6355;font-size:14px">Please restock before next Sunday's service.</p>
      <p style="color:#9CA3AF;font-size:12px">— RLC Café 153 POS System</p>
    </div>`;

  return sendEmail('⚠️ Low Stock Alert — RLC Café 153', html);
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
  const topItemsHtml = data.topItems.map((i, idx) =>
    `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee">${idx+1}. ${i.name}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right"><strong>${i.qty}</strong></td></tr>`
  ).join('');

  const lowStockHtml = data.lowStockItems.length
    ? `<h3 style="color:#C0392B;margin-top:20px">⚠️ Low Stock</h3><ul>${data.lowStockItems.map(i => `<li>${i.name}: ${i.currentStock} ${i.unit}</li>`).join('')}</ul>`
    : '<p style="color:#2D8A4E">✅ All stock levels OK</p>';

  const html = `
    <div style="font-family:sans-serif;max-width:500px">
      <h2 style="color:#6B4226">☕ End-of-Day Summary — ${data.date}</h2>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;background:#f9f5f0;border-radius:8px">
        <tr><td style="padding:12px"><strong>Total Orders</strong></td><td style="padding:12px;text-align:right;font-size:1.2em"><strong>${data.totalOrders}</strong></td></tr>
        <tr><td style="padding:12px"><strong>Gross Revenue</strong></td><td style="padding:12px;text-align:right;font-size:1.2em"><strong>RM ${data.totalRevenue.toFixed(2)}</strong></td></tr>
        <tr><td style="padding:12px"><strong>Discounts/Offsets</strong></td><td style="padding:12px;text-align:right">RM ${data.totalOffsets.toFixed(2)}</td></tr>
        <tr><td style="padding:12px"><strong>Net Expected</strong></td><td style="padding:12px;text-align:right;font-size:1.2em;color:#2D8A4E"><strong>RM ${data.netExpected.toFixed(2)}</strong></td></tr>
        <tr><td style="padding:12px"><strong>Newcomers Served</strong></td><td style="padding:12px;text-align:right">${data.newcomersServed}</td></tr>
      </table>
      ${data.topItems.length ? `<h3 style="color:#6B4226;margin-top:20px">🏆 Top Items</h3><table style="width:100%;border-collapse:collapse">${topItemsHtml}</table>` : ''}
      ${lowStockHtml}
      <p style="color:#9CA3AF;font-size:12px;margin-top:24px">— RLC Café 153 POS System</p>
    </div>`;

  return sendEmail(`☕ Daily Summary: ${data.totalOrders} orders, RM${data.netExpected.toFixed(2)} — ${data.date}`, html);
}
