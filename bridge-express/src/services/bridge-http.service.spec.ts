import { BridgeHttpService, BridgeHttpError } from './bridge-http.service';

const BASE_URL = 'http://service-b';

function mockFetch(ok: boolean, body: object = {}, status = 200): jest.Mock {
  const mock = jest.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
  } as any);
  global.fetch = mock;
  return mock;
}

describe('BridgeHttpService', () => {
  let service: BridgeHttpService;

  beforeEach(() => {
    service = new BridgeHttpService();
    jest.clearAllMocks();
  });

  describe('get()', () => {
    it('should include Authorization header when token is provided', async () => {
      const fetchMock = mockFetch(true, { items: [] });
      await service.get(`${BASE_URL}/items`, 'my-token');

      const [, options] = fetchMock.mock.calls[0];
      const headers = options.headers as Headers;
      expect(headers.get('Authorization')).toBe('Bearer my-token');
    });

    it('should not include Authorization header when token is undefined', async () => {
      const fetchMock = mockFetch(true, { items: [] });
      await service.get(`${BASE_URL}/items`);

      const [, options] = fetchMock.mock.calls[0];
      const headers = options.headers as Headers;
      expect(headers.get('Authorization')).toBeNull();
    });

    it('should return parsed JSON response', async () => {
      mockFetch(true, { items: ['a', 'b'] });
      const result = await service.get<{ items: string[] }>(`${BASE_URL}/items`);
      expect(result.items).toEqual(['a', 'b']);
    });
  });

  describe('post()', () => {
    it('should set Content-Type and serialize body as JSON', async () => {
      const fetchMock = mockFetch(true, { id: '1' });
      await service.post(`${BASE_URL}/items`, { name: 'test' }, 'token');

      const [, options] = fetchMock.mock.calls[0];
      const headers = options.headers as Headers;
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(options.body).toBe(JSON.stringify({ name: 'test' }));
    });
  });

  describe('put()', () => {
    it('should use PUT method', async () => {
      const fetchMock = mockFetch(true, {});
      await service.put(`${BASE_URL}/items/1`, { name: 'updated' });

      const [, options] = fetchMock.mock.calls[0];
      expect(options.method).toBe('PUT');
    });
  });

  describe('patch()', () => {
    it('should use PATCH method', async () => {
      const fetchMock = mockFetch(true, {});
      await service.patch(`${BASE_URL}/items/1`, { name: 'patched' });

      const [, options] = fetchMock.mock.calls[0];
      expect(options.method).toBe('PATCH');
    });
  });

  describe('delete()', () => {
    it('should use DELETE method with optional token', async () => {
      const fetchMock = mockFetch(true, {});
      await service.delete(`${BASE_URL}/items/1`, 'token');

      const [, options] = fetchMock.mock.calls[0];
      expect(options.method).toBe('DELETE');
      const headers = options.headers as Headers;
      expect(headers.get('Authorization')).toBe('Bearer token');
    });
  });

  describe('error handling', () => {
    it('should throw BridgeHttpError with status code when response is not ok', async () => {
      mockFetch(false, {}, 404);
      await expect(service.get(`${BASE_URL}/not-found`)).rejects.toMatchObject({
        name: 'BridgeHttpError',
        status: 404,
        url: `${BASE_URL}/not-found`,
      });
    });

    it('should throw BridgeHttpError on 500', async () => {
      mockFetch(false, {}, 500);
      await expect(service.post(`${BASE_URL}/items`, {})).rejects.toBeInstanceOf(BridgeHttpError);
    });
  });
});
