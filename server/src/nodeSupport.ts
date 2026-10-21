/**
 * How long the Node.js line this server runs on keeps getting security fixes.
 *
 * Used twice: the Security tab's posture panel reads it at runtime, and
 * server/test/deploy.test.mts fails CI when the Dockerfile's line gets close
 * to the end. Production ran Node 20 for months after its end of life because
 * nothing said so.
 *
 * From https://github.com/nodejs/Release (schedule.json), checked September 2026.
 * Only even-numbered lines become LTS. When a new line is released, add it here.
 */
export const NODE_END_OF_LIFE: Readonly<Record<number, string>> = {
  20: '2026-04-30',
  22: '2027-04-30',
  24: '2028-04-30',
  26: '2029-04-30',
};

/** How long before end of life the move to the next line should start. */
export const NODE_WARN_DAYS = 90;

/**
 * The first release on each line with every published security fix. A line
 * that is still supported but running an older patch is missing them.
 *
 * Raise these on each Node.js security release
 * (https://nodejs.org/en/blog/vulnerability). Last raised for the October 2026
 * release: four HIGH, including an out-of-bounds write in the Brotli decoder
 * reachable through any fetch() response with Content-Encoding: br.
 */
export const NODE_SECURITY_FLOOR: Readonly<Record<number, string>> = {
  22: '22.23.4',
  24: '24.22.1',
  26: '26.12.1',
};

const parts = (v: string): number[] => v.replace(/^v/, '').split('.').map((n) => Number(n) || 0);

/** The floor `version` is below, or null when it has every known fix (or its line has no floor). */
export function missingSecurityFixes(version: string): string | null {
  const v = parts(version);
  const floor = NODE_SECURITY_FLOOR[v[0]!];
  if (!floor) return null;
  const f = parts(floor);
  for (let i = 0; i < 3; i++) {
    if ((v[i] ?? 0) !== (f[i] ?? 0)) return (v[i] ?? 0) < (f[i] ?? 0) ? floor : null;
  }
  return null;
}

export interface NodeSupport {
  state: 'good' | 'warn' | 'bad';
  major: number;
  end: string | null;
  daysLeft: number | null;
  why: string;
}

export function nodeSupport(major: number, today: Date = new Date()): NodeSupport {
  const end = NODE_END_OF_LIFE[major] ?? null;
  if (major % 2 === 1) {
    return { state: 'bad', major, end, daysLeft: null, why: `Node ${major} is an odd-numbered line and never gets long-term support` };
  }
  if (!end) {
    return { state: 'warn', major, end, daysLeft: null, why: `Node ${major} is not in the support table (server/src/nodeSupport.ts); add its end-of-life date` };
  }
  const daysLeft = Math.floor((new Date(`${end}T00:00:00Z`).getTime() - today.getTime()) / 86_400_000);
  if (daysLeft < 0) return { state: 'bad', major, end, daysLeft, why: `Node ${major} reached end of life on ${end} and gets no security fixes` };
  if (daysLeft < NODE_WARN_DAYS) {
    return { state: 'warn', major, end, daysLeft, why: `Node ${major} reaches end of life on ${end}, ${daysLeft} days away: move the image and CI to the next LTS line` };
  }
  return { state: 'good', major, end, daysLeft, why: `Node ${major} is supported until ${end} (${daysLeft} days)` };
}
