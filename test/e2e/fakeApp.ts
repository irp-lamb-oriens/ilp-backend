/**
 * test/e2e/fakeApp.ts — an Express-shaped route table for end-to-end tests.
 * ──────────────────────────────────────────────────────────────────────────
 * The routers register on `app` exactly as main.ts does (get/post/patch/put/
 * delete/use, in order, with middleware chains); `call()` dispatches one
 * request through the same chain and resolves with the status and JSON body.
 * No sockets, no body parser (bodies are passed as objects, like
 * express.json() leaves them).
 */

type Doc = Record<string, unknown>;
type Handler = (req: Doc, res: Doc, next: (err?: unknown) => void) => unknown;

interface Layer {
  method: string | null; // null = use()
  path: string | null; // null = every path
  prefix: boolean;
  handlers: Handler[];
  keys: string[];
  re: RegExp | null;
}

export interface CallResult {
  status: number;
  body: any;
  headers: Record<string, unknown>;
}

function compile(path: string, prefix: boolean): { re: RegExp; keys: string[] } {
  const keys: string[] = [];
  const src = path.replace(/\/+$/, "").replace(/[.+?^${}()|[\]\\]/g, (c) => (c === ":" ? c : `\\${c}`))
    .replace(/:([A-Za-z0-9_]+)/g, (_m, k) => {
      keys.push(k);
      return "([^/]+)";
    });
  return { re: new RegExp(`^${src}${prefix ? "(?:/|$)" : "/?$"}`), keys };
}

export class FakeApp {
  layers: Layer[] = [];
  errors: unknown[] = [];

  private add(method: string | null, args: unknown[]) {
    let path: string | null = null;
    if (typeof args[0] === "string") path = args.shift() as string;
    const handlers = (args.flat(Infinity) as Handler[]).filter((h) => typeof h === "function");
    const c = path ? compile(path, method === null) : null;
    this.layers.push({ method, path, prefix: method === null, handlers, keys: c?.keys ?? [], re: c?.re ?? null });
  }
  get(...a: unknown[]) { if (a.length === 1 && typeof a[0] === "string") return undefined; this.add("GET", a); }
  post(...a: unknown[]) { this.add("POST", a); }
  patch(...a: unknown[]) { this.add("PATCH", a); }
  put(...a: unknown[]) { this.add("PUT", a); }
  delete(...a: unknown[]) { this.add("DELETE", a); }
  use(...a: unknown[]) { this.add(null, a); }
  set() {}
  disable() {}

  /** Dispatch one request. `headers` carries the session (Authorization: Bearer …). */
  call(method: string, url: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<CallResult> {
    const u = new URL(url, "http://e2e.local");
    const query: Doc = {};
    for (const [k, v] of u.searchParams) query[k] = v;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
    const req: Doc = {
      method: method.toUpperCase(),
      url: u.pathname + u.search,
      originalUrl: u.pathname + u.search,
      path: u.pathname,
      query,
      headers,
      body: opts.body === undefined ? {} : JSON.parse(JSON.stringify(opts.body)),
      params: {},
      ip: "127.0.0.1",
      cookies: {},
      get: (k: string) => headers[k.toLowerCase()],
      header: (k: string) => headers[k.toLowerCase()],
    };
    return new Promise<CallResult>((resolve) => {
      const outHeaders: Record<string, unknown> = {};
      const listeners: Record<string, Array<() => void>> = {};
      let done = false;
      const finish = (body: unknown) => {
        if (done) return;
        done = true;
        (res as { headersSent: boolean }).headersSent = true;
        for (const fn of listeners.finish ?? []) fn();
        resolve({ status: res.statusCode as number, body, headers: outHeaders });
      };
      const res: Doc = {
        statusCode: 200,
        headersSent: false,
        locals: {},
        status(n: number) { res.statusCode = n; return res; },
        json(b: unknown) { finish(b === undefined ? null : JSON.parse(JSON.stringify(b))); return res; },
        send(b?: unknown) { finish(typeof b === "string" || b === undefined ? b ?? null : b); return res; },
        end(b?: unknown) { finish(b ?? null); return res; },
        write() { return true; },
        setHeader(k: string, v: unknown) { outHeaders[k.toLowerCase()] = v; },
        getHeader(k: string) { return outHeaders[k.toLowerCase()]; },
        set(k: string, v: unknown) { outHeaders[k.toLowerCase()] = v; return res; },
        type() { return res; },
        cookie() { return res; },
        clearCookie() { return res; },
        flushHeaders() {},
        on(ev: string, fn: () => void) { (listeners[ev] ??= []).push(fn); return res; },
        once(ev: string, fn: () => void) { (listeners[ev] ??= []).push(fn); return res; },
      };
      const stack: Array<{ layer: Layer; params: Doc }> = [];
      for (const layer of this.layers) {
        if (layer.method && layer.method !== req.method) continue;
        let params: Doc = {};
        if (layer.re) {
          const m = layer.re.exec(u.pathname);
          if (!m) continue;
          params = Object.fromEntries(layer.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        }
        stack.push({ layer, params });
      }
      let li = 0;
      let hi = 0;
      const next = (err?: unknown): void => {
        if (done) return;
        if (err) {
          this.errors.push(err);
          res.statusCode = 500;
          finish({ error: err instanceof Error ? err.message : String(err) });
          return;
        }
        while (li < stack.length) {
          const { layer, params } = stack[li];
          if (hi >= layer.handlers.length) {
            li++;
            hi = 0;
            continue;
          }
          const h = layer.handlers[hi++];
          req.params = { ...(req.params as Doc), ...params };
          try {
            const r = h(req, res, next);
            if (r && typeof (r as Promise<unknown>).catch === "function") (r as Promise<unknown>).catch(next);
          } catch (e) {
            next(e);
          }
          return;
        }
        res.statusCode = 404;
        finish({ error: `no route for ${req.method} ${u.pathname}` });
      };
      next();
    });
  }
}
