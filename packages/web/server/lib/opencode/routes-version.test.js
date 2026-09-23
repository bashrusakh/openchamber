import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerOpenCodeRoutes } from './routes.js';

const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(value) {
    this.body = value;
    return this;
  },
});

const registerVersionRoute = () => {
  const routes = new Map();
  const register = (...args) => routes.set(args[0], args.at(-1));
  registerOpenCodeRoutes(
    { get: register, post: register, put: register, delete: register },
    {
      buildOpenCodeUrl: (route) => route,
      getOpenCodeAuthHeaders: () => ({}),
    },
  );
  return routes.get('/api/opencode/version');
};

describe('GET /api/opencode/version', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('reports the consult protocol capability alongside the version', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: 'v1.18.31' }),
    }));

    const res = createResponse();
    await registerVersionRoute()({}, res);

    expect(globalThis.fetch).toHaveBeenCalledWith('/global/health', expect.objectContaining({ method: 'GET' }));
    expect(res.body).toEqual({ version: '1.18.31', consultProtocol: 2 });
  });

  it('omits the consult protocol capability when OpenCode health fails', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => null,
    }));

    const res = createResponse();
    await registerVersionRoute()({}, res);

    expect(res.statusCode).toBe(503);
    expect(res.body.version).toBeNull();
    expect(res.body).not.toHaveProperty('consultProtocol');
  });
});
