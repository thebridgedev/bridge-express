# Bridge Express — Team & Workspace

**Read this first: there is no team-management API in this plugin, and that is deliberate.**

If you are looking for `listMembers()`, `inviteUser()`, `updateRole()` or a team router, they do not exist in `@nebulr-group/bridge-express` and are not coming. This guide says so up front rather than letting you find out by grepping.

## Decide first — where does this belong?

| What you want | Where it lives |
|---|---|
| A UI to list, invite, remove or re-role members | The **frontend** Bridge plugin — `TeamManagementPanel` in svelte / react / nextjs |
| Programmatic member CRUD from a script or backend job | The **Bridge management API**, via MCP tools or `bridge user …` / `bridge tenant …` on the CLI |
| Know which workspace the current request belongs to | This plugin — `req.bridgeTenant` |
| Gate a route on the caller's role | This plugin — `bridge.protect({ role })` |
| Store your own per-workspace data | Your database, keyed by `req.bridgeTenant.id` |

The split is not arbitrary. Team membership is Bridge platform state owned by bridge-api. A backend plugin that also mutated it would be a second writer to someone else's data, with its own cache and its own idea of what a role means.

## What this plugin does give you

### The current workspace

```ts
import { Request, Response } from 'express';

app.get('/cases', bridge.protect(), (req: Request, res: Response) => {
  const tenant = req.bridgeTenant!;
  const user = req.bridgeUser!;

  // tenant.id is the workspace this request belongs to. Scope EVERY query by
  // it — this is the line that keeps one customer's data out of another's.
  res.json(casesService.findAllByTenant(tenant.id));
});
```

Both come from the verified JWT — no extra network call, and unspoofable without a valid signature.

> **Scope by `tenant.id`, always.** A missing tenant filter is the most damaging bug available in a multi-tenant backend, and it is invisible while you are testing with one workspace. If a query cannot be scoped, be able to say why.

### Gating on role

```ts
app.delete('/workspace/members/:id', bridge.protect({ role: 'OWNER' }), (req, res) => {
  // Your own logic. Removing the member from BRIDGE is a management-API call,
  // not something this plugin can do.
});
```

`bridge.protect({ role })` applies to user-JWT callers only. For API-token callers, branch on `req.bridgeApiToken` and check its privileges — see `auth-prompt.md`.

Prefer privileges over roles where the SDK offers both: privileges survive a role rename.

## Managing members for real

Over MCP:

| Task | Tool |
|---|---|
| List workspaces | `list_tenants` |
| Create a workspace | `create_tenant` |
| Add a user to a workspace | `create_tenant_user` |
| Change a member's role | `update_tenant_user` |
| Remove a member | `delete_tenant_user` — destructive, needs confirmation |

On the CLI: `bridge tenant list`, `bridge tenant create`, `bridge user invite`, `bridge user update`, `bridge user delete`.

Both channels are equivalent. Use whichever the caller has; do not send someone to the dashboard just because you happen to have one of them.

> Destructive operations require a token carrying the matching privilege. A default `bridge auth login` token deliberately has none — `bridge auth login --admin` requests them. Over MCP the token needs the destructive privilege enabled explicitly, and the tool will ask for confirmation.

## Common mistakes

- **Building a `/team/members` proxy route** that forwards to Bridge. The frontend plugin already talks to Bridge directly with the user's token. A proxy adds a hop, a second place for role logic to drift, and a new way to leak another workspace's members.
- **Caching membership in your own database.** It goes stale the moment someone is removed — and the stale copy is the one your authorization check reads.
- **Trusting a `tenantId` from the body or query string.** Use `req.bridgeTenant`. A body field is caller-controlled; the JWT claim is not.
- **Forgetting that `req.bridgeUser` is undefined on an API-token request.** A dual-auth route must handle both, or it throws on the first server-to-server call.

## Related guides

- `integration-prompt.md` — wiring `createBridge()` in, if you have not yet
- `auth-prompt.md` — token verification, roles, privileges, dual-auth routes
- The frontend plugin's `team-prompt.md` — where the UI actually goes
