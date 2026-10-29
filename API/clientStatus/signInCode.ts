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
import { signInCodeEmail } from "../../helper/emailTemplates.ts"; // COMMS-P1

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
    const mail = signInCodeEmail({ portal: "member", code }); // COMMS-P1: legal footer
    await sendEmailTransport({ to: normalizedEmail, subject: mail.subject, html: mail.html, text: mail.text });
    log(`[client-status] OTP sent to ${normalizedEmail}`);
    return { ok: true };
  } catch (err) {
    log(`[client-status] Failed to send OTP email: ${err instanceof Error ? err.message : err}`);
    return { ok: false, status: 500, error: "Failed to send verification code." };
  }
}
