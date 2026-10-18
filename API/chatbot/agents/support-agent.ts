/**
 * support-agent.ts — support intent routing branch: classifies the issue type.
 * Keyword classification into document/deadline/payment/status/other.
 */

import type { SupportAgentResponse } from "./types.ts";

const TRIGGERS: Array<{ intent: SupportAgentResponse["intent"]; keywords: RegExp }> = [
  { intent: "document", keywords: /document|upload|form|paperwork|requirement|missing doc/i },
  { intent: "deadline", keywords: /deadline|filing date|due date|expire|how long|when.*submit/i },
  { intent: "payment", keywords: /payment|pay|invoice|fee|charge|billing|refund/i },
  { intent: "status", keywords: /status|update|progress|what.?s happening|stage|where.*my/i },
];

export function runSupportAgent(userMessage: string): SupportAgentResponse {
  const l = userMessage.toLowerCase();
  const match = TRIGGERS.find((t) => t.keywords.test(l));

  const intent = match?.intent ?? "other";
  const replyByIntent: Record<SupportAgentResponse["intent"], string> = {
    document: "For document questions, the legal team tracks required documents and deadlines for your matter. I can note what's needed — and the team will confirm the exact checklist for your case.",
    deadline: "Deadline and filing-date details are case-specific. The legal team tracks these and will give you the precise dates for your matter.",
    payment: "For payments, invoices, and fees, the finance team can confirm any charges on your matter.",
    status: "I can share your current stage. The legal team updates your matter as it moves through intake, scoping, legal review, quoting, and filing.",
    other: "I'm here to help with your legal matter. Could you tell me a bit more about what you need?",
  };

  return { intent, reply: replyByIntent[intent] };
}
