import { FeatureFlagService } from './feature-flag.service';
import { BridgeConfigService } from './bridge-config.service';

/**
 * TBP-517 — cross-user flag cache poisoning.
 *
 * The evaluation cache used to be keyed on `accessToken.substring(0, 16)`.
 * Those 16 base64url characters decode to the first 12 bytes of the JWT
 * protected header — `{"alg":"PS25` — which is byte-identical for every token
 * bridge-api issues (`kid` starts at byte 28, past the cut). The key was a
 * constant, so all users of an app shared one cache entry: whoever called
 * first warmed it and everyone else got that user's evaluations for the TTL.
 *
 * These tests pin the *observable* consequence, not the implementation: two
 * tokens that differ only in payload must never share a cache entry.
 */

const mockConfigService = {
  // Both names are set so this spec is base-agnostic: the shipped package on
  // origin/main reads `cloudViewsBaseUrl`, this branch still reads
  // `backendlessBaseUrl`. The cache key under test is identical in both.
  cloudViewsBaseUrl: 'https://api.example.com/cloud-views',
  backendlessBaseUrl: 'https://api.example.com/cloud-views',
  appId: 'test-app',
  log: jest.fn(),
} as unknown as BridgeConfigService;

const b64url = (o: object): string =>
  Buffer.from(JSON.stringify(o)).toString('base64url');

/** Identical protected header — exactly what bridge-api emits for every token. */
const HEADER = b64url({ alg: 'PS256', typ: 'JWT', kid: 'bridge-signing-key-1' });

const makeToken = (payload: object): string =>
  `${HEADER}.${b64url(payload)}.c2lnbmF0dXJl`;

/** Two users of the same app. Same header, different payloads. */
const ALICE = makeToken({ sub: 'user-alice', aid: 'app-1', role: 'ADMIN', plan: 'pro' });
const BOB = makeToken({ sub: 'user-bob', aid: 'app-1', role: 'USER', plan: 'free' });

/**
 * Server-side truth: `admin-panel` is targeted at admins only, so it is enabled
 * for Alice and disabled for Bob. The mock reads the token out of the request
 * body exactly as the real bulkEvaluate endpoint does.
 */
function mockFetchPerUser(): jest.Mock {
  const fetchMock = jest.fn(async (_url: string, init: { body: string }) => {
    const { accessToken } = JSON.parse(init.body);
    const isAlice = accessToken === ALICE;
    return {
      ok: true,
      json: async () => ({
        flags: [{ flag: 'admin-panel', evaluation: { enabled: isAlice } }],
      }),
    };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('FeatureFlagService cache key (TBP-517)', () => {
  let service: FeatureFlagService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new FeatureFlagService(mockConfigService);
  });

  it('the two fixtures really are indistinguishable in their first 16 chars', () => {
    // Documents the trap the old key fell into. If this ever fails the
    // fixtures have drifted and the tests below stop proving anything.
    expect(ALICE.substring(0, 16)).toBe(BOB.substring(0, 16));
    expect(Buffer.from(ALICE.substring(0, 16), 'base64url').toString()).toBe('{"alg":"PS25');
    expect(ALICE).not.toBe(BOB);
  });

  it('does not serve one user\'s evaluation to another (isEnabled)', async () => {
    mockFetchPerUser();

    // Alice calls first and warms the cache.
    await expect(service.isEnabled('admin-panel', ALICE)).resolves.toBe(true);

    // Bob must be evaluated on his own token, not read out of Alice's entry.
    await expect(service.isEnabled('admin-panel', BOB)).resolves.toBe(false);
  });

  it('does not serve one user\'s evaluation to another (bulkEvaluate)', async () => {
    mockFetchPerUser();

    const alice = await service.bulkEvaluate(ALICE);
    const bob = await service.bulkEvaluate(BOB);

    expect(alice.get('admin-panel')).toBe(true);
    expect(bob.get('admin-panel')).toBe(false);
  });

  it('evaluates each distinct token against the server', async () => {
    const fetchMock = mockFetchPerUser();

    await service.isEnabled('admin-panel', ALICE);
    await service.isEnabled('admin-panel', BOB);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const seen = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).accessToken);
    expect(seen).toEqual([ALICE, BOB]);
  });

  it('still caches within the TTL for a single caller', async () => {
    const fetchMock = mockFetchPerUser();

    await expect(service.isEnabled('admin-panel', ALICE)).resolves.toBe(true);
    await expect(service.isEnabled('admin-panel', ALICE)).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-evaluates a caller once the 5 minute TTL has elapsed', async () => {
    const fetchMock = mockFetchPerUser();
    const start = Date.now();
    const nowSpy = jest.spyOn(Date, 'now');

    nowSpy.mockReturnValue(start);
    await service.isEnabled('admin-panel', ALICE);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(start + 5 * 60 * 1000 + 1);
    await service.isEnabled('admin-panel', ALICE);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
  });

  it('keeps entries separate for many concurrent users', async () => {
    // A percentage rollout hands out mixed verdicts; none of them may bleed.
    const tokens = Array.from({ length: 25 }, (_, i) =>
      makeToken({ sub: `user-${i}`, aid: 'app-1' }),
    );
    const enabledFor = (t: string) => tokens.indexOf(t) % 2 === 0;

    global.fetch = jest.fn(async (_url: string, init: { body: string }) => {
      const { accessToken } = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          flags: [{ flag: 'rollout', evaluation: { enabled: enabledFor(accessToken) } }],
        }),
      };
    }) as unknown as typeof fetch;

    const results = await Promise.all(tokens.map((t) => service.isEnabled('rollout', t)));

    expect(results).toEqual(tokens.map(enabledFor));
  });
});
