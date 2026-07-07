---
title: Define roles & privileges
description: Where roles and privileges are created and managed — Control Center and the CLI, not this package.
sidebar:
  label: Express
---

# Define roles & privileges

Roles and privileges are app-level configuration, managed outside your Express backend entirely — `@nebulr-group/bridge-express` only *reads* and *enforces* them at request time (see [How roles & privileges work](/auth/roles/how-it-works/)). Definition happens in one of two places:

- **Control Center:** [Roles](https://app.thebridge.dev/roles) — has separate **Roles** and **Privileges** tabs, with **Create Role** and **Create Privilege** buttons. This is the only way to create privileges today.
- **CLI:** roles only — create, update, delete, and list them, referencing privileges that already exist.

## Privileges

A privilege is just a key and a description — for example `USER_WRITE`, "Can create and edit users." Privileges are the building blocks roles are made of: define one once, then bundle its key into as many roles as need it, and reference it from route rules (`{ path: '/users/*', privilege: 'USER_READ' }`) or `bridge.protect({ privilege })`.

There's no CLI command for creating a privilege yet — only for referencing an existing one when you build a role (see below). If a route in your Express app needs a privilege that doesn't exist, create it in Control Center first.

## Roles

A role bundles a name, a unique key, a description, and a list of privilege keys.

**Create a role**, bundling privileges you've already defined:

```bash
bridge role create --name "Support" --key SUPPORT \
  --privileges USER_READ,TENANT_READ \
  --description "Read-only access for support staff"
```

**Change what a role grants** — pass the full new privilege list, not just what you're adding or removing. `--privileges` replaces the role's list wholesale rather than merging into it:

```bash
bridge role update --id <roleId> --privileges USER_READ,USER_WRITE,TENANT_READ
```

**List and remove roles:**

```bash
bridge role list

bridge role delete --id <roleId>
```

`--privileges` always takes a comma-separated list of privilege **keys** that already exist — the CLI never creates a new privilege on the fly.

## Why this matters for an Express app

Anything you gate with `bridge.protect({ role: 'SUPPORT' })` or a route rule's `privilege: 'USER_READ'` only works once that role/privilege exists upstream — the middleware doesn't validate that the string you passed corresponds to a real role or privilege; it just compares it against whatever landed in the verified JWT. A typo in `bridge.protect({ role: 'SUPPRT' })` fails silently (nobody will ever have that role) rather than erroring at startup.
