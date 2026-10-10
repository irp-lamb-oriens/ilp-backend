import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "./verifyToken.ts";
import type { Role, SessionUser } from "./types.ts";
import log from "../log.ts";

/**
 * Express middleware that resolves the current user from the Authorization
 * header and optional role checks.
 *
 * Usage:
 *   validateUser()                       — any authenticated user
 *   validateUser("staff")                — staff only
 *   validateUser(["staff", "provider"])  — staff OR provider
 */
export default function validateUser(allowed?: Role | Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const header = req.headers.authorization;
      if (!header || !header.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Missing or invalid auth token." });
      }

      const token = header.slice("Bearer ".length).trim();
      const payload = verifyToken(token);

      const allowedRoles = allowed
        ? Array.isArray(allowed) ? allowed : [allowed]
        : null;

      if (allowedRoles && !allowedRoles.includes(payload.role)) {
        return res.status(403).json({ error: "Insufficient permissions." });
      }

      const user: SessionUser = {
        uid: payload.uid,
        email: payload.email,
        role: payload.role,
      };

      // Attach to the request for downstream handlers.
      (req as Request & { sessionUser?: SessionUser }).sessionUser = user;
      next();
    } catch (err) {
      log(`Auth failed: ${err instanceof Error ? err.message : err}`, "auth");
      return res.status(401).json({ error: "Invalid or expired auth token." });
    }
  };
}