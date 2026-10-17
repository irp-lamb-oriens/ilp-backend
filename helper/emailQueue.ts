import post from "../db/post.ts";
import query from "../db/query.ts";
import patch from "../db/patch.ts";
import { sendEmailTransport, type EmailMessage } from "../config/integrations.ts";
import log from "./log.ts";

/**
 * A Firestore-backed outbound email queue. Enqueue is cheap and idempotent;
 * a scheduled worker (jobs/processEmailQueue.ts) drains it, which decouples
 * request latency from SMTP delivery.
 */
const COLLECTION = "email_queue";
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 60_000; // 1 minute, doubling per attempt up to the cap
const MAX_BACKOFF_MS = 30 * 60_000;

export async function enqueueEmail(
  email: EmailMessage,
  dedupeKey?: string,
): Promise<string> {
  const payload = {
    ...email,
    status: "pending",
    attempts: 0,
    createdAt: new Date().toISOString(),
  };

  if (dedupeKey) {
    const id = `dedupe_${dedupeKey}`;
    await patch(COLLECTION, id, payload);
    return id;
  }
  return await post(COLLECTION, payload);
}

/**
 * Drain a bounded batch of due pending emails. Returns count delivered.
 *
 * Retry policy: a failed send increments `attempts` and schedules a retry with
 * exponential backoff (60s doubling, capped at 30m). After MAX_RETRIES the item
 * is moved to a dead-letter status ("dead") with its lastError preserved for
 * inspection. Only items whose `nextAttemptAt` has passed are drained.
 */
export async function processEmailQueue(batchSize = 25): Promise<number> {
  // Single-field EQUAL query (no composite index), with due + order done in
  // memory so the cold path stays index-free.
  const pending = await query(COLLECTION, [
    { field: "status", op: "EQUAL", value: "pending" },
  ]);

  const now = Date.now();
  const due = pending
    .filter((item) => {
      const next = item.nextAttemptAt as string | undefined;
      return !next || new Date(next).getTime() <= now;
    })
    .sort((a, b) =>
      String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""))
    )
    .slice(0, batchSize);

  let processed = 0;
  for (const item of due) {
    try {
      await sendEmailTransport({
        to: item.to as string,
        subject: item.subject as string,
        html: item.html as string,
        text: item.text as string | undefined,
        attachments: item.attachments as
          | Array<{ filename: string; content: Uint8Array | string; contentType?: string }>
          | undefined,
      });
      await patch(COLLECTION, item.id, {
        status: "sent",
        sentAt: new Date().toISOString(),
        lastError: null,
        nextAttemptAt: null,
      });
      processed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = ((item.attempts as number) ?? 0) + 1;

      if (attempts >= MAX_RETRIES) {
        await patch(COLLECTION, item.id, {
          status: "dead",
          attempts,
          lastError: message,
          nextAttemptAt: null,
        });
        log(
          `Email queue dead-lettered ${item.id} after ${attempts} attempts: ${message}`,
          "emailQueue",
        );
      } else {
        const delay = Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
        await patch(COLLECTION, item.id, {
          status: "pending",
          attempts,
          lastError: message,
          nextAttemptAt: new Date(Date.now() + delay).toISOString(),
        });
        log(
          `Email queue retry scheduled for ${item.id} (attempt ${attempts}, +${delay}ms): ${message}`,
          "emailQueue",
        );
      }
    }
  }
  return processed;
}
