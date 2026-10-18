/**
 * sales-agent.ts — intent routing branch: quote vs booking vs general.
 * Lightweight keyword classifier; heavier classification lives in thinking-agent.
 */

import type { SalesAgentResponse } from "./types.ts";

export function runSalesAgent(userMessage: string): SalesAgentResponse {
  const l = userMessage.toLowerCase();

  if (/quote|price|pricing|cost|fee|how much/.test(l)) {
    return {
      intent: "quote",
      confidenceGuestimate: 0.8,
      reply:
        "I can point you to a quote. Our legal team prepares fixed-fee quotes after a short scoping call — would you like to book a consultation so they can scope your matter accurately?",
    };
  }

  if (/book|schedule|consultation|appointment|call with|meet/.test(l)) {
    return {
      intent: "booking",
      confidenceGuestimate: 0.85,
      reply:
        "I'd be happy to help you book a consultation. Could you confirm your email and which country your legal matter concerns (Costa Rica, Panama, or Mexico)?",
    };
  }

  return {
    intent: "general",
    confidenceGuestimate: 0.4,
    reply: "",
  };
}
