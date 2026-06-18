# Error Handling & Responses

## How the middleware responds

Bridge Express writes the 401/403 response itself when a request fails authentication or authorization — the middleware does not call `next()` and your handler never runs. Responses follow RFC 6750: 401s carry a `WWW-Authenticate` header so your frontend can distinguish error types and react appropriately.

### Error codes

| `WWW-Authenticate` error | Meaning | Recommended action |
|---|---|---|
| `missing_token` | No Authorization header was sent | Redirect to login |
| `expired_token` | Token signature is valid but past expiry | Attempt silent refresh, then redirect |
| `invalid_token` | Token is malformed, tampered, or uses an unknown key | Redirect to login |
| `invalid_request` | Wrong credential type for this endpoint (e.g. API token sent to a `jwt`-only route) | Use the correct credential |

### Frontend auto-refresh pattern

```typescript
// src/lib/api.ts
import { auth } from '@nebulr-group/bridge-react'; // or bridge-svelte, etc.

async function apiFetch(endpoint: string, options: RequestInit = {}) {
  const token = auth.getAccessToken();

  const response = await fetch(`http://localhost:3000${endpoint}`, {
    ...options,
    headers: {
      ...options.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
  });

  if (response.status === 401) {
    const wwwAuth = response.headers.get('WWW-Authenticate') ?? '';

    if (wwwAuth.includes('expired_token')) {
      try {
        await auth.refresh();
        const newToken = auth.getAccessToken();
        return fetch(`http://localhost:3000${endpoint}`, {
          ...options,
          headers: {
            ...options.headers,
            Authorization: `Bearer ${newToken}`,
            'Content-Type': 'application/json',
          },
        }).then((r) => r.json());
      } catch {
        auth.login();
        return;
      }
    }

    // missing_token or invalid_token — redirect to login
    auth.login();
    return;
  }

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
}
```

---

## Error Responses

### 401 Unauthorized

Returned when a token is missing, expired, or invalid. Includes the RFC 6750 `WWW-Authenticate` header:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="expired_token", error_description="The access token has expired"
```

```json
{
  "statusCode": 401,
  "error": "Unauthorized",
  "message": "The access token has expired"
}
```

Auth-type rejection (e.g. an API token sent to a `bridge.protect({ acceptAuth: 'jwt' })` endpoint):

```
WWW-Authenticate: Bearer error="invalid_request", error_description="API token authentication is not accepted for this endpoint"
```

```json
{
  "statusCode": 401,
  "error": "Unauthorized",
  "message": "auth type not accepted"
}
```

### 403 Forbidden

Returned when authenticated but lacking the required role, privilege, or feature flag:

**Role check failed:**
```json
{
  "statusCode": 403,
  "error": "Forbidden",
  "message": "Role 'ADMIN' required"
}
```

**Privilege check failed:**
```json
{
  "statusCode": 403,
  "error": "Forbidden",
  "message": "Privilege 'USER_READ' required"
}
```

**Feature flag not enabled:**
```json
{
  "statusCode": 403,
  "error": "Forbidden",
  "message": "Feature flag 'beta-access' is not enabled"
}
```

### TokenVerificationError

Thrown internally by `JwksService` when token verification fails. Error codes:

| Code | Meaning |
|------|---------|
| `TOKEN_EXPIRED` | JWT has expired |
| `TOKEN_INVALID` | JWT is malformed, inactive, or not an API token |
| `JWKS_NO_MATCH` | No matching key found in the JWKS endpoint |
| `CLAIM_VALIDATION_FAILED` | Token claim validation failed (e.g. wrong issuer or audience) |
| `APP_MISMATCH` | Token was issued for a different app ID |

The middleware catches these and maps them to RFC 6750 `WWW-Authenticate` errors:

| Error Code | RFC 6750 Error | Description |
|------------|----------------|-------------|
| `TOKEN_EXPIRED` | `expired_token` | The access token has expired |
| `TOKEN_INVALID` | `invalid_token` | The access token is invalid |
| `JWKS_NO_MATCH` | `invalid_token` | The access token signature could not be verified |
| `CLAIM_VALIDATION_FAILED` | `invalid_token` | The access token claim validation failed |
| `APP_MISMATCH` | `invalid_token` | The access token was issued for a different application |

You don't catch `TokenVerificationError` yourself — the middleware handles it and writes the 401. It is importable (`import { TokenVerificationError } from '@nebulr-group/bridge-express'`) for advanced cases where you verify a token manually.

### BridgeHttpError

Thrown by `bridge.http` (the token-forwarding HTTP client) when a downstream call returns a non-2xx response:

```typescript
import { BridgeHttpError } from '@nebulr-group/bridge-express';

class BridgeHttpError extends Error {
  readonly status: number;  // HTTP status code
  readonly url: string;     // Request URL
}
```

```typescript
router.get('/inventory', async (req, res) => {
  try {
    const data = await bridge.http.get('http://inventory-service/stock', req.bridgeAccessToken);
    res.json(data);
  } catch (err) {
    if (err instanceof BridgeHttpError) {
      console.log(err.status); // e.g. 404
      console.log(err.url);    // 'http://inventory-service/stock'
      if (err.status === 404) {
        res.json({ stock: [] });
        return;
      }
      res.status(502).json({ error: 'Bad Gateway', message: 'Inventory service unavailable' });
      return;
    }
    res.status(500).json({ error: 'Internal Server Error' });
  }
});
```

### Errors thrown inside your handlers

Bridge Express only writes responses for auth/authz failures. Errors thrown inside your own handlers are yours to handle — register a standard Express error-handling middleware as the last `app.use(...)` to catch them:

```typescript
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof BridgeHttpError) {
    res.status(502).json({ error: 'Bad Gateway', message: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Internal Server Error' });
});
```
