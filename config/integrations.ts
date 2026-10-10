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

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
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
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
  });
}

/** SMS / WhatsApp delivery. */
export async function sendSms(message: SmsMessage): Promise<void> {
  void message;
  await notImplemented("sms");
}

/** Calendar availability + event creation (Google Calendar, Cal.com, Cronofy). */
export async function listAvailableSlots(opts: {
  providerId: string;
  from: string;
  to: string;
}): Promise<CalendarSlot[]> {
  void opts;
  return await notImplemented("calendar");
}

export async function createCalendarEvent(opts: {
  slot: CalendarSlot;
  title: string;
  description?: string;
}): Promise<{ eventId: string; htmlLink?: string }> {
  void opts;
  return await notImplemented("calendar");
}

/** Call recording / transcription (HappyScribe, AssemblyAI, Deepgram). */
export async function transcribeAudio(audioUrl: string): Promise<{
  transcript: string;
  summary?: string;
}> {
  void audioUrl;
  return await notImplemented("transcription");
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