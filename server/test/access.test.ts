import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { Home, rec, start, T0 } from './fixture.ts';

/** A raw request, so the Host header can be forged (fetch does not allow it). */
function raw(port: number, path: string, headers: Record<string, string>, method = 'GET'): Promise<{ status: number; headers: Record<string, any>; body: string }> {
  return new Promise((resolve, reject) => {
    // an empty Host means: send no Host header at all
    const noHost = headers.host === '';
    if (noHost) delete headers.host;
    const req = request({ host: '127.0.0.1', port, path, method, headers, setHost: !noHost }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(fn: (c: Awaited<ReturnType<typeof start>>, home: Home) => Promise<void>) {
  const home = new Home();
  home.transcript('-work-alpha', 's', [rec.prompt({ sid: 's', at: T0 }, 'hello')]);
  const c = await start(home);
  try {
    await fn(c, home);
  } finally {
    await c.close();
    home.destroy();
  }
}

test('AEGIS-34 a request without the token is refused; the exchanged cookie is accepted', () =>
  withServer(async (c) => {
    const none = await fetch(`${c.origin}/api/sessions`);
    assert.equal(none.status, 401);
    assert.deepEqual(await none.json(), { error: { code: 'unauthorized', message: 'Unauthorized' } });
    assert.equal((await fetch(`${c.origin}/api/sessions`, { headers: { cookie: `aegis_${c.app.port}=wrong` } })).status, 401);
    assert.equal((await c.getRes('/api/sessions')).status, 200);
    // the exchange sets an HttpOnly, SameSite=Strict cookie named for the port and redirects to a token-free URL
    const exchange = await fetch(`${c.origin}/?token=${c.app.token}`, { redirect: 'manual' });
    assert.equal(exchange.status, 302);
    assert.equal(exchange.headers.get('location'), '/');
    const setCookie = exchange.headers.get('set-cookie') ?? '';
    assert.match(setCookie, new RegExp(`^aegis_${c.app.port}=`));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    // the token is not accepted as a query parameter on the API
    assert.equal((await fetch(`${c.origin}/api/sessions?token=${c.app.token}`)).status, 401);
    assert.equal((await fetch(`${c.origin}/?token=nope`, { redirect: 'manual' })).status, 401);
  }));

test('AEGIS-34 a foreign Host is refused before the token is looked at', () =>
  withServer(async (c) => {
    const port = c.app.port;
    for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${port + 1}`, `127.0.0.1.evil.example:${port}`]) {
      const res = await raw(port, '/api/sessions', { host, cookie: c.cookie });
      assert.equal(res.status, 403, `host ${host}`);
    }
    // a request with no Host header is refused too (by the HTTP layer itself)
    assert.ok([400, 403].includes((await raw(port, '/api/sessions', { host: '', cookie: c.cookie })).status));
    // the exchange itself is refused on a rebound name, so no cookie is ever set for it
    const rebound = await raw(port, `/?token=${c.app.token}`, { host: `evil.example:${port}` });
    assert.equal(rebound.status, 403);
    assert.equal(rebound.headers['set-cookie'], undefined);
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      assert.equal((await raw(port, '/api/sessions', { host, cookie: c.cookie })).status, 200, `host ${host}`);
    }
  }));

test('AEGIS-34 a state-changing request needs this origin and the custom header', () =>
  withServer(async (c) => {
    const post = (headers: Record<string, string>) => fetch(`${c.origin}/api/audit/verify`, { method: 'POST', headers: { cookie: c.cookie, ...headers } });
    assert.equal((await post({ 'x-aegis': '1' })).status, 403, 'no origin');
    assert.equal((await post({ origin: 'http://evil.example', 'x-aegis': '1' })).status, 403, 'foreign origin');
    assert.equal((await post({ origin: c.origin })).status, 403, 'no custom header');
    assert.equal((await post({ origin: `http://localhost:${c.app.port}`, 'x-aegis': '1' })).status, 403, 'origin differs from host');
    assert.notEqual((await post({ origin: c.origin, 'x-aegis': '1' })).status, 403);
    // other methods do not exist
    assert.equal((await fetch(`${c.origin}/api/sessions`, { method: 'DELETE', headers: { cookie: c.cookie, origin: c.origin, 'x-aegis': '1' } })).status, 405);
  }));

test('AEGIS-34 no CORS, and the security headers are on every response', () =>
  withServer(async (c) => {
    const preflight = await fetch(`${c.origin}/api/sessions`, { method: 'OPTIONS', headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' } });
    assert.equal(preflight.status, 403);
    const responses = [
      preflight,
      await c.getRes('/api/sessions'),
      await fetch(`${c.origin}/api/sessions`),
      await c.getRes('/api/nope'),
      await c.getRes('/'),
      await fetch(`${c.origin}/`),
    ];
    for (const res of responses) {
      assert.equal(res.headers.get('access-control-allow-origin'), null);
      const csp = res.headers.get('content-security-policy') ?? '';
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /script-src 'self'(;|$)/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /object-src 'none'/);
      assert.doesNotMatch(csp, /unsafe-eval/);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    }
    assert.equal(responses[1].headers.get('cache-control'), 'no-store');
    // an unknown path does not echo input
    const missing = await c.getRes('/api/%3Cscript%3Ealert(1)%3C/script%3E');
    assert.equal(missing.status, 404);
    assert.doesNotMatch(await missing.text(), /script/);
  }));

test('AEGIS-34 repeated failed token attempts are throttled', () =>
  withServer(async (c) => {
    for (let i = 0; i < 10; i++) assert.equal((await fetch(`${c.origin}/?token=guess${i}`, { redirect: 'manual' })).status, 401);
    // locked: even the right token is refused for the lockout period, and a wrong cookie too
    assert.equal((await fetch(`${c.origin}/?token=${c.app.token}`, { redirect: 'manual' })).status, 429);
    assert.equal((await fetch(`${c.origin}/api/sessions`, { headers: { cookie: `aegis_${c.app.port}=wrong` } })).status, 429);
    // an established session is not locked out by someone else's guessing
    assert.equal((await c.getRes('/api/sessions')).status, 200);
  }));

test('AEGIS-34 the listener is on loopback only and a taken port fails the start', () =>
  withServer(async (c, home) => {
    const address = (c.app as any).address;
    assert.equal(address, '127.0.0.1');
    const other = new Home();
    await assert.rejects(start(other, { port: c.app.port }), /EADDRINUSE/);
    other.destroy();
    void home;
  }));
