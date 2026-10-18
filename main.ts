import { loadSync } from "dotenv/mod.ts";

loadSync({ export: true, allowEmptyValues: true, examplePath: null });
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
import dashboardProvidersRouter from "./API/dashboard/providersRouter.ts";
import providerRfqDashboardRouter from "./API/dashboard/providerRfqDashboardRouter.ts";
import pricingRequestsRouter from "./API/dashboard/pricingRequestsRouter.ts";
import vendorRouter from "./API/vendors/vendorRouter.ts";
import tasksRouter from "./API/tasks/tasksRouter.ts";
import analyticsRouter from "./API/analytics/analyticsRouter.ts";
import leadsRouter from "./API/leads/leadsRouter.ts";
import dashboardRouter from "./API/dashboard/dashboardRouter.ts";
import calendarRouter from "./API/calendar/calendarRouter.ts";
import invoicesRouter from "./API/finance/invoicesRouter.ts";
import financeLedgerRouter from "./API/finance/financeLedgerRouter.ts";
import financeMetricsRouter from "./API/finance/financeMetricsRouter.ts";
import salesReportRouter from "./API/finance/salesReportRouter.ts";
import paymentsRouter from "./API/payments/paymentsRouter.ts";
import blogPublicRouter from "./API/blog/blogPublicRouter.ts";
import guidesPublicRouter from "./API/guides/guidesPublicRouter.ts";
import postsRouter from "./API/posts/postsRouter.ts";
import chatbotRouter from "./API/chatbot/chatbotRouter.ts";
import serviceTypesRouter from "./API/dashboard/serviceTypesRouter.ts";
import clientStatusRouter from "./API/clientStatus/clientStatusRouter.ts";
import quoteTemplatesRouter from "./API/dashboard/quoteTemplatesRouter.ts";
import quoteTemplateMapRouter from "./API/dashboard/quoteTemplateMapRouter.ts";
import quoteLineTemplatesRouter from "./API/dashboard/quoteLineTemplatesRouter.ts";
import quoteLabelsRouter from "./API/dashboard/quoteLabelsRouter.ts";
import quotesRouter from "./API/dashboard/quotesRouter.ts";
import emailAutomationRouter from "./API/dashboard/emailAutomationRouter.ts";
import stageGatesRouter from "./API/dashboard/stageGatesRouter.ts";
import stageConfigRouter from "./API/dashboard/stageConfigRouter.ts";
import overviewFieldsRouter from "./API/dashboard/overviewFieldsRouter.ts";
import crmLilyRouter from "./API/dashboard/crmLilyRouter.ts";
import clientsBulkImportRouter from "./API/dashboard/clientsBulkImportRouter.ts";
import portalRouter from "./API/portal/portalRouter.ts";

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
    dashboardProvidersRouter(app);
    providerRfqDashboardRouter(app);
    pricingRequestsRouter(app);
    vendorRouter(app);
    tasksRouter(app);
    analyticsRouter(app);
    leadsRouter(app);
    dashboardRouter(app);
    calendarRouter(app);
    invoicesRouter(app);
    financeLedgerRouter(app);
    financeMetricsRouter(app);
    salesReportRouter(app);
    paymentsRouter(app);
    blogPublicRouter(app);
    guidesPublicRouter(app);
    postsRouter(app);
    chatbotRouter(app);
    serviceTypesRouter(app);
    clientStatusRouter(app);
    quoteTemplatesRouter(app);
    quoteTemplateMapRouter(app);
    quoteLineTemplatesRouter(app);
    quoteLabelsRouter(app);
    quotesRouter(app);
    emailAutomationRouter(app);
    stageGatesRouter(app);
    stageConfigRouter(app);
    overviewFieldsRouter(app);
    crmLilyRouter(app);
    clientsBulkImportRouter(app);
    portalRouter(app);

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