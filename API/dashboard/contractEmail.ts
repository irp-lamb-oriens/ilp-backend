/**
 * contractEmail.ts — deliver the signed engagement agreement PDF.
 *
 * Two audiences, one attachment:
 *   • the client the contract is for, and
 *   • the internal list configured in the admin (`contract_recipients`).
 *
 * Every send is best-effort. A mail failure must never unwind a client's
 * acceptance, which has already been committed by the time this runs.
 *
 * The PDF attachment is sent directly through the SMTP transport rather than
 * the Firestore-backed queue, because a binary attachment does not round-trip
 * through a JSON document store.
 */

import { sendEmailTransport } from "../../config/integrations.ts";
import log from "../../helper/log.ts";
import { loadContractRecipients } from "./automation/contractRecipients.ts";
import { ensureBankInfo } from "./automation/bankInfo.ts";
import type { BankInfoConfig } from "./automation/bankInfo.ts";
import { depositNarrative, bankDetailsText } from "./automation/paymentInstructions.ts";
import { contractFileName } from "./contractPdf.ts";
import type { ContractSnapshot } from "./contractSnapshot.ts";

function money(n: number, currency: string): string {
  const amount = Number.isFinite(n) ? n : 0;
  return `${currency} ${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function longDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function clientHtml(snapshot: ContractSnapshot, bank: BankInfoConfig): string {
  const narrative = depositNarrative({
    currency: snapshot.currency,
    total: snapshot.total,
    schedule: Array.isArray(snapshot.paymentSchedule) ? snapshot.paymentSchedule : [],
  });

  const paymentBlock = narrative
    ? `
      <div style="background:#f0fdfe;border:1px solid rgba(2,181,187,.22);border-radius:10px;padding:18px;margin:0 0 20px;">
        <p style="margin:0;font-size:14px;color:#334155;line-height:1.6;">${narrative}</p>
      </div>
      <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;padding:18px;margin:0 0 20px;">
        <p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#0f172a;">Payment details</p>
        <pre style="margin:0;font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;color:#334155;line-height:1.6;white-space:pre-wrap;">${bankDetailsText(bank)}</pre>
      </div>`
    : "";

  return `
    <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;padding:0;color:#1a1a2e;">
      <div style="background:linear-gradient(135deg,#020d10 0%,#062028 100%);border-radius:14px 14px 0 0;padding:32px 28px 24px;">
        <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:rgba(2,181,187,.8);">International Legal Partner</p>
        <h1 style="margin:0 0 6px;font-size:22px;font-weight:800;color:#ffffff;line-height:1.25;">Your engagement agreement</h1>
        <p style="margin:0;font-size:14px;color:rgba(248,250,252,.65);">Thank you, ${snapshot.signatureName || "there"}. Your copy is attached.</p>
      </div>
      <div style="background:#ffffff;padding:28px 28px 8px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;">
        <p style="margin:0 0 18px;font-size:14px;color:#475569;line-height:1.6;">
          Attached is the PDF copy of the legal services you accepted on ${longDate(snapshot.acceptedAt)}.
          Keep it for your records: it lists the services agreed, the total, and the name you entered as your signature.
        </p>
        <table style="width:100%;border-collapse:collapse;margin:0 0 20px;font-size:13px;">
          <tr>
            <td style="padding:8px 0;color:#64748b;border-bottom:1px solid #f1f5f9;">Reference</td>
            <td style="padding:8px 0;text-align:right;color:#334155;border-bottom:1px solid #f1f5f9;">${snapshot.contractRef}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#64748b;border-bottom:1px solid #f1f5f9;">Accepted on</td>
            <td style="padding:8px 0;text-align:right;color:#334155;border-bottom:1px solid #f1f5f9;">${longDate(snapshot.acceptedAt)}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#64748b;">Agreed total</td>
            <td style="padding:8px 0;text-align:right;font-weight:700;color:#02b5bb;">${money(snapshot.total, snapshot.currency)}</td>
          </tr>
        </table>
        ${paymentBlock}
        <p style="margin:0 0 24px;font-size:12px;color:#94a3b8;">
          If anything in the attached agreement does not match what you expected, reply to this email and we will correct it.
        </p>
      </div>
      <div style="background:#f8fafc;padding:16px 28px;border-radius:0 0 14px 14px;border:1px solid #e2e8f0;border-top:none;">
        <p style="margin:0;font-size:11px;color:#94a3b8;text-align:center;">International Legal Partner · Engagement agreement ${snapshot.contractRef}</p>
      </div>
    </div>`;
}

function internalHtml(snapshot: ContractSnapshot): string {
  const rows = snapshot.fields
    .slice(0, 12)
    .map(
      (f) =>
        `<tr><td style="padding:6px 10px;color:#64748b;border-bottom:1px solid #f1f5f9;font-size:12px;">${f.label}</td>` +
        `<td style="padding:6px 10px;color:#334155;border-bottom:1px solid #f1f5f9;font-size:12px;">${f.value}</td></tr>`,
    )
    .join("");
  return `
    <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;padding:32px 24px;">
      <h2 style="color:#02b5bb;margin:0 0 8px;">Contract signed — ${snapshot.signatureName || "client"}</h2>
      <p style="color:#475569;margin:0 0 16px;font-size:14px;">
        The client accepted <strong>${snapshot.quoteTitle}</strong> on ${longDate(snapshot.acceptedAt)} for
        <strong>${money(snapshot.total, snapshot.currency)}</strong>. The signed agreement is attached as a PDF,
        the same file the client received and the one to hand to the bank when proof of a services contract is requested.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:0 0 16px;">${rows}</table>
      <p style="color:#94a3b8;font-size:11px;margin:0;">Reference ${snapshot.contractRef} · International Legal Partner</p>
    </div>`;
}

/**
 * Email the contract PDF to the client and to the configured internal list.
 * Never throws: each send is isolated and failures are logged.
 */
export async function sendContractEmails(
  snapshot: ContractSnapshot,
  pdf: Uint8Array,
  opts: { clientEmail?: string | null; clientId: string } = { clientId: "" },
): Promise<{ sentTo: string[]; failed: string[] }> {
  const filename = contractFileName(snapshot);
  const attachments = [{ filename, content: pdf, contentType: "application/pdf" }];
  const sentTo: string[] = [];
  const failed: string[] = [];

  const clientEmail = String(opts.clientEmail ?? snapshot.clientEmail ?? "").trim();
  if (clientEmail.includes("@")) {
    try {
      const bank = await ensureBankInfo();
      await sendEmailTransport({
        to: clientEmail,
        subject: `Your engagement agreement — ${snapshot.contractRef}`,
        html: clientHtml(snapshot, bank),
        attachments,
      });
      sentTo.push(clientEmail);
    } catch (err: any) {
      failed.push(clientEmail);
      log(`[contractEmail] client send failed for ${clientEmail} (non-fatal): ${err?.message ?? err}`);
    }
  }

  // Internal copies come from the admin-editable list, so adding a teammate is
  // a config change rather than a deploy.
  let recipients: string[] = [];
  try {
    recipients = await loadContractRecipients();
  } catch (err: any) {
    log(`[contractEmail] recipient config read failed (non-fatal): ${err?.message ?? err}`);
  }

  const internalHtmlBody = internalHtml(snapshot);
  for (const recipient of recipients) {
    if (!recipient.includes("@")) continue;
    if (recipient.toLowerCase() === clientEmail.toLowerCase()) continue;
    try {
      await sendEmailTransport({
        to: recipient,
        subject: `Contract signed — ${snapshot.signatureName || snapshot.contractRef}`,
        html: internalHtmlBody,
        attachments,
      });
      sentTo.push(recipient);
    } catch (err: any) {
      failed.push(recipient);
      log(`[contractEmail] internal send failed for ${recipient} (non-fatal): ${err?.message ?? err}`);
    }
  }

  return { sentTo, failed };
}