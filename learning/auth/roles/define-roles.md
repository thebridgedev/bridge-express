---
title: Define roles & privileges
description: Where roles and privileges are created and managed (Control Center and the CLI), not this package.
sidebar:
  label: Express
---

# Define roles & privileges

A **privilege** is a scoped permission key with a description, for example `USER_WRITE`, "Can create and edit users." A **role** bundles privileges under a name and a unique key, and is what you actually assign to users: define a privilege once, then include its key in as many roles as need it. (See [How roles & privileges work](/auth/roles/how-it-works/) for the full concept.)

Roles and privileges are app-level configuration, managed outside your Express backend entirely; `@nebulr-group/bridge-express` only *reads* and *enforces* them at request time. Definition happens in one of two places:

- **Control Center** (your admin dashboard at app.thebridge.dev): [Roles](https://app.thebridge.dev/roles) has separate **Roles** and **Privileges** tabs, with **Create Role** and **Create Privilege** buttons. This is the only way to create privileges today (see below).
- **CLI:** roles only. Create, update, delete, and list them, referencing privileges that already exist.
- **MCP (AI-assistant integration):** coming soon.

## Privileges

There's no CLI command for creating a privilege yet, only for referencing an existing one when you build a role (see below). If a route in your Express app needs a privilege that doesn't exist (referenced from a route rule like `{ path: '/users/*', privilege: 'USER_READ' }` or from `bridge.protect({ privilege })`), create it in Control Center first.

## Roles

**Create a role**, bundling privileges you've already defined:

```bash
bridge role create --name "Support" --key SUPPORT \
  --privileges USER_READ,TENANT_READ \
  --description "Read-only access for support staff"
```

**Change what a role grants** by passing the full new privilege list, not just what you're adding or removing. `--privileges` replaces the role's list wholesale rather than merging into it:

```bash
bridge role update --id <roleId> --privileges USER_READ,USER_WRITE,TENANT_READ
```

**List and remove roles:**

```bash
bridge role list

bridge role delete --id <roleId>
```

`--privileges` always takes a comma-separated list of privilege **keys** that already exist; the CLI never creates a new privilege on the fly.

## Why this matters for an Express app

Anything you gate with `bridge.protect({ role: 'SUPPORT' })` or a route rule's `privilege: 'USER_READ'` only works once that role/privilege exists upstream. The middleware doesn't validate that the string you passed corresponds to a real role or privilege; it just compares it against whatever landed in the verified JWT. A typo in `bridge.protect({ role: 'SUPPRT' })` fails silently (nobody will ever have that role) rather than erroring at startup.

**Next:** put your roles to work by assigning them, see [Assign roles to users](/auth/roles/assign-roles/).
