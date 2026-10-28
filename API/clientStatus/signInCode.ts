/**
 * API/clientStatus/signInCode.ts
 * ──────────────────────────────────────────────────────────────────────────
 * The client portal's sign-in code email, shared by
 *   POST /api/client-status/auth/request-otp   (the /status sign-in form)
 *   POST /api/leads/claim                      (DEADLINES: saving deadlines from the free check)
 * The code is issued by helper/auth/otp.ts (hashed, 10 minutes, 30-second resend cooldown).
 */

import log from "../../helper/log.ts";
import { sendEmailTransport } from "../../config/integrations.ts";
import { emailToDocId, issueOtp } from "../../helper/auth/otp.ts";

export const CLIENT_OTP_COLLECTION = "client_status_otps";

export type SignInCodeResult = { ok: true } | { ok: false; status: number; error: string };

/** Issue a code for (email, project) and email it. Never throws. */
export async function sendClientSignInCode(email: string, projectId: string): Promise<SignInCodeResult> {
  const normalizedEmail = email.toLowerCase().trim();
  const otpDocId = `${projectId}__${emailToDocId(normalizedEmail)}`;
  let code: string;
  try {
    const issued = await issueOtp(CLIENT_OTP_COLLECTION, otpDocId, normalizedEmail, { projectId });
    if (!issued.ok) return { ok: false, status: issued.status, error: issued.error };
    code = issued.code;
  } catch (err) {
    log(`[client-status] OTP not issued: ${err instanceof Error ? err.message : err}`);
    return { ok: false, status: 500, error: "Failed to send verification code." };
  }
  try {
    await sendEmailTransport({
      to: normalizedEmail,
      subject: "Your ILP Client Portal Login Code",
      html: `
            <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 24px;">
              <div style="text-align: center; margin-bottom: 32px;">
                <h1 style="color: #123b5d; font-size: 24px; margin: 0;">ILP Client Portal</h1>
                <p style="color: #4a5a66; font-size: 14px; margin-top: 8px;">Secure Login Code</p>
              </div>
              <div style="background: #eff7fb; border-radius: 12px; padding: 32px; text-align: center;">
                <p style="color: #202a33; font-size: 16px; margin: 0 0 16px;">Your verification code is:</p>
                <div style="font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #123b5d; font-family: monospace; padding: 16px; background: white; border-radius: 8px; display: inline-block;">${code}</div>
                <p style="color: #7a8a96; font-size: 13px; margin-top: 16px;">This code expires in 10 minutes.</p>
              </div>
            </div>
          `,
    });
    log(`[client-status] OTP sent to ${normalizedEmail}`);
    return { ok: true };
  } catch (err) {
    log(`[client-status] Failed to send OTP email: ${err instanceof Error ? err.message : err}`);
    return { ok: false, status: 500, error: "Failed to send verification code." };
  }
}
