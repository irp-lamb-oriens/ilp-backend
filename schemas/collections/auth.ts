/**
 * schemas/collections/auth.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Document schemas for auth/session collections.
 */
import type { IsoTimestamp } from "../types.ts";

/** dashboard_sessions — a staff dashboard session. */
export interface DashboardSession {
  email: string;
  createdAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  [key: string]: unknown;
}

/** dashboard_otps — a staff dashboard one-time password. */
export interface DashboardOtp {
  code: string;
  email: string;
  createdAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  [key: string]: unknown;
}

/** client_status_sessions — a client status-page session. */
export interface ClientStatusSession {
  email: string;
  createdAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  [key: string]: unknown;
}

/** client_status_otps — a client status-page one-time password. */
export interface ClientStatusOtp {
  code: string;
  email: string;
  createdAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  [key: string]: unknown;
}