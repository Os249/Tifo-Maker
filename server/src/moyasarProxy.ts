/**
 * A fixed-IP way out for the calls to Moyasar, and only for them (payments
 * v2, 16 Nov 2026).
 *
 * Moyasar's live secret key answers only from the addresses on its "Allowed
 * IPs" list, and Railway has no fixed outbound address on the plan the site
 * runs on. MOYASAR_PROXY_URL names an HTTP proxy that has one (Fixie, for
 * example: http://user:password@host:port); the Moyasar client then reaches
 * api.moyasar.com through it, and nothing else in the server ever does: this
 * is not a global agent, it is a `fetch` handed to MoyasarClient alone.
 *
 * TLS is end to end. The proxy is asked for a CONNECT tunnel to the API's
 * host and port, and the TLS session with Moyasar is made inside it, checked
 * against Moyasar's certificate as usual, so the proxy carries bytes it
 * cannot read: no key, no order, no token.
 *
 * The proxy URL holds a password. It is parsed once, kept here, and never put
 * in a log line or an error: errors say "proxy" and, at most, the status the
 * proxy answered with.
 */
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';

export interface ProxyTarget {
  host: string;
  port: number;
  /** The proxy itself is spoken to over TLS (an https:// proxy URL). */
  secure: boolean;
  /** "user:password", or null. */
  auth: string | null;
}

/** MOYASAR_PROXY_URL, read. Null when it is empty or not a proxy URL (never thrown: the message could carry it). */
export function readProxyUrl(raw: string | undefined): ProxyTarget | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  const secure = u.protocol === 'https:';
  const port = u.port ? Number(u.port) : secure ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  let auth: string | null = null;
  if (u.username) {
    try {
      auth = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
    } catch {
      return null;
    }
  }
  return { host: u.hostname.replace(/^\[|\]$/g, ''), port, secure, auth };
}

/** A failure of the proxy itself: never carries the proxy's address or password. */
export class ProxyError extends Error {
  constructor(what: string) {
    super(`the payment proxy failed (${what})`);
    this.name = 'ProxyError';
  }
}

export interface TunnelOptions {
  /** The only hosts a tunnel is opened to. Anything else is refused before the proxy is touched. */
  allowHosts: string[];
  /** Extra TLS options for the session with the target (the tests' own certificate authority). */
  tls?: tls.ConnectionOptions;
  /** How long the proxy has to answer CONNECT. */
  connectMs?: number;
}

const MAX_BODY = 2 * 1024 * 1024;

/** Open a CONNECT tunnel through the proxy and start TLS with the target inside it. */
function openTunnel(proxy: ProxyTarget, host: string, port: number, opts: TunnelOptions, signal: AbortSignal | null | undefined): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    let done = false;
    const raw: net.Socket = proxy.secure
      ? tls.connect({ host: proxy.host, port: proxy.port, servername: net.isIP(proxy.host) ? undefined : proxy.host })
      : net.connect({ host: proxy.host, port: proxy.port });
    const fail = (e: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      raw.destroy();
      reject(e);
    };
    const timer = setTimeout(() => fail(new ProxyError('no answer')), opts.connectMs ?? 10_000);
    const onAbort = (): void => {
      const e = new Error('aborted');
      e.name = (signal?.reason as Error | undefined)?.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError';
      fail(e);
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    raw.once('error', () => fail(new ProxyError('unreachable')));
    raw.once(proxy.secure ? 'secureConnect' : 'connect', () => {
      const target = `${host.includes(':') ? `[${host}]` : host}:${port}`;
      raw.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n` +
          (proxy.auth ? `Proxy-Authorization: Basic ${Buffer.from(proxy.auth).toString('base64')}\r\n` : '') +
          'Proxy-Connection: keep-alive\r\n\r\n',
      );
    });
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      if (head.length > 16_384) return fail(new ProxyError('bad answer'));
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      raw.off('data', onData);
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(head.subarray(0, end).toString('latin1'));
      if (!m) return fail(new ProxyError('bad answer'));
      if (m[1] !== '200') return fail(new ProxyError(`status ${m[1]}`));
      // TLS with the API itself, inside the tunnel: the proxy sees only ciphertext.
      const secure = tls.connect({ socket: raw, servername: net.isIP(host) ? undefined : host, ALPNProtocols: ['http/1.1'], ...opts.tls });
      secure.once('error', () => fail(new ProxyError('tls')));
      secure.once('secureConnect', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(secure);
      });
    };
    raw.on('data', onData);
  });
}

/**
 * A `fetch` that goes through the proxy: https targets on the allowed hosts
 * only, one tunnel per request, no redirects followed. Enough of fetch for
 * MoyasarClient (method, headers, a string body, a signal), nothing more.
 */
export function tunnelFetch(proxy: ProxyTarget, opts: TunnelOptions): typeof fetch {
  const allowed = new Set(opts.allowHosts.map((h) => h.toLowerCase()));
  return (async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    // Never in the clear, and never to anyone but the payment API.
    if (url.protocol !== 'https:') throw new ProxyError('not https');
    if (!allowed.has(url.hostname.toLowerCase())) throw new ProxyError('host not allowed');
    const port = url.port ? Number(url.port) : 443;
    const signal = init.signal ?? null;
    const socket = await openTunnel(proxy, url.hostname, port, opts, signal);
    return new Promise<Response>((resolve, reject) => {
      const body = typeof init.body === 'string' ? Buffer.from(init.body) : null;
      const headers: Record<string, string> = { host: url.host, connection: 'close' };
      for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
      if (body) headers['content-length'] = String(body.length);
      // No agent is named, so Node uses createConnection: this request rides the tunnel's own socket and no other.
      const req = http.request({ createConnection: () => socket, method: init.method ?? 'GET', path: url.pathname + url.search, headers });
      const onAbort = (): void => {
        const e = new Error('aborted');
        e.name = (signal?.reason as Error | undefined)?.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError';
        req.destroy(e);
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      req.once('error', (e) => {
        socket.destroy();
        reject(e.name === 'TimeoutError' || e.name === 'AbortError' ? e : new ProxyError('request'));
      });
      req.once('response', (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY) return void req.destroy(new ProxyError('too large'));
          chunks.push(c);
        });
        res.once('end', () => {
          signal?.removeEventListener('abort', onAbort);
          socket.destroy();
          const status = res.statusCode ?? 502;
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') h.set(k, v);
          // A body is not allowed on these statuses.
          const empty = status === 204 || status === 304 || status < 200;
          resolve(new Response(empty ? null : Buffer.concat(chunks), { status, headers: h }));
        });
      });
      req.end(body ?? undefined);
    });
  }) as typeof fetch;
}
