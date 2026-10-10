# ILP Backend Style Guide

The single source of truth for how the ILP backend is structured and written.
Every new router, helper, db wrapper, and job must follow these rules. When a
rule and a one-off idea conflict, the rule wins.

## 1. Stack

- **Runtime:** Deno (import map in `deno.json`).
- **Framework:** Express 4 (`npm:express@^4.21.2`).
- **Data:** Firestore via REST (no SDK). All reads/writes go through `db/`
  wrappers over `helper/firestore/`.
- **Auth:** platform session JWT (HS256, `JWT_SECRET`) verified in
  `helper/auth/verifyToken.ts`; role-gating in `helper/auth/validateUser.ts`.
- **Jobs:** `croner` via `jobs/cronRunner.ts` + `jobs/registry.ts`.
- **External services:** declared ONLY in `config/integrations.ts` as typed
  placeholders that throw `NOT_IMPLEMENTED`.

## 2. Module layout

```
main.ts                     — Express bootstrap, mounts all routers, /health, error handler
API/<domain>/<domain>Router.ts — one router per domain, (app: Express) => void
db/                         — thin Firestore wrappers (get, getAll, post, put, patch, delete, query)
helper/                     — shared helpers (asyncHandler, auditLog, log, sanitize, emailQueue, ...)
helper/auth/                — verifyToken, validateUser, types
helper/firestore/           — REST fetch + URL getters + value (de)serialization
config/integrations.ts      — external API placeholders
jobs/                       — cronRunner, registry, dispatchAlerts, escalation
```

## 3. Router conventions

- Every router exports a default function `(app: Express) => void`.
- Register it in `main.ts` (import + call). Keep the list alphabetical.
- Wrap every async handler in `asyncHandler`.
- Gate with `validateUser()` / `validateUser("staff")` /
  `validateUser(["staff", "provider"])`.
- Read the current user from `(req as Request & { sessionUser?: SessionUser }).sessionUser`.
- Log router init with `log("... router initialized.")`.
- Write an `auditLog` entry for every mutation (create/update/delete).

## 4. Data layer

- **Never call Firestore directly from a router.** Use `db/` wrappers.
- `db/get(collection, id)` → document or `null`.
- `db/post(collection, data)` → new id (auto-generated).
- `db/put(collection, id, data)` / `db/patch(collection, id, data)` → update.
- `db/delete(collection, id)` → delete.
- `db/query(collection, ...)` → filtered reads.
- Document ids are deterministic where possible (e.g. `profile_${uid}`).
- Timestamps: `new Date().toISOString()`; set `createdAt` on create, `updatedAt`
  on every write.

## 5. Auth

- `verifyToken(token)` returns `AccessTokenPayload` (`{ uid, email, role, exp }`).
  It verifies HS256 signature + expiry and throws on any failure.
- `validateUser(allowed?)` attaches `sessionUser` to the request and enforces
  role when `allowed` is provided.
- Roles: `customer`, `provider`, `staff`.
- Never trust client-supplied `uid`/`role`; always derive from the verified token.

## 6. External integrations

- All third-party calls (email, sms, calendar, transcription, payments) go
  through `config/integrations.ts`.
- Each is a typed async function that currently throws `NOT_IMPLEMENTED`.
- When wiring a real provider, edit ONLY `integrations.ts`; call sites stay stable.
- Do not scatter `fetch`/SDK calls for these services across routers.

## 7. Jobs / cron

- Jobs are registered in `jobs/registry.ts` and dispatched by `jobs/cronRunner.ts`.
- Use `croner` (`new Cron(...)` — Cron is a class).
- Cron only starts in production (`CRON_RUNNER_ENABLED === "true"` and non-localhost).
- Keep job logic in `jobs/`; do not put cron logic in routers.

## 8. Error handling & validation

- Validate required fields explicitly; return `400` with a clear `{ error }`.
- Return `401` for missing/invalid auth, `403` for insufficient role.
- Let `asyncHandler` bubble rejections to the central error middleware in
  `main.ts` (returns `500 { error: "Internal server error." }`).
- Sanitize untrusted input via `helper/sanitize.ts` before persisting.

## 9. Naming & style

- Files: `camelCase.ts` for helpers/db, `PascalCase.ts` for routers.
- Functions: `camelCase`. Types/interfaces: `PascalCase`.
- Prefer explicit types on public signatures; avoid `any`.
- One responsibility per function. Keep routers thin; push logic to helpers.
- No hardcoded secrets or env keys in code — read from `Deno.env.get(...)`.

## 10. Backward compatibility

- All changes must be backward compatible and non-destructive to existing
  endpoints that already lint/check green.
- Do not rename existing routes, fields, or env keys without an explicit reason.
- Keep `deno.json` import map in sync when adding dependencies.
- Verify with `deno lint` and `deno check main.ts` before declaring done.