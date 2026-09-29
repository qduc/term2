/**
 * Centralized HTTP client with automatic token refresh on 401 errors
 */

import { getToken, clearTokens, setAuthReady } from './storage';
import { StreamingNotSupportedError } from './streaming';

// Helper to get API base URL, supporting async Electron IPC
let cachedApiBaseUrl: string | null = null;

async function getElectronApiBaseUrl(): Promise<string | null> {
  if (typeof window === 'undefined') return null;
  const electronAPI = (window as any).__API_BASE_URL_PROMISE__;
  if (electronAPI && typeof electronAPI.get === 'function') {
    try {
      return await electronAPI.get();
    } catch {
      return null;
    }
  }
  return null;
}

async function resolveApiBaseUrl(): Promise<string> {
  if (cachedApiBaseUrl) return cachedApiBaseUrl;

  if (typeof window !== 'undefined') {
    // First try Electron IPC (async)
    const electronUrl = await getElectronApiBaseUrl();
    if (electronUrl) {
      cachedApiBaseUrl = electronUrl;
      return electronUrl;
    }
    // Fall back to window origin
    cachedApiBaseUrl = `${window.location.origin}/api`;
    return cachedApiBaseUrl;
  }

  // Server-side fallback
  return process.env.NEXT_PUBLIC_API_BASE || 'http://backend:3001/api';
}

// Synchronous default for initial construction (will be updated async)
const DEFAULT_API_BASE =
  typeof window !== 'undefined'
    ? `${window.location.origin}/api`
    : process.env.NEXT_PUBLIC_API_BASE || 'http://backend:3001/api';

export interface HttpClientOptions {
  baseUrl?: string;
  timeout?: number;
  retries?: number;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: any;
  signal?: AbortSignal;
  credentials?: RequestCredentials;
  skipAuth?: boolean; // Skip adding auth headers
  skipRetry?: boolean; // Skip 401 retry logic
}

export interface HttpResponse<T = any> {
  data: T;
  status: number;
  statusText: string;
  headers: Headers;
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public response?: Response, public data?: any) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface QueuedRequest {
  resolve: (value: any) => void;
  reject: (error: any) => void;
  request: () => Promise<any>;
}

class AuthenticatedHttpClient {
  private baseUrl: string;
  private baseUrlResolved: boolean = false;
  private timeout: number;
  private retries: number;
  private isRefreshing = false;
  private refreshPromise: Promise<void> | null = null;
  private requestQueue: QueuedRequest[] = [];
  private refreshTokenFn?: () => Promise<void>;

  constructor(options: HttpClientOptions = {}) {
    this.baseUrl = options.baseUrl || DEFAULT_API_BASE;
    this.timeout = options.timeout || 30000;
    this.retries = options.retries || 1;

    // Asynchronously resolve the actual base URL (for Electron dynamic port)
    if (!options.baseUrl && typeof window !== 'undefined') {
      resolveApiBaseUrl().then((resolvedUrl) => {
        this.baseUrl = resolvedUrl;
        this.baseUrlResolved = true;
      });
    }
  }

  /**
   * Ensure base URL is resolved before making requests
   */
  private async ensureBaseUrlResolved(): Promise<void> {
    if (!this.baseUrlResolved && typeof window !== 'undefined') {
      this.baseUrl = await resolveApiBaseUrl();
      this.baseUrlResolved = true;
    }
  }

  /**
   * Set the token refresh function (will be set by api.ts to avoid circular dependency)
   */
  setRefreshTokenFn(fn: () => Promise<void>) {
    this.refreshTokenFn = fn;
  }

  /**
   * Make an HTTP request with automatic 401 handling
   */
  async request<T = any>(url: string, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    // Ensure we have the correct base URL (important for Electron)
    await this.ensureBaseUrlResolved();

    const fullUrl = url.startsWith('http') ? url : `${this.baseUrl}${url.startsWith('/') ? url : `/${url}`}`;

    // If we're currently refreshing tokens, queue this request (unless it's the refresh request itself)
    if (this.isRefreshing && !options.skipRetry) {
      return new Promise((resolve, reject) => {
        this.requestQueue.push({
          resolve,
          reject,
          request: () => this.makeRequest<T>(fullUrl, options),
        });
      });
    }

    return this.makeRequest<T>(fullUrl, options);
  }

  /**
   * Internal method to make the actual HTTP request
   */
  private async makeRequest<T>(url: string, options: RequestOptions): Promise<HttpResponse<T>> {
    const requestInit = this.buildRequestInit(options);

    try {
      const response = await fetch(url, requestInit);

      // Handle 401 errors with token refresh
      if (response.status === 401 && !options.skipRetry && !options.skipAuth) {
        return this.handleUnauthorized<T>(url, options);
      }

      // Handle other errors
      if (!response.ok) {
        await this.handleErrorResponse(response);
      }

      const data = await this.parseResponse<T>(response);

      return {
        data,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      };
    } catch (error) {
      if (error instanceof HttpError || error instanceof StreamingNotSupportedError) {
        throw error;
      }
      throw new HttpError(0, `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Handle 401 unauthorized errors with token refresh
   */
  private async handleUnauthorized<T>(url: string, options: RequestOptions): Promise<HttpResponse<T>> {
    // If already refreshing, wait for the ongoing refresh and retry
    if (this.isRefreshing && this.refreshPromise) {
      try {
        await this.refreshPromise;
        // Refresh succeeded, retry the request with new token
        const retryOptions = { ...options, skipRetry: true };
        return await this.makeRequest<T>(url, retryOptions);
      } catch {
        // Refresh failed (already handled by the original refresh initiator)
        throw new HttpError(401, 'Authentication expired');
      }
    }

    // Check if we have a refresh function
    if (!this.refreshTokenFn) {
      console.warn('[http] Cannot refresh token: no refresh function');
      throw new HttpError(401, 'Authentication required');
    }

    // Start the refresh process
    this.isRefreshing = true;
    setAuthReady(false);

    // Create a promise that other concurrent requests can wait on
    this.refreshPromise = this.refreshTokenFn();

    try {
      // Attempt to refresh the token
      await this.refreshPromise;

      // Process queued requests with new token
      await this.processRequestQueue();

      // Retry the original request with new token
      const retryOptions = { ...options, skipRetry: true }; // Prevent infinite retry loop
      return await this.makeRequest<T>(url, retryOptions);
    } catch {
      // Refresh failed - clear tokens and auth state
      console.log('[http] Token refresh failed, clearing tokens and logging out');
      clearTokens();
      setAuthReady(true);

      // Reject all queued requests
      this.requestQueue.forEach(({ reject }) => {
        reject(new HttpError(401, 'Authentication expired'));
      });
      this.requestQueue = [];

      throw new HttpError(401, 'Authentication expired');
    } finally {
      this.isRefreshing = false;
      this.refreshPromise = null;
      setAuthReady(true);
    }
  }

  /**
   * Process all queued requests after successful token refresh
   */
  private async processRequestQueue(): Promise<void> {
    const queue = [...this.requestQueue];
    this.requestQueue = [];

    await Promise.allSettled(
      queue.map(async ({ resolve, reject, request }) => {
        try {
          const result = await request();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      }),
    );
  }

  /**
   * Build RequestInit object with authentication headers
   */
  private buildRequestInit(options: RequestOptions): RequestInit {
    const headers: Record<string, string> = {
      ...options.headers,
    };

    // Only set Content-Type for JSON if body is not FormData
    // FormData requires browser to set Content-Type with boundary
    const isFormData = options.body instanceof FormData;
    if (!isFormData && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    // Remove Content-Type if explicitly set for FormData (browser will handle it)
    if (isFormData && headers['Content-Type']) {
      delete headers['Content-Type'];
    }

    // Add authentication header if not skipped and token exists
    if (!options.skipAuth && typeof window !== 'undefined') {
      const token = getToken();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
    }

    const init: RequestInit = {
      method: options.method || 'GET',
      headers,
      credentials: options.credentials || 'include',
      signal: options.signal,
    };

    // Add body for non-GET requests
    if (options.body !== undefined && options.method !== 'GET') {
      if (isFormData) {
        // Pass FormData directly, browser will handle serialization and Content-Type
        init.body = options.body;
      } else if (typeof options.body === 'string') {
        init.body = options.body;
      } else {
        init.body = JSON.stringify(options.body);
      }
    }

    return init;
  }

  /**
   * Handle error responses
   */
  private async handleErrorResponse(response: Response): Promise<never> {
    let errorData: any;
    let errorMessage = `HTTP ${response.status}`;

    try {
      errorData = await response.json();

      // Check for organization verification error BEFORE building error message
      const errorMsg = errorData?.error?.message || errorData?.message || errorData?.error || '';
      if (
        typeof errorMsg === 'string' &&
        (errorMsg.includes('Your organization must be verified to stream') ||
          errorMsg.includes('organization must be verified'))
      ) {
        throw new StreamingNotSupportedError(errorMsg);
      }

      errorMessage += `: ${errorData.error?.message || errorData.message || JSON.stringify(errorData)}`;
    } catch (error) {
      // If it's already a StreamingNotSupportedError, re-throw it
      if (error instanceof StreamingNotSupportedError) {
        throw error;
      }
      // Ignore JSON parse errors
      errorMessage += `: ${response.statusText}`;
    }

    throw new HttpError(response.status, errorMessage, response, errorData);
  }

  /**
   * Parse response data
   */
  private async parseResponse<T>(response: Response): Promise<T> {
    const contentType = response.headers.get('content-type');

    // For streaming responses, return the raw response
    if (contentType?.includes('text/event-stream')) {
      return response as unknown as T;
    }

    if (contentType?.includes('application/json')) {
      return response.json();
    }

    if (contentType?.includes('text/')) {
      return response.text() as unknown as T;
    }

    return response.blob() as unknown as T;
  }

  /**
   * Convenience methods for common HTTP verbs
   */
  async get<T = any>(url: string, options: Omit<RequestOptions, 'method'> = {}): Promise<HttpResponse<T>> {
    return this.request<T>(url, { ...options, method: 'GET' });
  }

  async post<T = any>(
    url: string,
    body?: any,
    options: Omit<RequestOptions, 'method' | 'body'> = {},
  ): Promise<HttpResponse<T>> {
    return this.request<T>(url, { ...options, method: 'POST', body });
  }

  async put<T = any>(
    url: string,
    body?: any,
    options: Omit<RequestOptions, 'method' | 'body'> = {},
  ): Promise<HttpResponse<T>> {
    return this.request<T>(url, { ...options, method: 'PUT', body });
  }

  async patch<T = any>(
    url: string,
    body?: any,
    options: Omit<RequestOptions, 'method' | 'body'> = {},
  ): Promise<HttpResponse<T>> {
    return this.request<T>(url, { ...options, method: 'PATCH', body });
  }

  async delete<T = any>(url: string, options: Omit<RequestOptions, 'method'> = {}): Promise<HttpResponse<T>> {
    return this.request<T>(url, { ...options, method: 'DELETE' });
  }
}

// Export singleton instance
export const httpClient = new AuthenticatedHttpClient();

// Export class for custom instances
export { AuthenticatedHttpClient };
