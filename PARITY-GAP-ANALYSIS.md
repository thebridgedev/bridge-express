# bridge-express parity gap analysis

**Ticket:** TBP-516 · **Date:** 2026-08-11 · **Compared against:** bridge-nestjs (closest peer)

This is an assessment, not a proposal. It says what is different, what each
difference costs a user, and roughly what closing it would take. The design
decision — whether to close these gaps at all, and how — is TBP-516's to make.

**Sources.** `bridge-express` was read at `origin/main`, not at the
`refactor/big-ass-refactor` checkout, because the branch is materially stale
(§0). `bridge-nestjs`, `auth-core` and `bridge-api` were read on
`refactor/big-ass-refactor`, including bridge-nestjs's uncommitted working tree
where noted.

**Read these three findings before the gap list.** The first is a bug that has
nothing to do with parity and should not wait for it; the other two move most of
the flag work out of "large re-architecture" and into "small SDK change":

1. **The flag cache is shared across every user of an app.** The cache key is
   `accessToken.substring(0, 16)`, which is byte-identical for every token
   bridge-api issues. One user's evaluations are served to all others for five
   minutes, defeating role, plan, tenant and rollout targeting. Confirmed, and
   present in bridge-nestjs too. **This is a data-separation bug on a live beta**
   (§3.5).
2. The cloud-views endpoint express already calls is **not** the boolean legacy
   thing it looks like. It runs the same FF 2.0 evaluator as the SDKs — rules,
   segments, percentage rollout, typed values — and already returns the typed
   value on the wire. express throws it away (§1).
3. bridge-nestjs's FF 2.0 module is **substantially unwired out of the box** — no
   boot hydration, an empty realtime channel list, no attribute providers. The
   parity bar is a good deal lower than its documentation implies (§2).

---

## 0. Before anything else: the branch is stale

`refactor/big-ass-refactor` in this repo is **1 ahead / 4 behind `origin/main`**,
and the four missing commits include:

```
d5f2871 feat: port bridge-nestjs backend feature set to bridge-express
9b9fc05 fix(deps): resolve auth-core 0.4.0-beta.6 from public npm, not Verdaccio (#1)
3d7b779 docs(learning): add a backend-adapted Auth section
632b4a3 release: bridge-express v0.1.0-beta.1 (#2)
```

`d5f2871` is the entire backend feature port — 1,956 insertions across 17 source
files. The branch checkout predates API-token introspection, plan and entitlement
gating, `BridgeService`/`TenantScope`, the `privilege`-based `RouteRule`, and the
move from `authBaseUrl`/`backendlessBaseUrl` (`*.nblocks.cloud`) to a single
`apiBaseUrl`. Anyone judging express from the branch is reading a package that no
longer exists, and judging it far too harshly.

**Effort: small.** Merge `origin/main` into the branch before anything else.

Two smaller staleness problems on main, worth folding into the same pass:

- **`bridge-express/README.md` contradicts main's own source.** It documents
  `authBaseUrl` / `backendlessBaseUrl` defaulting to `*.nblocks.cloud` and a
  `RouteRule` shaped `{ path, public, role, methods }`. Real config on main is
  `apiBaseUrl`, and the real `RouteRule` is
  `{ path?, graphqlOperation?, privilege, featureFlag?, plans?, entitlement?, entitlements? }`.
  The `learning/` docs are correct; the README is not. **Effort: small.**
- **`RouteRule.graphqlOperation` is dead config.**
  `BridgeConfigService.findMatchingRule(path, method, operationName?)` handles
  GraphQL operation names, but `createAuthMiddleware` only ever calls
  `findMatchingRule(path, method)` — nothing produces an operation name.
  **Effort: small–medium** (needs a parsed GraphQL body, which means ordering
  against the user's GraphQL middleware).

---

## 1. The endpoint express already calls is FF 2.0

This is the correction that matters most, because it invalidates the obvious
reading of express's flag code.

`FeatureFlagService` POSTs to
`{apiBaseUrl}/cloud-views/flags/bulkEvaluate/{appId}` and reads
`evaluation.enabled`. That looks like a legacy boolean API. It is not.

**The endpoint is live and explicitly retained.**
`microservices/app-config/cloud-views/feature-flags/feature-flags.controller.ts`
carries `@VersionedController('cloud-views/flags', 'cloud-views')` with
`@Post('bulkEvaluate/:appId')` and `@Get|@Post('evaluate/:appId/:flagKey')`. The
dedicated `app-config` Lambda exists specifically to serve it —
`app-config-edge.module.ts` says it "*serves ONLY the flag/brand READ-MODEL
surface*". `docs/plans/cloud-views-endpoint-cleanup.md` lists both routes under
keep-alive; `docs/plans/sdk-auth-architecture.md` says "**FeatureFlagsController**
… **Still needed**" and "Cloud-views is **never deprecated**." There are zero
`@Deprecated` usages in bridge-api. So express is not calling a dying endpoint,
and "express is on a path the platform is retiring" would be wrong.

**Server-side, it runs the same evaluator as every SDK.**
`feature-flags.service.ts` loads flags from Mongo (5-min server cache, fail-safe
to stale) and calls `evaluateV3`, which switches on
`state: 'off' | 'on' | 'on-with-rule'` and delegates `on-with-rule` to
`evaluateRule` — a re-export of auth-core's evaluator, the same code bridge-api,
the SDKs and the CLI's `flag eval` all run. That means **targeting rules,
segments, operators, dotted attributes and percentage rollout are already applied
to express's evaluations today**, with identity resolved as
`user.id || tenant.id || device.key`.

**The typed value is already on the wire.** `EvaluationResponse`:

```ts
export interface EvaluationResponse {
  /** Legacy boolean result … for non-boolean FF 2.0 flags this is `true` when a
   *  non-default value is served (matched) … Most v1/v2 SDK consumers only read
   *  this field. */
  enabled: boolean;
  /** FF 2.0 — the actual returned value, typed per the flag's `valueType`. */
  value?: unknown;
  /** FF 2.0 — which branch matched, 0-indexed. -1 means the otherwise value. */
  variantIndex?: number;
}
```

express's response interface declares only `{ evaluation?: { enabled: boolean } }`
and drops `value` and `variantIndex` on the floor.

**The request already accepts a context bag.** The body DTO is
`BodyWithCtxAndToken { context?: Context; accessToken?: string }`, where
`Context` is `{ user?, tenant?, device?, custom?: Record<string, string> }` and
`contextToEvalContext` flattens it into dotted attributes. express sends only
`{ accessToken }`.

**Consequence.** Several things this document would otherwise file under "needs
the FF 2.0 runtime" are actually **client-side omissions in a wire protocol that
already supports them**: typed values, variant index, custom targeting
attributes, and a caller-supplied identity for anonymous/M2M bucketing. Those are
small changes to `feature-flag.service.ts`, independent of any re-architecture.

What genuinely does require the local runtime: synchronous reads, no network on
the request path, live push updates, freeze-on-outage, and discovery telemetry.

---

## 2. What bridge-nestjs actually has — and how much of it is wired

nestjs carries **two parallel flag implementations in two separate entry points
that share nothing** — no cache, no context, no config, different endpoints:

| | entry point | mechanism |
|---|---|---|
| auth-coupled | root barrel — `FeatureFlagService`, `@RequireFeatureFlag`, `RouteRule.featureFlag` | remote eval against cloud-views, user-JWT-keyed, 5-min cache |
| FF 2.0 | `/flags` barrel — `BridgeFlagsModule`, `BridgeFlagsService`, `@RequireFlag`, `@Flag` | local in-process eval via auth-core, auth-free |

**"express is on the old path nestjs migrated off" is not accurate.** nestjs has
not migrated off anything. Its root barrel still exports the legacy service, its
`BridgeModule` still provides it, and `BridgeAuthGuard` still injects it — the
*newest* feature in that guard, TBP-472 route-rule gating (currently uncommitted),
deliberately reuses the legacy evaluator: "*Reuses the decorator eval path.*"
Neither the service nor `@RequireFeatureFlag` carries a `@deprecated` tag, and
the README presents the two as a **choice**, not a migration. The accurate
framing is: **nestjs additionally ships FF 2.0 as a second, parallel entry
point; express does not.**

express's `src/services/feature-flag.service.ts` is a byte-for-byte copy of
nestjs's legacy service (differences: `@Injectable()`, trailing whitespace, one
comment) — expected, since express was ported from nestjs in `d5f2871`. So
`bridge.protect({ featureFlag })` on express is at **genuine parity** with
`@RequireFeatureFlag` on nestjs. The whole gap is the missing second entry point.

### And that second entry point is largely unwired

Read carefully, bridge-nestjs's FF 2.0 module does much less out of the box than
its docs promise. Every one of these is from its own source or its own
`mcp/feature-flags-prompt.md`:

- **No boot hydration.** Nothing in bridge-nestjs calls `hydrate()`. The
  documented pattern is for the *consumer* to fetch
  `/admin/flags-internal/flags-cache/{appId}` in `onModuleInit` themselves. The
  prompt states it plainly: "*The module does **not** fetch flags on boot.*"
- **Realtime subscribes to nothing by default.** `channelsToSubscribe()` builds
  from `appId` / `workspaceId` / `userId` on the `RealtimeClient` —
  `BridgeFlagsModuleOptions` has **no such fields**, and bridge-nestjs never sets
  them. Unless the consumer hand-passes them through `opts.realtime`, the channel
  list is **empty** and no flag update ever arrives. The advertised "flip a flag
  and it reaches every connected service within seconds" does not happen by
  itself.
- **No refresh, no re-hydrate on reconnect.** "*there is no `refresh()` on
  `BridgeFlagsService`, and no automatic re-hydrate after a websocket
  reconnect*". bridge-nextjs wires `setOnOpen` to re-hydrate; bridge-nestjs
  does not.
- **Pull mode does not pull.** `BridgePullCache` is provided as
  `BRIDGE_PULL_CACHE` but the module never consumes it — "*that pull cache is not
  wired into flag reads*".
- **No attribute providers.** bridge-nestjs registers zero. "*This SDK does not
  auto-register `AuthAttributeProvider`; nothing wires your JWT into the eval
  context for you.*" Attributes come from the `x-bridge-context` header **only** —
  nothing reads role/plan/tenant from verified claims. (bridge-nextjs registers
  both auth and billing providers; nestjs does not.)
- **`@RequireFlag({ optional: true })` is broken.** It returns `false` from
  `canActivate`, which Nest turns into a 403 anyway. Documented as a bug; the
  spec asserts the buggy behaviour.
- **`BridgeFlagGuard` and `@Flag` are HTTP-only** — no GraphQL branch, unlike
  `BridgeAuthGuard`.
- **`/flags` does not resolve.** No `exports` map, `files: ["dist"]`;
  `require.resolve('@nebulr-group/bridge-nestjs/flags')` → `MODULE_NOT_FOUND`.
  Only `/dist/flags` works. The README ships the broken path.

**Why this matters for TBP-516.** The realistic parity target is not "match a
polished FF 2.0 integration" — it is "match a module that gives you a local
evaluator and expects you to wire the rest." That is a much smaller target, and
it makes a strong case for doing the cheap §1 wins on express *now* regardless of
the architectural decision. It is also a reason to fix nestjs's wiring in the
same initiative rather than copying it verbatim.

---

## 3. Gap-by-gap

### 3.1 Evaluation mechanism — remote per-request vs local in-process

**express.** `isEnabled(flag, accessToken, forceLive?)` is `async`; a cold read
is a network round trip on the request path. Any non-200 or thrown error resolves
`false`, and `protect({ featureFlag })` turns that into a **403**.

**nestjs FF 2.0.** `flag()` is **synchronous** against an in-memory `Map`. No
network on read. On channel loss, flags freeze on last-known values.

**Cost.** Latency and a hard dependency on Bridge in the hot path. `await`
everywhere, so flags can't be read in sync code. And the failure modes are
opposite in the worst way: a Bridge blip is a **customer-visible 403** on express
and a **no-op** on nestjs. The `learning/` docs are honest about this and steer
users toward branching in the handler instead of gating — but gating is what the
API makes easy.

**Effort: large.** This is the TBP-516 decision. Mechanically it is "port
`src/flags/` minus the DI": a `bridge.flags` handle over one
`BridgeFlags({ mode: 'backend' })`, boot hydration from
`/admin/flags-internal/flags-cache/{appId}`, and either a `RealtimeClient` or a
`BridgePullCache`. The genuinely new design question is lifecycle — express has
no `onModuleDestroy`, so socket and telemetry teardown must become an explicit
`bridge.close()`.

### 3.2 Value types — boolean-only client over a typed wire

**express.** `Promise<boolean>`, everywhere. Its own response interface omits the
`value` field the server already sends.

**nestjs FF 2.0.** `flag<T>(key, defaultValue, context?): T`, `T` inferred from
the default; `FlagValueType = 'boolean' | 'string' | 'number' | 'json'`.

**Cost.** No multivariate flags: no string variants, no numeric config from
Control Center (rate limits, batch sizes), no JSON blobs. A flag definition
cannot be shared between a Nest service and an Express service.

**Effort: SMALL — and independent of §3.1.** Widen the response interface to
carry `value` / `variantIndex` and add a typed
`flagValue<T>(key, defaultValue, accessToken): Promise<T>` next to `isEnabled`.
Note the semantic trap to document: for non-boolean flags `enabled` means "a
branch matched", not "the value is truthy". Reads stay async and remote; that is
§3.1's problem, not this one.

### 3.3 Eval context and identity sources

**express.** One input: the verified user JWT, sent whole. No identity override,
no attributes. `learning/feature-flags/targeting/send-context.md` argues this is
a deliberate security boundary — "*no `x-bridge-context` header to read, no
context object to deserialize, and no per-evaluation attribute bag*".

**nestjs FF 2.0.** `Partial<EvalContext>` per call, layered
`providers < setContext globals < per-call context`;
`BridgeContextInterceptor` deserializes `x-bridge-context` into
`req.bridgeFlagsContext`; identity falls back
`propagated?.identity ?? req.bridgeUser?.id ?? req.user?.id`.

**Cost.**
- **No flags outside authenticated user traffic.** API-token callers, anonymous
  requests, webhooks and cron jobs get nothing on express. nestjs's flags module
  is explicitly auth-free.
- **No frontend↔backend bucket continuity.** A browser SDK mints an anonymous ID
  and forwards it in `x-bridge-context`; a Nest API buckets the same pre-login
  visitor identically. An Express API cannot.
- **No app-specific targeting** ("on for accounts with >3 projects").

**Effort: SMALL–MEDIUM, and mostly independent of §3.1** — because the endpoint
already takes the context bag. Sending `{ context, accessToken }` gives express
custom attributes and, via `device.key`, a caller-supplied identity for anonymous
and M2M bucketing, without any local runtime.

Two caveats. First, the doc's framing has to change: the missing context bag is
presented as a security boundary, and it isn't one — nestjs holds the same
boundary while accepting propagated context, because identity still prefers the
*verified* user and rules only read attributes they were written to read. Second,
the security *concern* is real and the API should make the safe thing easy:
server-supplied attributes only, never blind pass-through of a request body.

### 3.4 Rules, targeting and rollouts

Because §1's endpoint runs the real evaluator, express **already benefits from**
flag states (`off` / `on` / `on-with-rule`), first-match-wins AND-ed branches,
the full operator set (`eq, neq, contains, not_contains, in, not_in, gt, lt,
between, regex, exists, not_exists`), dotted-path attributes, saved segments via
`groupRef`, and `rolloutPct` bucketed by FNV-1a over `` `${flagKey}|${identity}` ``
— all applied server-side, for authenticated users.

What express cannot reach:

- **Multivariate output.** Branch `returnValue`s and `otherwiseValue` collapse to
  a single boolean (§3.2 — small fix).
- **Rollout for anyone without a user JWT.** Server-side identity is
  `user.id || tenant.id || device.key`; express supplies none of them for
  anonymous or M2M callers (§3.3 — small fix).
- **Client-side rule inspection**, so nothing can be evaluated offline or without
  a round trip (§3.1).

**Cost.** Smaller than it first appears: gradual rollout *does* work today for
logged-in users. It does not work for pre-login funnels, and it can't be observed
or reasoned about locally.

**Effort: small for the two fixable halves; the rest is §3.1.**

### 3.5 Caching and refresh — the worst operational gap

**express.** `Map<tokenPrefix, Map<flag, boolean>>` keyed on the **first 16
characters of the access token**, TTL 5 minutes, no eviction, no size bound, no
invalidation hook.

**nestjs FF 2.0.** Rule cache is a `Map` with no TTL, kept correct by push;
`BridgePullCache` (30 s TTL, in-flight dedupe) on the pull path.

**Cost.**
- **Up to 5 minutes of staleness on a kill switch.** This is the most damaging
  consequence in this document. "Flip the flag off, it's a kill switch, no
  redeploy" is the product promise; on express, flipping it off leaves it on for
  up to five more minutes for every already-warm token. Note the server's own
  flag cache adds up to 5 more minutes on top.
- **Unbounded memory.** One entry per distinct token prefix, never evicted.
- **The cache key is the same string for every user. Confirmed.** This is a
  data-separation bug, not a parity gap, and it is the most serious thing in this
  document.

  ```ts
  private getCacheKey(accessToken: string): string {
    return accessToken.substring(0, 16);
  }
  ```

  The code comment calls it "enough for uniqueness". It is not. 16 base64url
  characters encode the first **12 bytes** of the JWT's protected header — and
  the header is a property of the *signing key*, not the *user*:

  | header JSON | first 16 chars of the JWT |
  |---|---|
  | `{"alg":"PS256","typ":"JWT"}` | `eyJhbGciOiJQUzI1` |
  | `{"alg":"PS256","typ":"JWT","kid":"abc123"}` | `eyJhbGciOiJQUzI1` |
  | `{"alg":"RS256","typ":"JWT"}` | `eyJhbGciOiJSUzI1` |

  `kid` does not reach into the first 16 characters, and neither does anything
  else that varies per token. Every access token bridge-api issues for a given
  app therefore truncates to the **same** key, so `cache` and `cacheTimestamps`
  hold exactly one entry for the entire process.

  **Consequence:** the first authenticated request warms the flag cache, and for
  the next 5 minutes *every other user of that app is served that user's flag
  evaluations* — including flags targeted by role, plan, tenant or rollout
  bucket. A user in a 10% rollout turns the feature on for everyone; an
  ADMIN-targeted flag opens for non-admins; a tenant-scoped flag leaks across
  tenants. `forceLive: true` is the only escape, and nothing sets it.

  This is **also present verbatim in bridge-nestjs** (`src/services/feature-flag.service.ts`),
  since express was copied from it — so both SDKs are affected, on every route
  using `@RequireFeatureFlag`, `protect({ featureFlag })` or a route rule's
  `featureFlag`.

  **Fix: small.** Key on a hash of the whole token (or on `tid:sub` from the
  decoded claims, matching what `BridgeService.fromJwt` already does), and bound
  the map. Split this out of TBP-516 and fix it now, in both packages.

**Effort: small** for the cache key and a bound, independent of everything else.

### 3.6 Realtime updates

**express.** None — no WebSocket, no SSE, no polling. Freshness is the 5-minute
TTL.

**nestjs.** A `RealtimeClient` supporting Centrifugo and AppSync Events, handling
`flag.updated` → `bridge.upsert` and `flag.removed` → `bridge.remove`, with
exponential-backoff reconnect (1 s → 30 s cap). Channels come from
`/realtime/config`, authorized via `POST /realtime/authorize`; bridge-api
publishes on `app:<appId>` from `feature-flags.service.ts`.

**But** see §2: bridge-nestjs never sets `appId`/`workspaceId`/`userId` on the
client, so its default channel list is empty and it receives nothing either. The
real gap here is smaller than the docs claim on both sides.

**Effort: medium**, gated on §3.1. The client is auth-core code; the
express-specific work is lifecycle and teardown — plus setting the channels,
which nestjs got wrong.

### 3.7 Telemetry

**express.** No client telemetry. It is not entirely invisible, though: each
`bulkEvaluate` fires a `bridge.flag_evaluations` usage event server-side, one per
flag. (Amusingly, bridge-nestjs passes no `usageReporter`, so its FF 2.0 path
does *not* fire that event — express produces eval usage data that nestjs's FF
2.0 path does not.)

**nestjs FF 2.0.** `TelemetryBatcher` posts to `/v1/flags/eval-events`,
`/v1/flags/discover` and `/v1/flags/call-sites`, with a 30 s flush, a 500-event
cap and a 1 s `firstSightFlushMs` debounce so a newly-seen flag reaches the admin
within about a second. Discovery auto-creates unknown flag records as `off`;
attribute observation populates the admin's attribute catalog and autocomplete.

**Cost.** The real loss is **discovery and the attribute catalog**, not eval
counts. An Express-only app never auto-registers flags it references, and never
populates the attribute autocomplete an admin uses to write rules — so writing a
targeting rule against an Express service means typing attribute names blind.

**Effort: medium**, free with §3.1.

### 3.8 Auth surface — near parity, four real gaps

Since `d5f2871`, express's auth is a faithful port and the shared `runGuard`
carries the same comments as nestjs's guard. At parity:

- User JWT verification through auth-core's backend `JwksService` (remote JWKS,
  local `jose` verify, 1 h key cache, issuer/audience checks) with identical RFC
  6750 error mapping across `TOKEN_EXPIRED / TOKEN_INVALID / JWKS_NO_MATCH /
  CLAIM_VALIDATION_FAILED / APP_MISMATCH`.
- API-token (`x-api-key`) verification by introspection, optional TTL cache
  (`introspectionCacheTtlMs`, default `0` = instant revocation), same
  pre-processed / JWT-shaped / opaque three-way split.
- Independent evaluation of both credential paths so contexts coexist, including
  the cloud-views "always sends both" case and the `acceptAuth: 'jwt'` special
  case.
- `acceptAuth`, `privilege` (API-token only), `role` (user-JWT only), route-rule
  `privilege`.
- Plan and entitlement gating with 402 + `plan_required` / `entitlement_missing`
  / `billing_locked`, failing closed on snapshot error.
- `fromJwt(userJwt) → TenantScope` with `snapshot()` / `subscription` /
  `branding` / `user` / `entitlements.can|canSync|snapshot` / `invalidate()`,
  over `GET /session/init`, memoized through `BridgePullCache`.
- `BridgeHttpService` token-forwarding; `userJwksUrl` / `introspectionUrl` Docker
  escape hatches.

The gaps:

1. **GraphQL is unsupported in practice.** nestjs's guard has a first-class
   GraphQL branch that resolves `operationName` from `info.fieldName` and matches
   `graphqlOperation` rules. express declares the rule field and never populates
   the operation name (§0). **Effort: small–medium.**
2. **No `usage` slice on `TenantScope`.** nestjs recently gained
   `tenant.usage.report(metric, value, idempotencyKey?)` → `POST /usage/ingest`
   and `tenant.usage.quota(metric)` → `GET /usage/quota/:metric`. express has
   subscription / branding / user / entitlements but no usage. This is fresh and
   uncommitted on nestjs's side, so it is drift rather than neglect. **Effort:
   small** — same snapshot plumbing.
3. **`bridge.tenant(tenantId)` throws, unimplemented.** Blamed on a missing
   bridge-api admin snapshot endpoint that accepts the workspace API key. nestjs
   has the identical hole for the identical reason, so this is a *platform* gap
   that happens to sit on express's surface. **Effort: medium, blocked on
   bridge-api.**
4. **No decorator ergonomics**, by nature — `@Public`, `@RequireRole`,
   `@AcceptAuth`, `@CurrentUser`, `@CurrentTenant` have no express equivalent
   beyond `protect({...})` and reading `req.bridgeUser`. Not a defect, but it is
   why an express rule set drifts from its handlers more easily, and it argues
   for treating `guard.rules` as the primary surface in express rather than the
   fallback. **Effort: n/a — accept it.**

### 3.9 Test and documentation coverage

- **Unit specs**: express is well covered on main — `auth.middleware.spec.ts`
  alone is 744 lines of the port diff, plus `bridge`, `tenant-scope`, `jwks`,
  `bridge-config`, `feature-flag`. No concern.
- **E2E**: express and nestjs ship the *same* four suites — `api-token`,
  `auth-guard`, `health`, `roles`. **Neither has a feature-flag e2e.** A shared
  gap, worth its own ticket, and a real risk given how much of §1 depends on the
  exact response contract.
- **Learning docs**: express's `learning/feature-flags/` is complete, well
  written, and accurate about the *client*. It does not oversell. But it
  **understates the platform**: it describes evaluation as returning
  "enabled / not-enabled" with "no string/number/JSON variant values on this
  path", when the endpoint returns exactly those (§1). That is a documentation
  bug independent of any code change. If express is re-architected the whole
  section needs rewriting, and that rewrite is not small — budget for it.

---

## 4. Ranked by user impact

| # | Gap | Impact | Effort |
|---|---|---|---|
| 1 | **Flag cache is shared across all users** (§3.5) — the 16-char token prefix is identical for every token. **Confirmed** | One user's flag evaluations are served to every other user for 5 minutes, defeating role/plan/tenant/rollout targeting. Not a parity gap — a data-separation bug. Present in bridge-nestjs too. Fix outside TBP-516, now | Small |
| 2 | **5-minute kill-switch staleness** (§3.5) | Breaks the core product promise in the one scenario where latency matters most — an incident | Small (bound the cache) / free with #6 |
| 3 | **Typed values discarded** (§3.2) — `value` and `variantIndex` are on the wire and dropped | No multivariate flags, no remote config, no flag shared with a Nest service — for no technical reason | **Small** |
| 4 | **No context bag sent** (§3.3) — the endpoint accepts one | No flags for anonymous / M2M / webhook traffic, no frontend↔backend bucket continuity, no app-specific targeting | **Small–medium** |
| 5 | **Remote eval fails closed** (§3.1) — a Bridge blip becomes a customer-visible 403 | Availability coupling on every gated route | Small to mitigate (document + a fail-open option); large to remove |
| 6 | **No local evaluation** (§3.1) | Latency on the hot path, `await` everywhere, no freeze-on-outage, no live updates | Large — the TBP-516 decision |
| 7 | **No discovery telemetry** (§3.7) | Flags aren't auto-registered and the admin's attribute catalog is blind to Express apps — rules get written against guessed attribute names | Medium, free with #6 |
| 8 | **No realtime channel** (§3.6) | Cause of #2 — though nestjs's channel list is empty by default too, so the practical gap is narrower than documented | Medium, gated on #6 |
| 9 | **Branch 4 commits behind main** (§0) | Every assessment from the branch understates express; work started there will conflict | Small — do it first |
| 10 | **GraphQL unsupported; no `usage` slice; stale README** (§0, §3.8) | Config that silently does nothing; a user following the README writes options the code ignores | Small each |

**Reading of the table.** Items 1–4 and 9–10 are cheap, independent, and worth
doing whatever TBP-516 decides — and 3 and 4 alone close most of the *functional*
flag gap. Items 5–8 are one piece of work wearing four hats: port FF 2.0 to
express. Nothing in 7–8 is worth starting before 6.

---

## 5. What "closing it" would actually mean

Sketched only, to size the decision.

The favourable part: FF 2.0's machinery is in `auth-core`, is framework-agnostic,
and nestjs's module is a thin wrapper. The express equivalent is roughly a
`createBridgeFlags(config)` / `bridge.flags` handle over one
`BridgeFlags({ mode: 'backend' })`; boot hydration from
`/admin/flags-internal/flags-cache/{appId}` through `BridgePullCache`; a
`runtimeMode` switch between a `RealtimeClient` and pull-only; an
`x-bridge-context` middleware mirroring `BridgeContextInterceptor`; and
`TelemetryBatcher` wiring.

The unfavourable part, and why this is *large*:

- **An explicit teardown call.** express has no DI lifecycle, so socket and
  telemetry shutdown must be the user's `bridge.close()`. This is the one
  genuinely new design question, and getting it wrong leaks sockets in tests and
  serverless.
- **Two flag paths coexist during migration.** `protect({ featureFlag })` and
  route-rule `featureFlag` shipped in `0.1.0-beta.1` and are documented. Either
  they move onto the local evaluator — a behaviour change in three dimensions at
  once (fail-closed → fail-to-default, async → sync, boolean → typed) — or they
  stay remote alongside a new local path, which is exactly the two-sources-of-
  truth situation nestjs is in and which is not obviously good.
- **Do not copy nestjs's wiring.** Copy its structure and fix what §2 lists:
  hydrate on boot, set the realtime channels, re-hydrate on reconnect, wire the
  pull cache into reads, register attribute providers, and fix
  `@RequireFlag({ optional: true })`. Several of those fixes belong upstream in
  bridge-nestjs too.
- **`learning/feature-flags/` is invalidated** — seven files arguing *for* the
  remote model.
- **The CLI scaffold and `mcp/feature-flags-prompt.md` change with it.** The
  express scaffold in `bridge-cli`'s `flag init` was just corrected to the real
  current API under TBP-206; it will need correcting again.
- **A packaging decision comes due.** express has no `exports` map. If a flags
  entry point is added, do not repeat bridge-nestjs's mistake — its own
  `src/flags/index.ts` and README document
  `@nebulr-group/bridge-nestjs/flags`, which resolves to `MODULE_NOT_FOUND`
  because the package has no `exports` map and ships only `dist/`.

---

## 6. Recommended sequencing, independent of the TBP-516 decision

1. **Fix the shared flag cache (§3.5) in express *and* nestjs.** Confirmed, not
   suspected. This is a data-separation bug on a live beta and does not belong to
   TBP-516; give it its own ticket and ship it first.
2. **Merge `origin/main` into `refactor/big-ass-refactor`** (§0).
3. **Take the cheap FF 2.0 wins** (§3.2, §3.3): read `value` / `variantIndex`,
   send the `context` bag. Small, additive, no architectural commitment, and they
   close most of the functional flag gap on their own.
4. **Fix the docs and the dead config** (§0, §3.9): the README, the
   `graphqlOperation` field, and the `learning/` claim that the endpoint is
   boolean-only.
5. **Then** decide §3.1 on TBP-516, with §2 in hand — the bar is lower than
   nestjs's documentation suggests, and part of the work is fixing nestjs.
