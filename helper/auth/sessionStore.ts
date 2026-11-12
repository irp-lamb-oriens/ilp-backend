/**
 * helper/auth/sessionStore.ts
 * ──────────────────────────────────────────────────────────────────────────
 * The Firestore calls the auth middleware makes, behind one mutable object so
 * tests can swap in an in-memory store (test/authBearer_test.ts). Production
 * code never reassigns these.
 *
 * Session look-ups go through helper/auth/sessionCache.ts: one database read
 * per session per minute instead of one per request. Every change made here
 * forgets the cached copy first.
 */

import dbGet from "../../db/get.ts";
import dbPatch from "../../db/patch.ts";
import dbPut from "../../db/put.ts";
import query from "../../db/query.ts";
import dbRemove from "../../db/delete.ts";
import { cachedSession, forgetSession } from "./sessionCache.ts";

const get: typeof dbGet = (collection, id) => cachedSession(collection, id, () => dbGet(collection, id));

const patch = ((collection: string, id: string, ...rest: unknown[]) => {
  forgetSession(collection, id);
  return (dbPatch as (...a: unknown[]) => unknown)(collection, id, ...rest);
}) as typeof dbPatch;

const put = ((collection: string, id: string, ...rest: unknown[]) => {
  forgetSession(collection, id);
  return (dbPut as (...a: unknown[]) => unknown)(collection, id, ...rest);
}) as typeof dbPut;

const remove = ((collection: string, id: string, ...rest: unknown[]) => {
  forgetSession(collection, id);
  return (dbRemove as (...a: unknown[]) => unknown)(collection, id, ...rest);
}) as typeof dbRemove;

export const sessionStore = { get, patch, put, query, remove };
