// TBP-745 — plan limits and entitlements: middleware + plain service calls.
export {
  USAGE_COUNTED_HEADER,
  type QuotaTenant,
  type QuotaCounter,
  type RequireQuotaOptions,
  type SyncQuotaOptions,
} from './quota.middleware';
export {
  BridgeQuotaService,
  BridgeRefusalError,
  QuotaExceededError,
  EntitlementRequiredError,
  type QuotaExceededBody,
  type EntitlementRequiredBody,
  type QuotaCount,
  type QuotaCheckOptions,
  type QuotaDecision,
  type QuotaRecordOptions,
} from './quota.service';
