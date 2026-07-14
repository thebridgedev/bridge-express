# Send context from your code

Rules target on data. On a Bridge frontend, you can hand the SDK arbitrary
attributes — a cart size, a project count — for a rule to match on. On the
backend the model is deliberately narrower, and understanding why keeps your
targeting correct.

## What the backend already supplies — for free

Bridge Express evaluates a flag against the requesting user's **verified access
token**, and sends only that token to Bridge. So the identity a rule can target
— `user.role`, `user.email`, `tenant.id`, `tenant.plan`, `privileges` — is
supplied automatically, from a source the caller can't forge. You write no code
to make it available; it's in the token. See
[Target by plan or role](/feature-flags/targeting/by-plan-or-role/).

For the vast majority of backend gating, that's all you need — you're deciding
"can *this authenticated user* reach this?", and the token answers it.

## Why the backend doesn't forward client attributes

The Express flag API has **no mechanism to attach arbitrary attributes or a
client-supplied identity** to a server-side evaluation. That's a deliberate
security boundary, not a gap:

- A backend must never trust `role`- or `plan`-style attributes handed to it by
  a client — it reads those from its own verified sources (the JWT, its own
  tenant record). Letting a request body inject targeting attributes would let a
  caller target *themselves* into a flag.
- The identity that matters — who the user is, what they're paying for — is
  already in the token, verified. There's nothing to forward.

So there's no `x-bridge-context` header to read, no context object to
deserialize, and no per-evaluation attribute bag on the Express side. Flag
evaluation is: *this token, this flag.*

## Targeting on an app-specific fact

When a decision genuinely depends on something only *your backend* knows — a
business fact that isn't in the token and isn't in Bridge, like "only accounts
with more than 3 active projects" — the flag rule can't reach it. Don't try to
push that fact into Bridge; instead, use the flag as a plain gate and apply the
extra condition in your own handler, against your own verified data:

```typescript
import { FeatureFlagService, BridgeConfigService } from '@nebulr-group/bridge-express';

const flags = new FeatureFlagService(new BridgeConfigService({ appId: process.env.BRIDGE_APP_ID! }));

router.get('/new-dashboard', async (req, res) => {
  const flagOn = await flags.isEnabled('new_dashboard', req.bridgeAccessToken!);
  const projectCount = await countProjects(req.bridgeUser!.tenantId); // your own data

  if (!flagOn || projectCount <= 3) {
    return res.status(403).json({ message: 'Not available' });
  }
  res.json(await buildDashboard(req.bridgeUser!.tenantId));
});
```

The flag stays a Control-Center switch you can flip per role/plan/tenant, and
the app-specific condition (`projectCount > 3`) is enforced where it belongs —
in your code, on data you trust. See
[Use flags in your logic](/feature-flags/using/in-logic/) for the in-handler
evaluation API.
