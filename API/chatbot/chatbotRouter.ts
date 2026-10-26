import type { Express, Request, Response } from "express";
import asyncHandler from "../../helper/asyncHandler.ts";
import log from "../../helper/log.ts";
import get from "../../db/get.ts";
import put from "../../db/put.ts";

// Multi-Agent Imports
import { runThinkingAgent } from "./agents/thinking-agent.ts";
import { runAvailabilityAgent } from "./agents/availability-agent.ts";
import { runSchedulerAgent } from "./agents/scheduler-agent.ts";
import { executeConversationalAgent } from "./agents/conversational-agent.ts";
import { runFieldExtractionAgent } from "./agents/field-extraction-agent.ts";
import { runModeratorAgent, moderatorBlockedReply } from "./agents/moderator-agent.ts";
import { buildConversationContext } from "./agents/agent-context.ts";
import { runLibrarianAgent } from "./agents/librarian-agent.ts";
import { runTaskProgressAgent } from "./agents/task-progress-agent.ts";
import { runSalesAgent } from "./agents/sales-agent.ts";
import { runSupportAgent } from "./agents/support-agent.ts";
import { runAggregatorAgent } from "./agents/aggregator-agent.ts";
import type { ChatMessage } from "./agents/agent-context.ts";
import type { ConversationThread } from "./services/conversation-store.ts";
import type { AvailabilityAgentResponse, SchedulerAgentResponse } from "./agents/types.ts";

const COLLECTION_NAME = "ilp_chatbot_threads";

interface ChatbotRequestBody {
  sessionId?: string;
  message?: string;
  context?: Record<string, unknown>;
  preferredLanguage?: string;
  authCode?: string;
}

export default (app: Express) => {
  log("Chatbot Multi-Agent module initialized.");

  app.post(
    "/api/chatbot/inject-history",
    asyncHandler(async (req: Request, res: Response) => {
      const { sessionId, message, authCode } = req.body as ChatbotRequestBody;
      if (!sessionId || !message) return res.status(400).send("Missing sessionId or message");

      const thread = (await get(COLLECTION_NAME, sessionId)) as ConversationThread | null;
      const history: ChatMessage[] = thread?.messages || [];

      if (!history.some((m) => m.content === message)) {
        history.push({ role: "user", content: message });
        const threadData = {
          ...thread,
          sessionId,
          authCode: authCode || thread?.authCode,
          updatedAt: new Date().toISOString(),
          messages: history,
        };
        if (thread) await put(COLLECTION_NAME, sessionId, threadData);
        else await put(COLLECTION_NAME, sessionId, { ...threadData, createdAt: new Date().toISOString() });
      }

      res.status(200).json({ success: true });
    })
  );

  // ═══════════════════════════════════════════════════
  //  MAIN WEB CHATBOT ENDPOINT
  // ═══════════════════════════════════════════════════
  app.post(
    "/api/chatbot/message",
    asyncHandler(async (req: Request, res: Response) => {
      const { sessionId, message, context, preferredLanguage, authCode } = req.body as ChatbotRequestBody;

      if (!sessionId || !message) {
        return res.status(400).json({ error: "sessionId and message are required" });
      }

      // ─── 1. LOAD STATE ─────────────────────────────────────
      const thread = (await get(COLLECTION_NAME, sessionId)) as ConversationThread | null;
      const history: ChatMessage[] = thread?.messages || [];
      const skippedFields: string[] = thread?.skippedFields || [];

      // ─── 1a. BUILD CUMULATIVE FORM STATE ───────────────────
      const cumulativeContext: Record<string, unknown> = { ...(context || {}) };
      for (const msg of history) {
        if (msg.extractedFields) {
          for (const [k, v] of Object.entries(msg.extractedFields)) {
            if (v !== undefined && v !== null && v !== "") {
              cumulativeContext[k] = v;
            }
          }
        }
      }
      const userEmail = String(cumulativeContext.email || "");
      log(`[CHATBOT] Cumulative state: ${Object.keys(cumulativeContext).filter(k => cumulativeContext[k] && String(cumulativeContext[k]).trim() !== "").join(", ")}`);

      // ─── 1b. INJECT PRE-FILLED FORM CONTEXT INTO HISTORY ───
      const hasFormContextMsg = history.some((m) => m.role === "system" && m.content?.includes("[PRE-FILLED FROM FORM]"));
      if (!hasFormContextMsg && context && Object.keys(context).length > 0) {
        const filledEntries = Object.entries(context)
          .filter(([_, v]) => v && String(v).trim() !== "")
          .map(([k, v]) => `  ${k}: ${v}`)
          .join("\n");
        if (filledEntries) {
          const formContextMsg: ChatMessage = {
            role: "system",
            content: `[PRE-FILLED FROM FORM] The user already provided these fields via the web form. Do NOT ask for them again:\n${filledEntries}`,
          };
          const welcomeIdx = history.findIndex((m) => m.role === "assistant");
          if (welcomeIdx >= 0) {
            history.splice(welcomeIdx + 1, 0, formContextMsg);
          } else {
            history.unshift(formContextMsg);
          }
          log(`[CHATBOT] Injected pre-filled form context: ${Object.keys(context).filter(k => context[k] && String(context[k]).trim() !== "").join(", ")}`);
        }
      }

      // ─── 2. ADD CURRENT MESSAGE TO HISTORY ─────────────────
      history.push({ role: "user", content: message });

      // ─── 2a. MODERATOR SAFETY GATE ─────────────────────────
      const moderation = await runModeratorAgent(message, sessionId);
      if (moderation.blocked) {
        const safeReply = moderatorBlockedReply(moderation.reason);
        history.push({ role: "assistant", content: safeReply });
        const threadData = {
          sessionId,
          authCode: authCode || thread?.authCode,
          updatedAt: new Date().toISOString(),
          formContextSnapshot: context || {},
          skippedFields,
          messages: history,
          lastAvailabilitySlots: thread?.lastAvailabilitySlots || [],
        };
        if (thread) await put(COLLECTION_NAME, sessionId, threadData);
        else await put(COLLECTION_NAME, sessionId, { ...threadData, createdAt: new Date().toISOString() });
        return res.status(200).json({
          success: true,
          response: safeReply,
          extractedFields: {},
          sessionId,
          moderated: true,
        });
      }

      // ─── 3. BUILD CONVERSATION CONTEXT ──────────────────────
      const { summary: convSummary, recentMessages } = buildConversationContext(history, 20);
      const conversationContext = convSummary
        ? `${convSummary}\n\n[RECENT MESSAGES]\n${JSON.stringify(recentMessages)}`
        : JSON.stringify(recentMessages);

      // ─── 4. THINKING AGENT (orchestration decisions) ────────
      const thinking = await runThinkingAgent(message, conversationContext, sessionId, cumulativeContext, skippedFields);
      log(`[CHATBOT] userIntent=${thinking.userIntent}, decision=${thinking.decision?.substring(0, 80)}`);

      // ─── 5. SKIP TRACKING ──────────────────────────────────
      if ((thinking.userIntent === "skip" || thinking.userIntent === "frustration") && thinking.fieldToSkip) {
        const fieldName = thinking.fieldToSkip;
        if (fieldName && fieldName !== "null" && fieldName !== "none" && !skippedFields.includes(fieldName)) {
          skippedFields.push(fieldName);
          log(`[CHATBOT] Skipping "${fieldName}". Skipped: [${skippedFields.join(", ")}]`);
        }
      }

      // ─── 5b. DETERMINISTIC SLOT-SELECTION DETECTOR ──────────
      if (!thinking.needsScheduling) {
        const lastAssistantMsg = [...history].reverse().find((m) => m.role === "assistant");
        const lastContent = lastAssistantMsg?.content || "";
        const hasSlots = /\d+\.\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i.test(lastContent);
        if (hasSlots) {
          const msgLower = message.toLowerCase().trim();
          const slotSelectionPattern = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|the\s*(first|second|third|fourth|fifth)\s*(one)?|option\s*\d|#?\d|let'?s?\s*(do|go|pick)|that\s*(works?|one)|yes|yeah|yep|great|ok|sure|perfect|sounds?\s*good)/i;
          if (slotSelectionPattern.test(msgLower)) {
            thinking.needsScheduling = true;
            log(`[CHATBOT] Deterministic slot-selection detected after slots were presented. Forcing needsScheduling=true`);
          }
        }
      }

      // ─── 6. CONDITIONAL AGENTS ─────────────────────────────
      let availability: AvailabilityAgentResponse | null = null;
      if (thinking.needsAvailabilityCheck) {
        const isProactive = !!thinking.proactiveScheduling;
        availability = await runAvailabilityAgent(message, sessionId, isProactive);
      }

      // ── Deterministic slot resolution for numbered picks ──────────────────
      let resolvedSlotHint = "";
      if (thinking.needsScheduling) {
        const numMatch = message.trim().match(/^([1-5])$/);
        if (numMatch) {
          const idx = parseInt(numMatch[1]) - 1;
          const storedSlots: string[] = thread?.lastAvailabilitySlots || [];
          const foundSlotStart = storedSlots[idx]?.split(" - ")[0] ?? null;
          if (foundSlotStart) {
            resolvedSlotHint = `\n\n[SLOT RESOLUTION] The user typed "${message.trim()}" which is numbered option ${numMatch[1]} from the slots offered in the previous message. The exact ISO 8601 start time for this slot is: ${foundSlotStart}. You MUST use this value as the "start" field — do NOT attempt to reconstruct the time from the formatted text.`;
            log(`[CHATBOT] Pre-resolved slot #${numMatch[1]} from stored slots → ${foundSlotStart}`);
          }
        }
      }

      let scheduler: SchedulerAgentResponse | null = null;
      if (thinking.needsScheduling) {
        const schedulerContext = { ...cumulativeContext };
        if (!schedulerContext.email && userEmail) schedulerContext.email = userEmail;
        scheduler = await runSchedulerAgent(message, schedulerContext, JSON.stringify(recentMessages) + resolvedSlotHint, sessionId);
      }

      // ─── 7. CONVERSATION + EXTRACTION (parallel) ───────────
      const [reply, fieldExtraction] = await Promise.all([
        executeConversationalAgent(thinking, availability, scheduler, history, sessionId, cumulativeContext, skippedFields, preferredLanguage || 'en'),
        runFieldExtractionAgent(message, history, cumulativeContext, sessionId)
      ]);

      const extractedFields: Record<string, unknown> = fieldExtraction.appliedFields;

      let replyText = reply.responseText;

      // Inject scheduling links deterministically
      if (scheduler && scheduler.schedulerResult === "success" && scheduler.createdEvent) {
        extractedFields.calendarLink = scheduler.createdEvent.htmlLink;
        extractedFields.hangoutLink = scheduler.createdEvent.hangoutLink;

        replyText = replyText.replace(/<<<--MEET-LINK-->>>/gi, scheduler.createdEvent.hangoutLink || '');
        replyText = replyText.replace(/<<<--CALENDAR-LINK-->>>/gi, scheduler.createdEvent.htmlLink || '');
      }

      // ─── HALLUCINATION SAFETY NET ────────────────────────────
      if (replyText.includes("<<<--MEET-LINK-->>>") || replyText.includes("<<<--CALENDAR-LINK-->>>")) {
        log(`[CHATBOT] Hallucination detected: LLM emitted link placeholders but scheduler result was "${scheduler?.schedulerResult ?? "not_run"}". Stripping placeholders.`);
        replyText = replyText
          .replace(/<<<--MEET-LINK-->>>/gi, "")
          .replace(/<<<--CALENDAR-LINK-->>>/gi, "")
          .replace(/\s{2,}/g, " ")
          .trim();
      }

      // ─── 8. HALLUCINATION CHECK ─────────────────────────────
      const { executeHallucinationDetectorAgent } = await import("./agents/hallucination-detector-agent.ts");
      await executeHallucinationDetectorAgent(
        replyText,
        { availability: availability || undefined, scheduler: scheduler || undefined },
        message
      );

      // ─── 8b. SPECIALIST AGENT ORCHESTRATION (R3) ─────────────
      // Route service/jurisdiction/stage questions to the librarian, task-status
      // questions to task-progress, and intent branches to sales/support. The
      // aggregator prefers a grounded specialist answer; otherwise the
      // conversational reply (already computed) wins.
      try {
        const outputs: Array<{ id: string; text: string; priority: number }> = [];
        outputs.push({ id: "conversational", text: replyText, priority: 1 });

        const librarian = await runLibrarianAgent(message, conversationContext, sessionId);
        if (librarian.answered && librarian.answer) {
          outputs.push({ id: "librarian", text: librarian.answer, priority: 3 });
        }

        if (/task|ticket|status of my/i.test(message)) {
          const tp = await runTaskProgressAgent(message, userEmail || undefined);
          if (tp.found && tp.statusText) {
            outputs.push({ id: "task_progress", text: tp.statusText, priority: 4 });
          }
        }

        const sales = runSalesAgent(message);
        if (sales.intent !== "general" && sales.reply) {
          outputs.push({ id: "sales", text: sales.reply, priority: 2 });
        }
        const support = runSupportAgent(message);
        if (support.intent !== "other") {
          outputs.push({ id: "support", text: support.reply, priority: 2 });
        }

        const aggregated = runAggregatorAgent(outputs);
        if (aggregated.mergedReply && aggregated.mergedReply !== replyText) {
          replyText = aggregated.mergedReply;
          log(`[CHATBOT] specialist agent overrode reply: ${aggregated.sources.join(" | ") || "none"}`);
        }
      } catch (err) {
        log(`[CHATBOT] specialist orchestration skipped: ${err instanceof Error ? err.message : err}`);
      }

      // ─── 9. PERSIST ─────────────────────────────────────────
      history.push({ role: "assistant", content: replyText, extractedFields });

      const threadData = {
        sessionId,
        authCode: authCode || thread?.authCode,
        updatedAt: new Date().toISOString(),
        formContextSnapshot: context || {},
        skippedFields,
        messages: history,
        lastAvailabilitySlots: availability?.NON_TAKEN_MEETING_TIME_RANGES?.length
          ? availability.NON_TAKEN_MEETING_TIME_RANGES
          : (thread?.lastAvailabilitySlots || [])
      };

      if (thread) await put(COLLECTION_NAME, sessionId, threadData);
      else await put(COLLECTION_NAME, sessionId, { ...threadData, createdAt: new Date().toISOString() });

      // ─── 10. RESPOND ────────────────────────────────────────
      res.status(200).json({
        success: true,
        response: replyText,
        extractedFields,
        sessionId
      });
    })
  );

  app.get(
    "/api/chatbot/history/:sessionId",
    asyncHandler(async (req: Request, res: Response) => {
      const { sessionId } = req.params;
      const thread = (await get(COLLECTION_NAME, sessionId)) as ConversationThread | null;
      res.status(200).json({ messages: thread?.messages || [] });
    })
  );
};