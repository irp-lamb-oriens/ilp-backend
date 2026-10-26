/**
 * API/finance/financeAuth.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Every finance route (ledger, invoices, metrics, sales report) is admin only:
 * a staff dashboard session whose role is `admin` (ADMIN_EMAILS). csm and
 * plain staff sessions get 403. Spread it in front of the handler:
 *
 *   app.get("/api/dashboard/finance/ledger", ...FINANCE_ADMIN, handler)
 */

import { requireDashboardAuth } from "../../helper/auth/session.ts";
import { requireStaffRole } from "../../helper/auth/roles.ts";

export const requireFinanceAdmin = requireStaffRole("admin");

export const FINANCE_ADMIN = [requireDashboardAuth, requireFinanceAdmin] as const;
