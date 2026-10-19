/**
 * schemas/collections/dashboardConfig.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Document schemas for the `dashboard_config` collection. This collection is
 * a key-value store of fixed-id config documents; each id has its own shape.
 */
import type { Extensible, IsoTimestamp } from "../types.ts";

/** dashboard_config/quote_approvers — quote approver list. */
export interface QuoteApproversConfigDoc extends Extensible {
  id: string;
  approvers: string[];
  updatedAt: IsoTimestamp;
}

/** dashboard_config/client_offer_popup — client offer popup config. */
export interface ClientOfferPopupConfigDoc extends Extensible {
  id: string;
  enabled: boolean;
  updatedAt: IsoTimestamp;
}

/** dashboard_config/contract_recipients — contract recipient list. */
export interface ContractRecipientsConfigDoc extends Extensible {
  id: string;
  recipients: string[];
  updatedAt: IsoTimestamp;
}

/** dashboard_config/bank_info — bank information. */
export interface BankInfoConfigDoc extends Extensible {
  id: string;
  updatedAt: IsoTimestamp;
}

/** dashboard_config/access_config — dashboard access config. */
export interface AccessConfigDoc extends Extensible {
  id: string;
  views: Record<string, unknown>;
  collaborators: string[];
  updatedAt: IsoTimestamp;
}

/** dashboard_config/action_permissions — action permission map. */
export interface ActionPermissionsDoc extends Extensible {
  id: string;
  permissions: Record<string, Record<string, boolean>>;
  updatedAt: IsoTimestamp;
}

/** dashboard_config/collaborators — collaborator list. */
export interface CollaboratorsDoc extends Extensible {
  id: string;
  collaborators: string[];
  updatedAt: IsoTimestamp;
}

/** dashboard_config/quoteTemplateMap — quote template mapping. */
export interface QuoteTemplateMapConfigDoc extends Extensible {
  id: string;
  map: Record<string, string>;
  updatedAt: IsoTimestamp;
}