import { Resend } from 'resend';
import { env } from '../config/env.js';
import { BRAND, BRAND_LOGO_URL } from './brand.js';
import { logger } from './logger.js';

const resend = env.RESEND_API_KEY !== '' ? new Resend(env.RESEND_API_KEY) : null;

/**
 * Fire-and-forget: email failures are logged, never thrown — an email
 * problem must never break the flow that triggered it.
 */
export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!resend) {
    logger.info({ to, subject }, 'RESEND_API_KEY not set — email skipped (log-only mode)');
    return;
  }
  try {
    const { error } = await resend.emails.send({ from: env.EMAIL_FROM, to, subject, html });
    if (error) {
      logger.warn({ to, subject, error: error.message }, 'email send failed');
    } else {
      logger.info({ to, subject }, 'email sent');
    }
  } catch (err) {
    logger.warn({ err, to, subject }, 'email send threw');
  }
}

/**
 * Email templates.
 *
 * Colours come from the shared palette in brand.ts, the same one the printed
 * documents use, so everything Yadah sends out matches the app.
 *
 * Written the way email has to be written rather than the way a web page is:
 * table layout, inline styles only, no external stylesheet, and hex colours
 * rather than modern CSS colour functions — Outlook understands none of it.
 *
 * `color-scheme: light` is declared twice, as a meta tag and a body style.
 * Without it Apple Mail and Outlook auto-invert the card in dark mode, which
 * turns coral-on-white into something muddy and unreadable. Declaring the
 * scheme tells them not to.
 */

/** Hidden line the inbox shows beside the subject. Worth setting deliberately. */
function preheader(text: string): string {
  return `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${text}</div>`;
}

/**
 * The shell every email shares: logo, wordmark, coral rule, content, footer.
 * One definition so the templates cannot drift apart.
 */
function shell(preheaderText: string, content: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
  </head>
  <body style="margin:0;padding:0;color-scheme:light;background-color:${BRAND.canvas};font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    ${preheader(preheaderText)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BRAND.canvas};padding:40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:${BRAND.surface};border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(27,36,48,.08);">
            <tr>
              <td align="center" style="padding:32px 32px 0;">
                <img src="${BRAND_LOGO_URL}" width="64" height="64" alt="Yadah Dynamic Enterprise" style="display:block;width:64px;height:auto;" />
                <p style="margin:12px 0 0;color:${BRAND.ink};font-size:20px;font-weight:700;letter-spacing:.3px;">Yadah Dynamic Enterprise</p>
                <div style="width:56px;height:4px;background:${BRAND.coral};border-radius:2px;margin:14px auto 0;"></div>
              </td>
            </tr>
            ${content}
            <tr>
              <td style="background:${BRAND.ink};padding:18px 32px;">
                <p style="margin:0;color:${BRAND.surface};font-size:12px;">Yadah Dynamic Enterprise &middot; Esiama, Ghana</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** Branded shell for simple notices (security notifications etc.). */
export function noticeEmailHtml(title: string, message: string, recipientName: string): string {
  return shell(
    title,
    `<tr>
              <td style="padding:28px 32px 32px;">
                <p style="margin:0;color:${BRAND.ink};font-size:16px;font-weight:600;">${title}</p>
                <p style="margin:12px 0 0;color:${BRAND.muted};font-size:14px;line-height:1.6;">Hi ${recipientName},</p>
                <p style="margin:12px 0 0;color:${BRAND.muted};font-size:14px;line-height:1.6;">${message}</p>
              </td>
            </tr>`,
  );
}

export function otpEmailHtml(code: string, recipientName: string): string {
  return shell(
    'Your Yadah sign-in code expires in 5 minutes.',
    `<tr>
              <td style="padding:28px 32px 8px;">
                <p style="margin:0;color:${BRAND.ink};font-size:16px;font-weight:600;">Hi ${recipientName},</p>
                <p style="margin:12px 0 0;color:${BRAND.muted};font-size:14px;line-height:1.6;">
                  Use this code to sign in. It expires in <strong>5&nbsp;minutes</strong>.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px;">
                <div style="background:${BRAND.coralSoft};border:1px solid ${BRAND.coralBorder};border-radius:12px;padding:20px;text-align:center;">
                  <span style="font-size:34px;font-weight:700;letter-spacing:10px;color:${BRAND.ink};font-family:'Courier New',monospace;">${code}</span>
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 32px;">
                <p style="margin:0;color:${BRAND.mutedLight};font-size:12px;line-height:1.6;">
                  If you didn't request this code, you can safely ignore this email.
                  Never share this code with anyone &mdash; Yadah staff will never ask for it.
                </p>
              </td>
            </tr>`,
  );
}
