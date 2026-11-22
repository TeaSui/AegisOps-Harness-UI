// HTTP front door: loopback only, a per-start token, strict Host and Origin checks, security
// headers on every response, and a small router. No transcript text, token or path is ever logged.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const badRequest = (message: string) => new HttpError(400, 'invalid_request', message);
export const notFound = () => new HttpError(404, 'not_found', 'Not found');

export type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
};

/** A handler returns a JSON value, or takes over the response itself and returns HANDLED. */
export const HANDLED = Symbol('handled');
export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;
type Route = { method: string; parts: string[]; handler: Handler };

export class Router {
  private routes: Route[] = [];
  add(method: 'GET' | 'POST', path: string, handler: Handler) {
    this.routes.push({ method, parts: path.split('/').filter(Boolean), handler });
  }
  get(path: string, handler: Handler) {
    this.add('GET', path, handler);
  }
  post(path: string, handler: Handler) {
    this.add('POST', path, handler);
  }
  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter(Boolean);
    const want = method === 'HEAD' ? 'GET' : method;
    for (const r of this.routes) {
      if (r.method !== want || r.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const p = r.parts[i];
        if (p.startsWith(':')) {
          try {
            params[p.slice(1)] = decodeURIComponent(parts[i]);
          } catch {
            ok = false;
          }
        } else if (p !== parts[i]) ok = false;
        if (!ok) break;
      }
      if (ok) return { handler: r.handler, params };
    }
    return null;
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
  "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const MAX_BODY = 512 * 1024;
const FAIL_WINDOW_MS = 60_000;
const FAIL_LIMIT = 10;
const LOCKOUT_MS = 30_000;

export type FrontDoorOptions = { port: number; staticDir: string; quiet: boolean; router: Router };

export class FrontDoor {
  server: Server;
  token: string;
  port = 0;
  private opts: FrontDoorOptions;
  private tokenDigest: Buffer;
  private failures: number[] = [];
  private lockedUntil = 0;

  constructor(opts: FrontDoorOptions) {
    this.opts = opts;
    this.token = randomBytes(32).toString('base64url');
    this.tokenDigest = createHash('sha256').update(this.token).digest();
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.keepAliveTimeout = 5000;
  }

  /** Binds to loopback only. A taken port rejects. */
  listen(): Promise<number> {
    return new Promise((resolvePort, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.opts.port, '127.0.0.1', () => {
        this.port = (this.server.address() as { port: number }).port;
        resolvePort(this.port);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((r) => {
      this.server.close(() => r());
      this.server.closeAllConnections();
    });
  }

  get cookieName() {
    return `aegis_${this.port}`;
  }

  private tokenMatches(candidate: string | undefined): boolean {
    if (!candidate) return false;
    return timingSafeEqual(createHash('sha256').update(candidate).digest(), this.tokenDigest);
  }

  private throttled(now: number): boolean {
    return now < this.lockedUntil;
  }

  private recordFailure(now: number) {
    this.failures = this.failures.filter((t) => now - t < FAIL_WINDOW_MS);
    this.failures.push(now);
    if (this.failures.length >= FAIL_LIMIT) {
      this.lockedUntil = now + LOCKOUT_MS;
      this.failures = [];
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const started = Date.now();
    let pathname = '/';
    try {
      res.setHeader('Content-Security-Policy', CSP);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

      // 1. Host first: a rebound DNS name never reaches routing or token handling.
      const host = req.headers.host ?? '';
      const allowed = [`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`];
      if (!allowed.includes(host)) throw new HttpError(403, 'forbidden', 'Forbidden');

      const url = new URL(req.url ?? '/', `http://${host}`);
      pathname = url.pathname;
      const method = req.method ?? 'GET';
      if (method === 'OPTIONS') throw new HttpError(403, 'forbidden', 'Forbidden');
      if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');

      // 2. One-time exchange of the start URL's token for the session cookie.
      const now = Date.now();
      if (method === 'GET' && pathname === '/' && url.searchParams.has('token')) {
        if (this.throttled(now)) throw new HttpError(429, 'throttled', 'Too many failed attempts; try again shortly');
        if (!this.tokenMatches(url.searchParams.get('token') ?? '')) {
          this.recordFailure(now);
          throw new HttpError(401, 'unauthorized', 'Unauthorized');
        }
        res.setHeader('Set-Cookie', `${this.cookieName}=${this.token}; HttpOnly; SameSite=Strict; Path=/`);
        res.setHeader('Cache-Control', 'no-store');
        res.writeHead(302, { Location: '/' });
        res.end();
        return;
      }

      // 3. Everything else needs the cookie.
      const cookie = parseCookie(req.headers.cookie)[this.cookieName];
      if (!this.tokenMatches(cookie)) {
        if (cookie) {
          if (this.throttled(now)) throw new HttpError(429, 'throttled', 'Too many failed attempts; try again shortly');
          this.recordFailure(now);
        }
        if (!pathname.startsWith('/api/') && method === 'GET') {
          res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(
            '<!doctype html><meta charset="utf-8"><title>Aegis</title><body style="font:16px system-ui;margin:15vh auto;max-width:34rem;padding:0 1rem">' +
              '<h1 style="font-size:1.2rem">This console needs its start link</h1><p>Open the URL that Aegis printed in the terminal when it started. ' +
              'It carries a one-time access token; this address alone is not enough.</p></body>',
          );
          return;
        }
        throw new HttpError(401, 'unauthorized', 'Unauthorized');
      }

      // 4. State-changing requests must come from this origin and carry the custom header.
      if (method === 'POST') {
        if (req.headers.origin !== `http://${host}` || req.headers['x-aegis'] !== '1') throw new HttpError(403, 'forbidden', 'Forbidden');
      }

      if (pathname.startsWith('/api/')) {
        const found = this.opts.router.match(method, pathname);
        if (!found) throw notFound();
        const body = method === 'POST' ? await readJson(req) : undefined;
        res.setHeader('Cache-Control', 'no-store');
        const result = await found.handler({ req, res, params: found.params, query: url.searchParams, body });
        if (result !== HANDLED) {
          const payload = JSON.stringify(result ?? null);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(method === 'HEAD' ? undefined : payload);
        }
        return;
      }
      if (method === 'POST') throw notFound();
      this.serveStatic(pathname, res, method === 'HEAD');
    } catch (e) {
      this.fail(res, e);
    } finally {
      if (!this.opts.quiet) {
        // The request log has no query string, header or body.
        process.stdout.write(`${req.method} ${pathname.slice(0, 200)} ${res.statusCode} ${Date.now() - started}ms\n`);
      }
    }
  }

  private fail(res: ServerResponse, e: unknown) {
    let status = 500;
    let code = 'internal';
    let message = 'Unexpected error';
    let id: string | undefined;
    if (e instanceof HttpError) {
      status = e.status;
      code = e.code;
      message = e.message;
    } else {
      id = randomUUID();
      const err = e as NodeJS.ErrnoException;
      // Name and code only: an error message can carry a path or a piece of a transcript.
      process.stderr.write(`error ${id} ${err?.name ?? 'Error'} ${err?.code ?? ''}\n`);
      if (process.env.AEGIS_DEBUG === '1' && err?.stack) process.stderr.write(err.stack + '\n');
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: { code, message, ...(id ? { id } : {}) } }));
  }

  private serveStatic(pathname: string, res: ServerResponse, head: boolean) {
    const root = resolve(this.opts.staticDir);
    let rel: string;
    try {
      rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    } catch {
      throw notFound();
    }
    if (rel.includes('\0')) throw notFound();
    let file = resolve(join(root, rel));
    if (file !== root && !file.startsWith(root + sep)) throw notFound();
    const isAsset = extname(file) !== '';
    if (!isAsset || !existsSync(file) || !statSync(file).isFile()) {
      if (isAsset) throw notFound();
      file = join(root, 'index.html'); // client-side routes
      if (!existsSync(file)) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('The web client has not been built. Run: npm run build');
        return;
      }
    }
    const type = MIME[extname(file)] ?? 'application/octet-stream';
    const immutable = file.includes(`${sep}assets${sep}`);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': immutable ? 'private, max-age=31536000, immutable' : 'no-store' });
    if (head) res.end();
    else createReadStream(file).pipe(res);
  }
}

function parseCookie(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'too_large', 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size === 0) return resolveBody({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (v === null || typeof v !== 'object' || Array.isArray(v)) return reject(badRequest('The body must be a JSON object'));
        resolveBody(v);
      } catch {
        reject(badRequest('The body is not valid JSON'));
      }
    });
    req.on('error', () => reject(badRequest('The body could not be read')));
  });
}

// ---- parameter helpers ---------------------------------------------------------------------------------

export function intParam(q: URLSearchParams, name: string, def: number, min: number, max: number): number {
  const raw = q.get(name);
  if (raw === null || raw === '') return def;
  if (!/^-?\d{1,15}$/.test(raw)) throw badRequest(`${name} must be an integer`);
  const n = Number(raw);
  if (n < min || n > max) throw badRequest(`${name} must be between ${min} and ${max}`);
  return n;
}

export function optIntParam(q: URLSearchParams, name: string): number | null {
  const raw = q.get(name);
  if (raw === null || raw === '') return null;
  if (!/^-?\d{1,15}$/.test(raw)) throw badRequest(`${name} must be an integer`);
  return Number(raw);
}

export function enumParam<T extends string>(q: URLSearchParams, name: string, allowed: readonly T[], def: T): T {
  const raw = q.get(name);
  if (raw === null || raw === '') return def;
  if (!allowed.includes(raw as T)) throw badRequest(`${name} must be one of: ${allowed.join(', ')}`);
  return raw as T;
}

export function optEnumParam<T extends string>(q: URLSearchParams, name: string, allowed: readonly T[]): T | null {
  const raw = q.get(name);
  if (raw === null || raw === '') return null;
  if (!allowed.includes(raw as T)) throw badRequest(`${name} must be one of: ${allowed.join(', ')}`);
  return raw as T;
}

export function strParam(q: URLSearchParams, name: string, max = 300): string | null {
  const raw = q.get(name);
  if (raw === null || raw === '') return null;
  if (raw.length > max) throw badRequest(`${name} is too long`);
  return raw;
}

export const page = (q: URLSearchParams, def = 200) => ({ limit: intParam(q, 'limit', def, 1, 1000), offset: intParam(q, 'offset', 0, 0, 10_000_000) });
