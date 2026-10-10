/**
 * Auth roles for the ILP platform. Each role gates a distinct surface:
 *   customer  — end users (landing + country pages + alert micro-forms)
 *   provider  — vetted legal partners (lawyer landing + assigned work)
 *   staff     — internal dashboard (the 13-metric weekly view)
 */
export const ROLES = ["customer", "provider", "staff"] as const;
export type Role = (typeof ROLES)[number];

export interface SessionUser {
  uid: string;
  email: string;
  role: Role;
}

export interface AccessTokenPayload {
  uid: string;
  email: string;
  role: Role;
  // Standard JWT claims
  iss?: string;
  sub?: string;
  iat?: number;
  exp?: number;
}