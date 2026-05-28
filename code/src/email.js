const nodemailer = require('nodemailer');
const logger = require('./logger');

function getTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

/**
 * Send a notification email after a batch is processed
 * @param {string} sourcePhoto - original filename
 * @param {Array}  results     - array of upload result objects
 * @param {string} draftsUrl   - link to WooCommerce drafts screen
 */
async function sendNotification(sourcePhoto, results, draftsUrl) {
  const recipients = (process.env.NOTIFY_EMAILS || '')
    .split(',')
    .map(e => e.trim())
    .filter(Boolean);

  if (recipients.length === 0) {
    logger.warn('No NOTIFY_EMAILS configured — skipping email notification');
    return;
  }

  const ok = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);
  const totalValue = ok.reduce((sum, r) => sum + (r.price || 0), 0);

  const bagRows = ok.map(r => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f0ebe4;font-family:Georgia,serif">${r.name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0ebe4;color:#666;font-size:13px">${r.sku}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0ebe4;color:#2d6a4f;font-weight:500">$${r.price}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0ebe4">
        <a href="${r.adminUrl}" style="color:#7B5E45;font-size:13px">Review →</a>
      </td>
    </tr>
  `).join('');

  const failedRows = failed.length > 0 ? `
    <div style="margin-top:20px;padding:12px 16px;background:#fef2f2;border-radius:8px;font-size:13px;color:#991b1b">
      <strong>${failed.length} bag(s) failed to upload:</strong>
      <ul style="margin:6px 0 0;padding-left:18px">
        ${failed.map(r => `<li>${r.name} — ${r.error}</li>`).join('')}
      </ul>
    </div>
  ` : '';

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f5f4f0;font-family:Arial,sans-serif">
  <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e8ddd3">

    <div style="background:#7B5E45;padding:28px 32px;text-align:center">
      <h1 style="margin:0;color:#fff;font-family:Georgia,serif;font-weight:400;font-size:22px;letter-spacing:0.02em">
        Artsy Phartsy
      </h1>
      <p style="margin:4px 0 0;color:rgba(255,255,255,0.75);font-size:12px;letter-spacing:0.08em;text-transform:uppercase">
        Old made new
      </p>
    </div>

    <div style="padding:28px 32px">
      <h2 style="margin:0 0 6px;font-family:Georgia,serif;font-weight:400;font-size:20px;color:#1a1a1a">
        ${ok.length} new bag${ok.length !== 1 ? 's' : ''} ready to review
      </h2>
      <p style="margin:0 0 20px;color:#666;font-size:14px">
        From photo: <strong>${sourcePhoto}</strong> &mdash; total value $${totalValue}
      </p>

      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#f5f4f0">
            <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:#888">Name</th>
            <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:#888">SKU</th>
            <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:#888">Price</th>
            <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:#888"></th>
          </tr>
        </thead>
        <tbody>
          ${bagRows}
        </tbody>
      </table>

      ${failedRows}

      <div style="margin-top:28px;text-align:center">
        <a href="${draftsUrl}"
           style="display:inline-block;background:#7B5E45;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:500">
          Review all drafts in WooCommerce →
        </a>
      </div>

      <p style="margin:24px 0 0;font-size:12px;color:#aaa;text-align:center">
        These products are saved as <strong>drafts</strong> and are not visible to customers yet.
        Publish them from your WooCommerce admin when you're happy with them.
      </p>
    </div>

  </div>
</body>
</html>
  `;

  const subject = ok.length > 0
    ? `✨ ${ok.length} new bag${ok.length !== 1 ? 's' : ''} ready to review — ArtsyPhartsy`
    : `⚠ Bag upload completed with errors — ArtsyPhartsy`;

  try {
    const transporter = getTransporter();
    await transporter.sendMail({
      from: `"ArtsyPhartsy Uploader" <${process.env.SMTP_USER}>`,
      to: recipients.join(', '),
      subject,
      html,
    });
    logger.info(`Notification email sent to: ${recipients.join(', ')}`);
  } catch (err) {
    logger.error(`Failed to send notification email: ${err.message}`);
  }
}

module.exports = { sendNotification };
