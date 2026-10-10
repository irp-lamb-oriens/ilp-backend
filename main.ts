import "dotenv/load.ts";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import http from "node:http";
import log from "./helper/log.ts";

import profilesRouter from "./API/profiles/profilesRouter.ts";
import rulesRouter from "./API/rules/rulesRouter.ts";
import alertsRouter from "./API/alerts/alertsRouter.ts";
import updatesRouter from "./API/updates/updatesRouter.ts";
import templatesRouter from "./API/templates/templatesRouter.ts";
import consultationsRouter from "./API/consultations/consultationsRouter.ts";
import providersRouter from "./API/providers/providersRouter.ts";
import tasksRouter from "./API/tasks/tasksRouter.ts";
import analyticsRouter from "./API/analytics/analyticsRouter.ts";
import leadsRouter from "./API/leads/leadsRouter.ts";
import dashboardRouter from "./API/dashboard/dashboardRouter.ts";

import { startCronRunner } from "./jobs/cronRunner.ts";

const MINUTE = 60 * 1000;

function createServer() {
  try {
    if (!Deno.env.get("SERVICE_ACCOUNT_KEY")) {
      log("FATAL: SERVICE_ACCOUNT_KEY environment variable is not set.");
      Deno.exit(1);
    }

    const app = express();
    const isProduction = !!Deno.env.get("RENDER_EXTERNAL_URL");
    const port = parseInt(Deno.env.get("PORT") || "8000");
    const host = isProduction ? "0.0.0.0" : "localhost";
    const baseUrl = Deno.env.get("RENDER_EXTERNAL_URL") || `http://localhost:${port}`;

    const server = http.createServer(app);

    app.set("trust proxy", true);
    app.use(cors({ origin: "*" }));

    app.use((req: Request, _res: Response, next: NextFunction) => {
      log(`${req.method} ${req.originalUrl}`, "request");
      next();
    });

    const globalLimiter = rateLimit({
      windowMs: 1 * MINUTE,
      max: 100,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many requests. Retry in a minute." },
      validate: { trustProxy: false },
    });

    const apiLimiter = rateLimit({
      windowMs: 1 * MINUTE,
      max: 50,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many API requests. Retry in a minute." },
      validate: { trustProxy: false },
    });

    app.use(globalLimiter);
    app.use("/api/", apiLimiter);
    app.use(express.json({ limit: "10mb" }));

    profilesRouter(app);
    rulesRouter(app);
    alertsRouter(app);
    updatesRouter(app);
    templatesRouter(app);
    consultationsRouter(app);
    providersRouter(app);
    tasksRouter(app);
    analyticsRouter(app);
    leadsRouter(app);
    dashboardRouter(app);

    app.get("/health", (_req: Request, res: Response) => {
      res.status(200).json({ ok: true });
    });

    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const message = err instanceof Error ? err.message : String(err);
      log(`Unhandled error: ${message}`, "error");
      res.status(500).json({ error: "Internal server error." });
    });

    if (!baseUrl.includes("localhost") && Deno.env.get("CRON_RUNNER_ENABLED") === "true") {
      startCronRunner();
    }

    server.listen(port, host, () =>
      log(`Server running on ${baseUrl} (${host}:${port})`)
    );
  } catch (error) {
    log(error, "main");
  }
}

if (import.meta.main) {
  createServer();
}