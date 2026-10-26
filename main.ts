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
import countriesRouter from "./API/countries/countriesRouter.ts";
import updatesRouter from "./API/updates/updatesRouter.ts";
import templatesRouter from "./API/templates/templatesRouter.ts";
import consultationsRouter from "./API/consultations/consultationsRouter.ts";
import providersRouter from "./API/providers/providersRouter.ts";
import dashboardProvidersRouter from "./API/dashboard/providersRouter.ts";
import providerRfqDashboardRouter from "./API/dashboard/providerRfqDashboardRouter.ts";
import providerAuthRouter from "./API/provider/providerAuthRouter.ts";
import providerDashboardRouter from "./API/provider/providerDashboardRouter.ts";
import providerQuotesRouter from "./API/provider/providerQuotesRouter.ts";
import assignmentRouter from "./API/dashboard/assignmentRouter.ts";
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
import pushRouter from "./API/push/pushRouter.ts";
import membersRouter from "./API/members/membersRouter.ts";
import callsRouter from "./API/calls/callsRouter.ts"; // P3
import privacyRouter from "./API/privacy/privacyRouter.ts"; // P6
import opportunitiesRouter from "./API/opportunities/opportunitiesRouter.ts"; // P5
import { loginHooks } from "./helper/auth/loginHooks.ts";
import { registerSessionHooks, sessionRoutes } from "./helper/auth/sessionHooks.ts";
import { documentAccessRouter } from "./helper/storage.ts";
import { securityHeaders } from "./helper/auth/securityHeaders.ts";
import { errorHandler, installProcessErrorHandlers, registerHealthRoutes } from "./helper/errorReporter.ts";

import { startCronRunner } from "./jobs/cronRunner.ts";

const MINUTE = 60 * 1000;

function createServer() {
  try {
    if (!Deno.env.get("SERVICE_ACCOUNT_KEY")) {
      log("FATAL: SERVICE_ACCOUNT_KEY environment variable is not set.");
      Deno.exit(1);
    }

    installProcessErrorHandlers();
    const app = express();
    const isProduction = !!Deno.env.get("RENDER_EXTERNAL_URL");
    const port = parseInt(Deno.env.get("PORT") || "8000");
    const host = isProduction ? "0.0.0.0" : "localhost";
    const baseUrl = Deno.env.get("RENDER_EXTERNAL_URL") || `http://localhost:${port}`;

    const server = http.createServer(app);

    app.set("trust proxy", true);
    app.disable("x-powered-by");
    // nosniff, no-referrer, frame-ancestors 'none', HSTS in production.
    app.use(securityHeaders(isProduction));
    // Allow only known front-end origins (comma-separated ALLOWED_ORIGINS).
    // Localhost dev origins are permitted when not in production.
    const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
      .split(",").map((o) => o.trim()).filter(Boolean);
    if (!isProduction) allowedOrigins.push("http://localhost:3000", "http://127.0.0.1:3000");
    app.use(cors({
      origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
        // Non-browser clients (curl, server-to-server, health checks) send no Origin.
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        cb(null, false);
      },
      // Cookies (HttpOnly sessions) need credentials; the header tokens still work.
      credentials: true,
      allowedHeaders: ["Content-Type", "x-dashboard-token", "x-provider-token", "x-client-token", "x-client-id", "Authorization"],
    }));

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
    // Small default body limit; import/upload-style routes keep the large one.
    const bigJson = express.json({ limit: "10mb" });
    const smallJson = express.json({ limit: "1mb" });
    app.use((req: Request, res: Response, next: NextFunction) => {
      const big = /\/(import|bulk-import|voice-transcribe|upload|chat|chatbot|attachment|documents?)(\/|$|-)/.test(req.path);
      (big ? bigJson : smallJson)(req, res, next);
    });

    // Audit + session hooks around the three OTP verify routes (before routers).
    registerSessionHooks();
    app.use(loginHooks);
    sessionRoutes(app);
    // Staff and assigned-lawyer document downloads (private bucket, audited).
    documentAccessRouter(app);

    profilesRouter(app);
    rulesRouter(app);
    alertsRouter(app);
    countriesRouter(app);
    updatesRouter(app);
    templatesRouter(app);
    consultationsRouter(app);
    providersRouter(app);
    dashboardProvidersRouter(app);
    providerRfqDashboardRouter(app);
    providerAuthRouter(app);
    providerDashboardRouter(app);
    providerQuotesRouter(app);
    assignmentRouter(app);
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
    pushRouter(app);
    membersRouter(app);
    callsRouter(app); // P3: availability, Meet, no-show, transcripts
    privacyRouter(app); // P6: consents, data rights, CSP reports
    opportunitiesRouter(app); // P5: staff opportunities pipeline

    // GET /health (public) and GET /health/deep (x-health-token: $HEALTH_TOKEN).
    registerHealthRoutes(app);

    // Last: unhandled route errors → error_log (+ Sentry when SENTRY_DSN is set).
    app.use(errorHandler);

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