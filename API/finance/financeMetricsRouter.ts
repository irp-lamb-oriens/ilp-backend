/**
 * financeMetricsRouter.ts — read-only financial metrics for the CRM.
 *
 * GET /api/dashboard/finance/metrics   (admin only: FINANCE_ADMIN)
 *
 * Every quote lives inside a client document's `quotes` array, so there is no
 * single collection to list. financeQuoteSource.ts reads them all and joins
 * each quote with the jurisdiction and pipeline stage of its parent client
 * before the pure aggregation in financeAggregate.ts does the arithmetic.
 *
 * Nothing here writes. The endpoint is safe to call repeatedly.
 */

import type { Application, Request, Response } from "express";
import log from "../../helper/log.ts";
import { FINANCE_ADMIN } from "./financeAuth.ts";
import { fetchQuotesWithFacts } from "./financeQuoteSource.ts";
import { getStageLabels } from "../dashboard/clientHelpers.ts";
import {
  aggregateFinance,
  type FinanceQuote,
} from "./financeAggregate.ts";

export default function financeMetricsRouter(app: Application) {
  app.get(
    "/api/dashboard/finance/metrics",
    ...FINANCE_ADMIN,
    async (req: Request, res: Response) => {
      try {
        const baseCurrency =
          typeof req.query.currency === "string" && req.query.currency
            ? req.query.currency
            : "USD";

        const { quotes, facts } = await fetchQuotesWithFacts();
        const joined = quotes as unknown as FinanceQuote[];

        // aggregateFinance wants a Record<string, string> of stage labels;
        // clientHelpers returns ordered { id, label } pairs for the board.
        const stageLabels = Object.fromEntries(
          getStageLabels().map((s) => [s.id, s.label]),
        );

        const metrics = aggregateFinance(joined, {
          baseCurrency,
          stageLabels,
        });

        res.json({
          ...metrics,
          quotesRead: joined.length,
          clientsRead: facts.size,
        });
      } catch (err: any) {
        log(`[financeMetricsRouter] GET metrics: ${err?.message}`);
        res
          .status(500)
          .json({ error: err?.message ?? "Failed to compute finance metrics" });
      }
    },
  );
}