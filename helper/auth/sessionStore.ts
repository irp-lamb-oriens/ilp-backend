/**
 * helper/auth/sessionStore.ts
 * ──────────────────────────────────────────────────────────────────────────
 * The Firestore calls the auth middleware makes, behind one mutable object so
 * tests can swap in an in-memory store (test/authBearer_test.ts). Production
 * code never reassigns these.
 */

import get from "../../db/get.ts";
import patch from "../../db/patch.ts";
import put from "../../db/put.ts";
import query from "../../db/query.ts";
import remove from "../../db/delete.ts";

export const sessionStore = { get, patch, put, query, remove };
