# Frontend Integration & Token Forwarding

## How the frontend talks to your Express backend

Bridge Express expects the access token in the `Authorization` header using the Bearer scheme:

```
Authorization: Bearer <access_token>
```

The flow is:

1. The user logs in via Bridge — your **frontend** owns the login/session lifecycle (using one of the Bridge frontend SDKs).
2. The frontend receives and stores the access token.
3. The frontend includes that token on every API request to your Express backend.
4. Bridge Express verifies the token, attaches `req.bridgeUser` / `req.bridgeTenant`, and runs your handler.

Your Express app does not handle login, refresh, or session storage — it only **verifies** the token it receives. Keep that responsibility on the frontend.

### Sending the token with Fetch

```typescript
const accessToken = getAccessToken(); // from your Bridge frontend SDK

const response = await fetch('http://localhost:3000/items', {
  method: 'GET',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  },
});

const data = await response.json();
```

### Sending the token with Axios

```typescript
import axios from 'axios';

const api = axios.create({ baseURL: 'http://localhost:3000' });

api.interceptors.request.use((config) => {
  const accessToken = getAccessToken();
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

const response = await api.get('/items');
```

### Using Bridge Svelte

```svelte
<script lang="ts">
  import { auth } from '@nebulr-group/bridge-svelte';

  async function fetchItems() {
    const tokens = auth.getToken();
    if (!tokens?.accessToken) return;

    const response = await fetch('http://localhost:3000/items', {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });

    return response.json();
  }
</script>
```

### Using Bridge React

```tsx
import { useBridgeToken } from '@nebulr-group/bridge-react';
import { useEffect, useState } from 'react';

function ItemsList() {
  const { getAccessToken, isAuthenticated } = useBridgeToken();
  const [items, setItems] = useState([]);

  useEffect(() => {
    async function fetchItems() {
      if (!isAuthenticated) return;
      const accessToken = getAccessToken();
      const response = await fetch('http://localhost:3000/items', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      setItems(await response.json());
    }
    fetchItems();
  }, [isAuthenticated, getAccessToken]);

  return (
    <ul>
      {items.map((item) => (
        <li key={item.id}>{item.name}</li>
      ))}
    </ul>
  );
}
```

## CORS

When your SPA runs on a different origin from your Express API (e.g. the SPA on `http://localhost:5173`, the API on `http://localhost:3000`), the browser enforces CORS. Configure the [`cors`](https://www.npmjs.com/package/cors) middleware to allow your frontend origin **and** the `Authorization` header:

```typescript
import express from 'express';
import cors from 'cors';
import { createBridge } from '@nebulr-group/bridge-express';

const app = express();

app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173',
    allowedHeaders: ['Authorization', 'Content-Type', 'x-api-key'],
    exposedHeaders: ['WWW-Authenticate'], // so the SPA can read the 401 error reason
  }),
);
app.use(express.json());

const bridge = createBridge({ appId: process.env.BRIDGE_APP_ID! });
app.use(bridge.auth());
```

A few CORS specifics for Bridge:

- Include `Authorization` in `allowedHeaders` so the browser can send the Bearer token; include `x-api-key` if any browser-side caller uses API tokens.
- Expose `WWW-Authenticate` so your frontend's refresh logic can read whether a 401 was `expired_token` vs `invalid_token` (see [Error Handling](../error-handling/error-handling.md)).
- Mount `cors(...)` **before** `bridge.auth()` so preflight `OPTIONS` requests are answered before the guard runs.

## Token forwarding between services

Use `bridge.http` to call downstream services while forwarding the authenticated user's token, so the downstream service authenticates the same user. The token is passed explicitly — there's no request-scoped magic.

### Basic token forwarding

```typescript
import { Router } from 'express';
const router = Router();

router.get('/orders', async (req, res) => {
  const orders = await bridge.http.get(
    'http://inventory-service/items',
    req.bridgeAccessToken, // forwarded as Authorization: Bearer <token>
  );
  res.json(orders);
});

router.post('/orders', async (req, res) => {
  const order = await bridge.http.post(
    'http://order-service/orders',
    req.body,
    req.bridgeAccessToken,
  );
  res.status(201).json(order);
});

export default router;
```

`bridge.http` provides `get`, `post`, `put`, `patch`, and `delete`. Each accepts an optional bearer token and optional `RequestInit` options. It uses the native `fetch` (Node 18+).

### Fanning out to multiple services

```typescript
router.get('/aggregated', async (req, res) => {
  const [orders, profile] = await Promise.all([
    bridge.http.get('http://orders-service/orders', req.bridgeAccessToken),
    bridge.http.get('http://profile-service/me', req.bridgeAccessToken),
  ]);
  res.json({ orders, profile });
});
```

### Calling public downstream endpoints

If the downstream endpoint needs no auth, omit the token:

```typescript
router.get('/catalog', async (_req, res) => {
  res.json(await bridge.http.get('http://catalog-service/products'));
});
```

### Error handling

`bridge.http` throws `BridgeHttpError` on non-2xx responses — see [Error Handling](../error-handling/error-handling.md#bridgehttperror) for the full pattern.
