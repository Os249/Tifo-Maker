import { LogController, type FastifyReply, type FastifyRequest } from 'fastify';

/**
 * One log line per request (performance plan P2.20).
 *
 * Fastify writes two lines for every request: "incoming request" when it
 * arrives and "request completed" when it is answered. A /community view is
 * about 130 requests, so 260 lines, half of them saying nothing the second one
 * does not. Now each request is one line, written when its response closes:
 *
 *   {"level":30,"reqId":"req-1","req":{"method":"GET","url":"/reset?token=[redacted]",
 *    "host":"tifomaker.org","remoteAddress":"203.0.113.9","remotePort":51234},
 *    "res":{"statusCode":200},"responseTime":1.9,"msg":"request completed"}
 *
 * What it keeps, because the security work depends on it:
 *  - the request exactly as the old "incoming request" line described it
 *    (requestLine below): the URL with its one-time secrets redacted, the
 *    address as req.ip worked it out, method, host and port. These lines are
 *    the only place a real address is ever written (SECURITY-CHECKS.md
 *    sections 2 and 5), and the Security tab names events by the same reqId,
 *    so an event can still be found here. No header is ever written, so
 *    nothing a caller sends in one (a bearer token, the origin secret) can
 *    reach the log;
 *  - every error line: "request errored" when Fastify hands the response an
 *    error, and every line the routes write themselves (`request failed`,
 *    `database unavailable`, ...). Those carry the reqId too;
 *  - a line for a request whose client went away before it was answered
 *    ("request aborted"). With a single line written at the end, such a
 *    request would otherwise leave no trace at all: the old "incoming request"
 *    line was the only one it ever got.
 *
 * The request is described once, when it arrives, and that description is
 * what every line about it carries: by the time an aborted request is logged
 * its socket is gone, and with it the address.
 *
 * Fastify's own "stream closed prematurely" line is the same abort seen from a
 * file being streamed, so it is left to the abort line rather than written
 * twice. Every other line Fastify writes is unchanged.
 */

/** Request URLs as they may be logged: one-time secrets in the query replaced. */
export const redactUrl = (url: string): string =>
  url.replace(/([?&](?:token|code|password|key|secret|unlock)=)[^&#]*/gi, '$1[redacted]');

export interface RequestLine {
  [key: string]: unknown;
  method: string;
  url: string;
  host: string | undefined;
  remoteAddress: string | undefined;
  remotePort: number | undefined;
}

const described = new WeakMap<object, RequestLine>();

/**
 * The `req` serializer. Fastify's default request log line carries the full
 * URL, and two of this site's URLs carry one-time secrets: /reset?token= (a
 * password reset, valid for an hour and not spent until the form is
 * submitted) and /api/auth/verify?token=. Anyone who could read the logs could
 * take over an account. The line keeps its shape, so log searches like
 * @req.url still work, minus the secret.
 */
export function requestLine(request: FastifyRequest): RequestLine {
  const seen = described.get(request);
  if (seen) return seen;
  return {
    method: request.method,
    url: redactUrl(request.url),
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

export class OneLineLogController extends LogController {
  /** Nothing at the start: the line is written when the response closes (watchResponse). */
  override incomingRequest(): void {}

  /**
   * Called by Fastify after the onResponse hooks. The completed line is
   * written by watchResponse; this keeps only the error one.
   */
  override requestCompleted(error: Error | null | undefined, request: FastifyRequest, reply: FastifyReply): void {
    if (!error) return;
    reply.log.error({ req: request, res: reply, err: error, responseTime: reply.elapsedTime }, 'request errored');
  }

  override streamError(error: Error, request: FastifyRequest, reply: FastifyReply): void {
    if ((error as { code?: string }).code === 'ERR_STREAM_PREMATURE_CLOSE') return; // the abort line says it
    super.streamError(error, request, reply);
  }
}

/**
 * Describe the request now, and write its one line when its response closes:
 * "request completed" when it was sent in full, "request aborted" when the
 * connection closed first. A response that failed with an error is Fastify's
 * to report (requestCompleted above), so it is not written a second time.
 */
export function watchResponse(request: FastifyRequest, reply: FastifyReply): void {
  described.set(request, requestLine(request));
  const res = reply.raw;
  let finished = false;
  let failed = false;
  res.once('finish', () => { finished = true; });
  res.once('error', () => { failed = true; });
  res.once('close', () => {
    if (failed) return;
    const responseTime = reply.elapsedTime;
    if (finished) {
      request.log.info({ req: request, res: reply, responseTime }, 'request completed');
    } else {
      // The status only when one went out: a client that did not wait may
      // have left before its handler had an answer.
      request.log.info({ req: request, res: { statusCode: res.headersSent ? res.statusCode : null }, responseTime, aborted: true }, 'request aborted');
    }
  });
}
