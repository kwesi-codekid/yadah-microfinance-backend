import { Resend } from 'resend';
import { env } from '../config/env.js';
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

/** Brand palette, taken from the Yadah logo (navy chain, gold cedi coins). */
export const BRAND = {
  navy: '#1F4E79',
  navyDark: '#173C5E',
  gold: '#E9B949',
  goldSoft: '#FBF4E0',
  goldBorder: '#EAD08C',
  ink: '#101828',
  gray: '#475467',
  grayLight: '#98A2B3',
  logoUrl:
    'https://res.cloudinary.com/rgodzxvt/image/upload/v1784909266/yadah/brand/logo-symbol.png',
} as const;

/** Branded shell for simple notices (security notifications etc.). */
export function noticeEmailHtml(title: string, message: string, recipientName: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:#f4f5f7;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(16,24,40,.08);">
            <tr>
              <td align="center" style="padding:32px 32px 0;">
                <img src="${BRAND.logoUrl}" width="64" height="64" alt="Yadah logo" style="display:block;width:64px;height:auto;" />
                <p style="margin:12px 0 0;color:${BRAND.navy};font-size:20px;font-weight:700;letter-spacing:.3px;">Yadah Dynamic Enterprise</p>
                <div style="width:56px;height:4px;background:${BRAND.gold};border-radius:2px;margin:14px auto 0;"></div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 32px 32px;">
                <p style="margin:0;color:${BRAND.ink};font-size:16px;font-weight:600;">${title}</p>
                <p style="margin:12px 0 0;color:${BRAND.gray};font-size:14px;line-height:1.6;">Hi ${recipientName},</p>
                <p style="margin:12px 0 0;color:${BRAND.gray};font-size:14px;line-height:1.6;">${message}</p>
              </td>
            </tr>
            <tr>
              <td style="background:${BRAND.navy};padding:18px 32px;">
                <p style="margin:0;color:#ffffff;font-size:12px;">Yadah Dynamic Enterprise · Esiama, Ghana</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function otpEmailHtml(code: string, recipientName: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:#f4f5f7;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(16,24,40,.08);">
            <tr>
              <td align="center" style="padding:32px 32px 0;">
                <img src="${BRAND.logoUrl}" width="64" height="64" alt="Yadah logo" style="display:block;width:64px;height:auto;" />
                <p style="margin:12px 0 0;color:${BRAND.navy};font-size:20px;font-weight:700;letter-spacing:.3px;">Yadah Dynamic Enterprise</p>
                <div style="width:56px;height:4px;background:${BRAND.gold};border-radius:2px;margin:14px auto 0;"></div>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 32px 8px;">
                <p style="margin:0;color:${BRAND.ink};font-size:16px;font-weight:600;">Hi ${recipientName},</p>
                <p style="margin:12px 0 0;color:${BRAND.gray};font-size:14px;line-height:1.6;">
                  Use this code to sign in. It expires in <strong>5&nbsp;minutes</strong>.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px;">
                <div style="background:${BRAND.goldSoft};border:1px solid ${BRAND.goldBorder};border-radius:12px;padding:20px;text-align:center;">
                  <span style="font-size:34px;font-weight:700;letter-spacing:10px;color:${BRAND.navy};font-family:'Courier New',monospace;">${code}</span>
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 32px;">
                <p style="margin:0;color:${BRAND.grayLight};font-size:12px;line-height:1.6;">
                  If you didn't request this code, you can safely ignore this email.
                  Never share this code with anyone — Yadah staff will never ask for it.
                </p>
              </td>
            </tr>
            <tr>
              <td style="background:${BRAND.navy};padding:18px 32px;">
                <p style="margin:0;color:#ffffff;font-size:12px;">Yadah Dynamic Enterprise · Esiama, Ghana</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
