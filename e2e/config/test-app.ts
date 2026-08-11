/**
 * Single source of truth for the E2E test app's public URL.
 *
 * This value is used in TWO places that MUST agree, or auth breaks:
 *   1. pre-setup.ts registers the test app with `appUrl: TEST_APP_URL`. The Bridge
 *      API derives the app's allowed origins from it.
 *   2. auth-client.ts sends `Origin: TEST_APP_URL` on the SDK auth calls; the
 *      SdkOriginGuard rejects the request unless the Origin is an allowed origin
 *      of the app.
 *
 * The host:port is otherwise a dummy — nothing is actually served on it.
 * Override with LOCAL_APP_URL if needed.
 */
export const TEST_APP_URL = process.env.LOCAL_APP_URL || 'http://localhost:3099';
