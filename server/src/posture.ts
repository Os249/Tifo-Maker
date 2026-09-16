/**
 * Security posture: the settings and facts that decide how exposed the site is,
 * each with a plain verdict. Shown on the Security tab.
 *
 * Pure apart from reading audit-snapshot.json, so a test can feed it any
 * environment. Nothing here reveals a secret: the admin password is judged by
 * its length only, and addresses are masked.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { configWarnings } from './preflight';
import { nodeSupport } from './nodeSupport';
import { proxyModeFrom } from './proxyTrust';
import { maskEmail } from './soc';
import type { EmailHealth } from './email';

export type PostureState = 'good' | 'warn' | 'bad' | 'info';
export interface PostureCheck {
  id: string;
  label: string;
  state: PostureState;
  detail: string;
}

export interface PostureInput {
  env: NodeJS.ProcessEnv;
  nodeVersion: string;
  uid: number | null;
  rateLimit: boolean;
  database: 'postgres' | 'memory';
  email: EmailHealth | null;
  soc: { alertTo: string | null; keyStable: boolean; lastWriteError: string | null } | null;
  /** Where the Docker build left `npm audit` output, if it did. */
  auditSnapshotPath?: string;
  now?: Date;
}

interface AuditSnapshot {
  metadata?: { vulnerabilities?: Record<string, number> };
}

export function securityPosture(input: PostureInput): PostureCheck[] {
  const { env } = input;
  const prod = env.NODE_ENV === 'production';
  const out: PostureCheck[] = [];

  const major = Number(/^v?(\d+)/.exec(input.nodeVersion)?.[1] ?? 0);
  const node = nodeSupport(major, input.now ?? new Date());
  out.push({ id: 'node', label: `Node.js ${input.nodeVersion}`, state: node.state, detail: `${node.why}.` });

  if (input.uid === null) {
    out.push({ id: 'user', label: 'Process user', state: 'info', detail: 'Not reported on this platform.' });
  } else {
    out.push({
      id: 'user',
      label: 'Process user',
      state: input.uid === 0 ? (prod ? 'bad' : 'warn') : 'good',
      detail: input.uid === 0
        ? 'Running as root. A code-execution bug would own the whole container. The Dockerfile sets USER node; this deploy is not using it.'
        : `Running as an unprivileged user (uid ${input.uid}).`,
    });
  }

  out.push({
    id: 'ratelimit',
    label: 'Rate limiting',
    state: input.rateLimit ? 'good' : prod ? 'bad' : 'info',
    detail: input.rateLimit
      ? '300 requests a minute per address overall; 10 a minute on sign-in, reset, verification and the admin unlock.'
      : 'Off. Normal in development; in production every brute-force limit is gone.',
  });

  out.push({
    id: 'database',
    label: 'Database',
    state: input.database === 'postgres' ? 'good' : prod ? 'bad' : 'info',
    detail: input.database === 'postgres' ? 'Postgres. The security history survives restarts for 30 days.' : 'In memory: history is lost on restart.',
  });

  const mode = proxyModeFrom(env.TRUST_PROXY, env.NODE_ENV);
  out.push({
    id: 'proxy',
    label: 'Client address (TRUST_PROXY)',
    state: mode.kind === 'hops' && mode.hops >= 2 ? 'bad' : mode.kind === 'none' && prod ? 'warn' : 'good',
    detail:
      mode.kind === 'cloudflare'
        ? 'Cloudflare mode: the extra hop is believed only from Cloudflare’s published addresses.'
        : mode.kind === 'none'
          ? prod
            ? 'Never trusting X-Forwarded-For. Behind Railway every visitor looks like the proxy, so per-address limits become one shared bucket.'
            : 'Never trusting X-Forwarded-For (right for local development).'
          : mode.hops >= 2
            ? `Trusting ${mode.hops} hops whoever wrote them: a request sent straight to Railway can choose its own address and dodge every rate limit. Use TRUST_PROXY=cloudflare.`
            : 'One hop (Railway). Right while nothing else sits in front.',
  });

  const pw = env.AI_ADMIN_PASSWORD ?? '';
  out.push({
    id: 'admin-password',
    label: 'Admin password',
    state: !pw ? 'warn' : pw.length < 12 ? 'bad' : pw.length < 20 ? 'warn' : 'good',
    detail: !pw
      ? 'Not set: /admin cannot be opened.'
      : pw.length < 12
        ? `Only ${pw.length} characters. It guards the dashboard and the AI budget bypass; use 20 or more random characters.`
        : pw.length < 20
          ? `${pw.length} characters. Fine against the rate limit, but 20+ random characters is the comfortable margin.`
          : `${pw.length} characters.`,
  });

  const em = input.email;
  if (em) {
    const failing = !!em.lastError && (!em.lastSentAt || (em.lastErrorAt ?? '') > em.lastSentAt);
    out.push({
      id: 'email',
      label: 'Email delivery',
      state: !em.delivering ? (prod ? 'bad' : 'info') : failing ? 'warn' : 'good',
      detail: !em.delivering
        ? 'No RESEND_API_KEY: verification, reset and alert emails are not delivered.'
        : failing
          ? `The last send was refused: ${em.lastError}`
          : `Delivering through ${em.provider} as ${em.from}.`,
    });
  }

  const soc = input.soc;
  if (soc) {
    out.push({
      id: 'alerts',
      label: 'Spike alerts',
      state: !soc.alertTo ? 'warn' : em && !em.delivering ? 'warn' : 'good',
      detail: !soc.alertTo
        ? 'SECURITY_ALERT_TO is not set: attacks are recorded here, but nobody is emailed.'
        : em && !em.delivering
          ? `Addressed to ${maskEmail(soc.alertTo)}, but email is not being delivered (no RESEND_API_KEY), so alerts will not arrive.`
          : `Emailed to ${maskEmail(soc.alertTo)}, at most one per alert type per hour.`,
    });
    out.push({
      id: 'address-key',
      label: 'Address hashing key',
      state: soc.keyStable ? 'good' : 'info',
      detail: soc.keyStable
        ? 'SOC_IP_KEY is set: the same address keeps the same tag across restarts.'
        : 'No SOC_IP_KEY: tags change on every restart, so a returning attacker is not recognisable across deploys. Set it to a long random value.',
    });
    if (soc.lastWriteError) {
      out.push({ id: 'soc-writes', label: 'Security log storage', state: 'warn', detail: `The last write failed: ${soc.lastWriteError}` });
    }
  }

  out.push({
    id: 'public-url',
    label: 'Links in emails (PUBLIC_URL)',
    state: env.PUBLIC_URL ? 'good' : prod ? 'warn' : 'info',
    detail: env.PUBLIC_URL ? `Fixed to ${env.PUBLIC_URL}.` : 'Derived from an allow-listed Host header. Setting PUBLIC_URL removes the dependency on what a caller sent.',
  });

  out.push(dependencyCheck(input.auditSnapshotPath ?? join(process.cwd(), 'audit-snapshot.json')));

  // Anything preflight would print at boot that is not already covered above.
  const covered = new Set(['TRUST_PROXY', 'AI_ADMIN_PASSWORD', 'RESEND_API_KEY', 'PUBLIC_URL', 'SECURITY_ALERT_TO', 'SOC_IP_KEY']);
  for (const w of configWarnings(env)) {
    if (covered.has(w.key)) continue;
    out.push({ id: `config-${w.key}`, label: w.key, state: w.state === 'wrong' ? 'bad' : 'warn', detail: w.effect });
  }
  return out;
}

function dependencyCheck(path: string): PostureCheck {
  let raw: string;
  let built: Date;
  try {
    raw = readFileSync(path, 'utf8');
    built = statSync(path).mtime;
  } catch {
    return {
      id: 'dependencies',
      label: 'Known vulnerable packages',
      state: 'info',
      detail: 'Not measured in this build. The Docker image records `npm audit` when it is built; CI checks every push and every Monday.',
    };
  }
  let v: Record<string, number> | undefined;
  try {
    v = (JSON.parse(raw) as AuditSnapshot).metadata?.vulnerabilities;
  } catch {
    v = undefined;
  }
  if (!v) {
    return { id: 'dependencies', label: 'Known vulnerable packages', state: 'info', detail: 'The build could not reach the npm advisory service, so this image was not checked.' };
  }
  const serious = (v.high ?? 0) + (v.critical ?? 0);
  const total = v.total ?? serious + (v.moderate ?? 0) + (v.low ?? 0);
  return {
    id: 'dependencies',
    label: 'Known vulnerable packages',
    state: serious ? 'bad' : total ? 'warn' : 'good',
    detail: `${total} in production dependencies when this image was built (${built.toISOString().slice(0, 10)})` +
      (total ? `: ${v.critical ?? 0} critical, ${v.high ?? 0} high, ${v.moderate ?? 0} moderate, ${v.low ?? 0} low. Run npm audit fix and redeploy.` : '.'),
  };
}
