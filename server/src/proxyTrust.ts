import { BlockList, isIP } from 'node:net';

/**
 * Which proxy hops to believe when working out who a request came from.
 *
 * req.ip decides every per-IP rate limit, the visitor hashing and the security
 * log, so it must never come from a value the caller wrote. Railway's edge
 * appends the address that connected to it as the LAST X-Forwarded-For entry,
 * and everything to the left of that is whatever the client sent.
 *
 *   TRUST_PROXY=0          never trust the header (the server is exposed directly)
 *   TRUST_PROXY=<n>        trust n hops: 1 = Railway alone
 *   TRUST_PROXY=cloudflare Railway, and Cloudflare in front of it
 *   unset                  1 in production, 0 in development and tests
 *
 * Why "cloudflare" and not just 2: Cloudflare does not stop anyone connecting
 * to the Railway origin directly. With a plain hop count of 2, a request that
 * skips Cloudflare gets to choose req.ip by writing "anything, <real ip>" into
 * X-Forwarded-For, and every per-IP limit is bypassable again. So the extra hop
 * is trusted only when the address that reached Railway really is one of
 * Cloudflare's published ranges.
 */
export type ProxyMode = { kind: 'none' } | { kind: 'hops'; hops: number } | { kind: 'cloudflare' };

export function proxyModeFrom(value: string | undefined, nodeEnv: string | undefined): ProxyMode {
  const v = value?.trim().toLowerCase();
  if (v === undefined || v === '') return nodeEnv === 'production' ? { kind: 'hops', hops: 1 } : { kind: 'none' };
  if (v === 'cloudflare') return { kind: 'cloudflare' };
  if (/^\d+$/.test(v)) {
    const hops = Math.min(Number(v), 10);
    return hops === 0 ? { kind: 'none' } : { kind: 'hops', hops };
  }
  // Anything else is a typo. One hop is the value that is right for Railway and
  // cannot be abused; failing open to "trust everything" is how this broke once.
  return { kind: 'hops', hops: 1 };
}

// Published at https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6
// (checked September 2026). They change rarely; when they do, update this list.
export const CLOUDFLARE_V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];
export const CLOUDFLARE_V6 = [
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32',
];

const cloudflare = new BlockList();
for (const cidr of CLOUDFLARE_V4) {
  const [net, bits] = cidr.split('/');
  cloudflare.addSubnet(net, Number(bits), 'ipv4');
}
for (const cidr of CLOUDFLARE_V6) {
  const [net, bits] = cidr.split('/');
  cloudflare.addSubnet(net, Number(bits), 'ipv6');
}

/** Is this address inside one of Cloudflare's published ranges? */
export function isCloudflareAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.trim().replace(/^::ffff:/i, '');
  const family = isIP(a);
  if (family === 4) return cloudflare.check(a, 'ipv4');
  if (family === 6) return cloudflare.check(a, 'ipv6');
  return false;
}

/**
 * The value for Fastify's trustProxy option.
 *
 * Fastify calls the function for each address from the socket inward: hop 0 is
 * the socket (Railway's proxy), hop 1 the last X-Forwarded-For entry, and so on.
 * req.ip is the first address that is NOT trusted.
 */
export function trustProxyFor(mode: ProxyMode): false | ((addr: string, hop: number) => boolean) {
  if (mode.kind === 'none') return false;
  if (mode.kind === 'hops') {
    const hops = mode.hops;
    return (_addr, hop) => hop < hops;
  }
  return (addr, hop) => hop === 0 || (hop === 1 && isCloudflareAddress(addr));
}

/**
 * Did this request really arrive through Cloudflare?
 *
 * Only then are Cloudflare's own headers (CF-IPCountry, CF-Connecting-IP)
 * anything more than text the caller chose to send.
 */
export function viaCloudflare(mode: ProxyMode, xForwardedFor: string | string[] | undefined): boolean {
  if (mode.kind !== 'cloudflare') return false;
  const header = Array.isArray(xForwardedFor) ? xForwardedFor.join(',') : xForwardedFor ?? '';
  const last = header.split(',').map((s) => s.trim()).filter(Boolean).pop();
  return isCloudflareAddress(last);
}
