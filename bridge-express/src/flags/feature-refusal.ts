// bridge-express/flags — a flag-gated route that refuses says why (TBP-756).
//
// `protect({ featureFlag })` and a route rule's `featureFlag` refuse with one
// of three bodies:
//
//   402 FEATURE_NOT_IN_PLAN   — an upgrade alone would turn the feature on
//   403 FEATURE_NOT_PERMITTED — the person's role or privileges keep it off
//   403 FEATURE_OFF           — switched off, another condition, the rollout,
//                               or the reason is unknown
//
// Each names the flag and the fix. A 403 keeps the old `statusCode` / `error`
// / `message` fields, so a client reading those sees what it always saw.
//
// The same bodies bridge-nestjs sends, so a frontend handles both backends
// with one code path.

/** Why a feature is off — the same values auth-core's evaluator and Bridge's evaluate endpoint return. */
export type FeatureOffReason = 'plan' | 'permission' | 'off' | 'rule' | 'rollout';

/** Why a flag is off, as Bridge's evaluate endpoint said. */
export interface FeatureOffExplanation {
  reason?: FeatureOffReason;
  /** With `plan`: the plan feature the flag's rule asks for. */
  feature?: string;
}

export type FeatureRefusalCode = 'FEATURE_NOT_IN_PLAN' | 'FEATURE_NOT_PERMITTED' | 'FEATURE_OFF';

/** Body of a flag refusal. */
export interface FeatureRefusalBody {
  statusCode: 402 | 403;
  code: FeatureRefusalCode;
  error: 'Payment Required' | 'Forbidden';
  message: string;
  /** The flag (or `{any}` / `{all}` requirement, as JSON) that refused. */
  flag: string;
  reason?: FeatureOffReason;
  /** With FEATURE_NOT_IN_PLAN: the plan feature the rule asks for, when it names one. */
  feature?: string;
  /**
   * What fixes it. FEATURE_NOT_IN_PLAN: the path to upgrade at
   * (`billing.manageRoute`, default `/subscription`). The others: a sentence.
   */
  fix: string;
}

export const DEFAULT_MANAGE_ROUTE = '/subscription';

const REASONS: ReadonlySet<string> = new Set(['plan', 'permission', 'off', 'rule', 'rollout']);

/** The explanation in an evaluate response, or `{}` when it carries none. */
export function readExplanation(source: unknown): FeatureOffExplanation {
  if (!source || typeof source !== 'object') return {};
  const s = source as { reason?: unknown; feature?: unknown };
  if (typeof s.reason !== 'string' || !REASONS.has(s.reason)) return {};
  return {
    reason: s.reason as FeatureOffReason,
    ...(typeof s.feature === 'string' && s.feature ? { feature: s.feature } : {}),
  };
}

/** The refusal body for a flag that is off. */
export function featureRefusalBody(
  flag: string,
  explanation: FeatureOffExplanation | undefined,
  manageRoute: string = DEFAULT_MANAGE_ROUTE,
): FeatureRefusalBody {
  const reason = explanation?.reason;
  if (reason === 'plan') {
    const what = explanation?.feature ?? flag;
    return {
      statusCode: 402,
      code: 'FEATURE_NOT_IN_PLAN',
      error: 'Payment Required',
      message: `Your plan does not include '${what}'. Upgrade to use it.`,
      flag,
      reason,
      ...(explanation?.feature ? { feature: explanation.feature } : {}),
      fix: manageRoute || DEFAULT_MANAGE_ROUTE,
    };
  }
  if (reason === 'permission') {
    return {
      statusCode: 403,
      code: 'FEATURE_NOT_PERMITTED',
      error: 'Forbidden',
      message: `Feature flag '${flag}' is not enabled for your role or privileges`,
      flag,
      reason,
      fix: 'Ask a workspace admin for access.',
    };
  }
  return {
    statusCode: 403,
    code: 'FEATURE_OFF',
    error: 'Forbidden',
    message: `Feature flag '${flag}' is not enabled`,
    flag,
    ...(reason ? { reason } : {}),
    fix:
      reason === 'off'
        ? 'This feature is switched off for everyone.'
        : 'This feature is not available to this user.',
  };
}
