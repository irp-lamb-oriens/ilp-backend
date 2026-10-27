/**
 * CENTRALIZED EXTERNAL-API PLACEHOLDERS
 * ======================================
 * Everything that touches a third-party service is declared here as a typed,
 * async function. Each throws `NOT_IMPLEMENTED` until the integration is
 * wired. Call sites stay stable: when you add a real provider later, you
 * only edit this file.
 *
 * DO NOT scatter fetch/sdk calls for these services across routers.
 */

import nodemailer from "nodemailer";
import {
  listAvailableSlots as listAvailableSlotsImpl,
  createCalendarEvent as createCalendarEventImpl,
} from "../helper/calendar.ts";
import { transcribeAudio as transcribeAudioWhisper } from "../API/chatbot/intelligence/transcription.ts";
import { deliverableRecipients, logSkipped } from "../helper/placeholder.ts";

export interface EmailAttachment {
  filename: string;
  content: Uint8Array | string;
  contentType?: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
  attachments?: EmailAttachment[];
  /** Optional CC recipients (team copy). */
  cc?: string[];
  /** Optional BCC recipients (team copy). */
  bcc?: string[];
  /**
   * The record this email is about is placeholder (seed) data: never deliver.
   * Senders set it where the record is at hand (calls, member emails).
   */
  placeholder?: boolean;
}

export interface CalendarSlot {
  start: string; // ISO
  end: string; // ISO
  timezone: string;
}

export interface SmsMessage {
  to: string; // E.164
  body: string;
}

async function notImplemented(service: string): Promise<never> {
  await Promise.resolve(); // keep the async contract while still throwing
  throw new Error(`NOT_IMPLEMENTED: ${service} integration is not wired yet.`);
}

/** Email delivery via SMTP (nodemailer). */
export async function sendEmailTransport(message: EmailMessage): Promise<void> {
  // Placeholder guard (helper/placeholder.ts): nothing about seed data, and
  // nothing to a reserved domain (example.com, .test, .invalid …), leaves here.
  if (message.placeholder) {
    logSkipped("email", "placeholder record");
    return;
  }
  const to = deliverableRecipients(message.to);
  const cc = deliverableRecipients(message.cc);
  const bcc = deliverableRecipients(message.bcc);
  const dropped = to.dropped.length + cc.dropped.length + bcc.dropped.length;
  if (dropped) logSkipped("email recipients", `${dropped} reserved-domain address(es)`);
  if (!to.kept.length) return;
  const host = Deno.env.get("SMTP_HOST");
  const port = Number(Deno.env.get("SMTP_PORT") ?? "587");
  const user = Deno.env.get("SMTP_USER");
  const pass = Deno.env.get("SMTP_PASS");
  const from = Deno.env.get("SMTP_FROM") ?? "no-reply@internationallegalpartner.com";

  if (!host || !user || !pass) {
    await notImplemented("email");
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  await transporter.sendMail({
    from,
    to: to.kept.join(", "),
    cc: cc.kept.length ? cc.kept : undefined,
    bcc: bcc.kept.length ? bcc.kept : undefined,
    subject: message.subject,
    html: message.html,
    text: message.text,
    attachments: message.attachments,
  });
}

/** SMS / WhatsApp delivery. */
export async function sendSms(message: SmsMessage): Promise<void> {
  void message;
  await notImplemented("sms");
}

/** Calendar availability + event creation (Google Calendar). */
export async function listAvailableSlots(opts: {
  providerId: string;
  from: string;
  to: string;
}): Promise<CalendarSlot[]> {
  return await listAvailableSlotsImpl(opts);
}

export async function createCalendarEvent(opts: {
  slot: CalendarSlot;
  title: string;
  description?: string;
}): Promise<{ eventId: string; htmlLink?: string }> {
  return await createCalendarEventImpl(opts);
}

/** Call recording / transcription (OpenAI Whisper). */
export async function transcribeAudio(audio: Uint8Array): Promise<string> {
  return await transcribeAudioWhisper(audio);
}

/** Payment capture (Stripe, Adyen, PayU for LATAM). */
export async function createCheckoutSession(opts: {
  amount: number;
  currency: string;
  customerId?: string;
}): Promise<{ sessionId: string; url: string }> {
  void opts;
  return await notImplemented("payments");
}

/** WhatsApp message delivery (Twilio, Meta Cloud API). */
export async function sendWhatsApp(opts: {
  to: string; // E.164
  message: string;
}): Promise<void> {
  void opts;
  await notImplemented("whatsapp");
}
