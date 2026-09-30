// TBP-745 (mirrors bridge-nestjs TBP-673) — the user token the auth
// middleware verified for a request.
//
// `bridge.auth()` / `bridge.protect()` record the token and its verified
// claims here, and `bridge.fromRequest(req)` and the quota middleware read
// them back, so a handler gets a TenantScope without verifying the token a
// second time.
//
// A module-private WeakMap rather than a property on the request: only the
// auth middleware can register an entry, so nothing else on the request — a
// header, a property another middleware set (`req.bridgeAccessToken` is
// writable by anyone) — can pass for a verified token. Entries go away with
// the request. Deliberately not exported from the package entry.

import type { JwtClaims } from '../types/user';

export interface VerifiedUserToken {
  token: string;
  claims: JwtClaims;
}

const verifiedUserTokens = new WeakMap<object, VerifiedUserToken>();

/** Called by the auth middleware right after it verified `token`. */
export function rememberVerifiedUserToken(req: object, token: string, claims: JwtClaims): void {
  verifiedUserTokens.set(req, { token, claims });
}

export function verifiedUserTokenFor(req: unknown): VerifiedUserToken | undefined {
  return req !== null && typeof req === 'object' ? verifiedUserTokens.get(req) : undefined;
}
