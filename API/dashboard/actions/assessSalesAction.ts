/**
 * API/dashboard/actions/assessSalesAction.ts
 * ──────────────────────────────────────────────────────────────────────────
 * REAL handler for the `intake_assessment` action (IRP `assess_sales` analog).
 *
 * Scores intake completeness via the shared LLM fallback chain, persists the
 * assessment on the client doc, and raises a pending action when the intake is
 * deemed incomplete.
 */

import get from "../../../db/get.ts";
import put from "../../../db/put.ts";
import log from "../../../helper/log.ts";
import { callLLMWithFallback } from "../../chatbot/intelligence/llm.ts";
import { addPendingAction } from "../pendingActions.ts";
import type { ActionContext, ActionResult } from "./types.ts";

const CLIENTS_COLLECTION = "clients";

interface IntakeAssessment {
  completeness: number; // 0..1
  missing: string[];
  recommendation: string;
}

export async function assessSalesAction(
  ctx: ActionContext,
): Promise<ActionResult> {
  const { clientId, actor, args } = ctx;
  const doc = (await get(CLIENTS_COLLECTION, clientId)) ?? ctx.clientDoc ?? {};

  const manualText = typeof args?.manualText === "string" ? args.manualText.trim() : "";
  const sourceText =
    manualText || (typeof doc.transcript === "string" ? doc.transcript : "");

  const snapshot = JSON.stringify({
    name: doc.name,
    surname: doc.surname,
    email: (doc as Record<string, unknown>).dripEmail,
    legalArea: doc.legalArea,
    legalMatter: doc.legalMatter,
    jurisdiction: doc.jurisdiction,
    transcript: sourceText ? sourceText.slice(0, 4000) : undefined,
  });

  try {
    const res = await callLLMWithFallback({
      systemInstruction:
        "You assess legal-intake completeness. Return ONLY JSON: {\"completeness\":0..1,\"missing\":string[],\"recommendation\":string}.",
      prompt: snapshot,
      temperature: 0,
      maxTokens: 512,
    });

    let assessment: IntakeAssessment;
    try {
      assessment = JSON.parse(res.content) as IntakeAssessment;
      if (typeof assessment.completeness !== "number") throw new Error("bad shape");
    } catch {
      assessment = {
        completeness: 0.5,
        missing: [],
        recommendation: res.content.slice(0, 500),
      };
    }

    const nowIso = new Date().toISOString();
    await put(CLIENTS_COLLECTION, clientId, {
      salesAssessment: { ...assessment, assessedAt: nowIso },
      updatedAt: nowIso,
      activityLog: [
        ...(Array.isArray(doc.activityLog) ? doc.activityLog : []),
        { type: "intake_assessed", actor, timestamp: nowIso, completeness: assessment.completeness },
      ],
    });

    const incomplete = assessment.completeness < 0.8 && assessment.missing.length > 0;
    if (incomplete) {
      await addPendingAction(clientId, {
        type: "intake_incomplete",
        tab: "overview",
        title: `Intake incomplete — missing: ${assessment.missing.join(", ")}`,
        priority: "high",
        assignedTo: [],
        triggeredBy: actor,
        meta: { completeness: assessment.completeness, missing: assessment.missing },
      });
    }

    return {
      success: true,
      message: `Intake ~${Math.round(assessment.completeness * 100)}% complete${incomplete ? " — follow up required" : ""}.`,
      data: { assessment },
    };
  } catch (err) {
    log(`[intake_assessment] ${clientId} failed: ${err instanceof Error ? err.message : err}`);
    return { success: false, message: "Assessment failed — try again shortly.", data: { reason: "llm_error" } };
  }
}