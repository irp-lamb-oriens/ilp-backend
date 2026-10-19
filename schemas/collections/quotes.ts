/**
 * schemas/collections/quotes.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Document schemas for quote-related collections.
 */
import type { Extensible, IsoTimestamp } from "../types.ts";

/** quote_templates — a quote template. */
export interface QuoteTemplateDoc extends Extensible {
  id: string;
  title: string;
  blocks?: unknown[];
  status?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** quote_line_templates — a quote line template. */
export interface QuoteLineTemplateDoc extends Extensible {
  id: string;
  label: string;
  amountMinor?: number;
  currency?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** quote_labels — a quote label. */
export interface QuoteLabelDoc extends Extensible {
  id: string;
  label: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** quote_service_types — a quote service type. */
export interface QuoteServiceTypeDoc extends Extensible {
  id: string;
  label: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** quote_template_map — a quote template mapping (dashboard_config doc). */
export interface QuoteTemplateMapDoc extends Extensible {
  id: string;
  map: Record<string, string>;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}