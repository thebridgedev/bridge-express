/**
 * Error thrown when an HTTP request made by BridgeHttpService fails.
 */
export class BridgeHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
  ) {
    super(message);
    this.name = 'BridgeHttpError';
  }
}

/**
 * HTTP client for making calls to downstream services,
 * forwarding the authenticated user's token when provided.
 *
 * Token is passed explicitly as a parameter — no request-scope complexity.
 *
 * Uses native `fetch` (Node 18+ built-in).
 *
 * @example
 * ```typescript
 * app.get('/forward/items', async (req, res) => {
 *   const data = await bridge.http.get('http://service-b/items', req.bridgeAccessToken);
 *   res.json(data);
 * });
 * ```
 */
export class BridgeHttpService {
  /**
   * Make a GET request to the given URL, optionally forwarding the bearer token.
   *
   * @param url     - Target URL
   * @param token   - Optional bearer token to forward
   * @param options - Additional fetch options (merged with defaults)
   */
  async get<T>(url: string, token?: string, options?: RequestInit): Promise<T> {
    return this.request<T>(url, 'GET', undefined, token, options);
  }

  /**
   * Make a POST request with a JSON body, optionally forwarding the bearer token.
   */
  async post<T>(url: string, body: unknown, token?: string, options?: RequestInit): Promise<T> {
    return this.request<T>(url, 'POST', body, token, options);
  }

  /**
   * Make a PUT request with a JSON body, optionally forwarding the bearer token.
   */
  async put<T>(url: string, body: unknown, token?: string, options?: RequestInit): Promise<T> {
    return this.request<T>(url, 'PUT', body, token, options);
  }

  /**
   * Make a PATCH request with a JSON body, optionally forwarding the bearer token.
   */
  async patch<T>(url: string, body: unknown, token?: string, options?: RequestInit): Promise<T> {
    return this.request<T>(url, 'PATCH', body, token, options);
  }

  /**
   * Make a DELETE request, optionally forwarding the bearer token.
   */
  async delete<T>(url: string, token?: string, options?: RequestInit): Promise<T> {
    return this.request<T>(url, 'DELETE', undefined, token, options);
  }

  private async request<T>(
    url: string,
    method: string,
    body: unknown,
    token?: string,
    options?: RequestInit,
  ): Promise<T> {
    const headers = new Headers(options?.headers);

    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    if (body !== undefined) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await fetch(url, {
      ...options,
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      throw new BridgeHttpError(
        `HTTP ${response.status} ${response.statusText} from ${url}`,
        response.status,
        url,
      );
    }

    return response.json() as Promise<T>;
  }
}
