---
title: Assign roles to users
description: Inviting users and changing their role — a management-plane operation, not something your Express app does at request time.
sidebar:
  label: Express
---

# Assign roles to users

Assigning a role to a user is a management-plane operation against Bridge, not something `@nebulr-group/bridge-express` exposes an API for — there's no `bridge.assignRole(...)` call in this package. Your Express backend's job is to *read* the role off a verified request (see [Getting the user token](/auth/user-token/getting-the-token/)) and *enforce* it (see [How roles & privileges work](/auth/roles/how-it-works/)); assignment itself happens via the CLI, Control Center, or a frontend Bridge SDK's drop-in team-management UI.

## Inviting a new user with a role

```bash
bridge user invite --email jane@example.com --role SUPPORT --tenant-id <tenantId>
```

`--tenant-id` can be omitted if you've set the `BRIDGE_TENANT_ID` environment variable. `--role` can be omitted too — the user gets whichever role is marked `isDefault` for your app.

## Changing an existing user's role

```bash
bridge user update --user-id <userId> --role ADMIN --tenant-id <tenantId>
```

## If your product needs an in-app "change this user's role" flow

That flow lives in your frontend, not your Express backend — a frontend Bridge SDK ships a drop-in team-management component that calls Bridge directly on the signed-in admin's behalf. Your Express app doesn't need to (and today can't) proxy that call itself: `bridge-express` only verifies tokens and reads their claims, it does not wrap Bridge's role/user management endpoints.

Handle the one business rule that surfaces as an error either way — see [The owner role](/auth/roles/owner-role/) for what happens when someone tries to demote a tenant's last `OWNER`.
