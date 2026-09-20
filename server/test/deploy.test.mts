/**
 * The deployment itself: what runs, as whom, and how it gets built.
 *
 * These are the findings from the September 2026 audit that live outside the
 * server code, asserted so they cannot drift back:
 *   - production ran Node 20 for months after its end of life
 *   - the image ran as root, and its install fell back to unreviewed versions
 *   - .dockerignore missed .env variants and 150 MB of files the server never reads
 *   - CI ran with a default token, unpinned actions and `npm install`
 *
 * Pure file checks, no Docker needed:  npm run test:deploy
 */
import assert from 'node:assert/strict';
import { logProviderSetup } from '../src/preflight';
import { readFileSync } from 'node:fs';
import { NODE_END_OF_LIFE, nodeSupport } from '../src/nodeSupport';

const read = (f: string): string => readFileSync(f, 'utf8');

// ---- Node.js support window -------------------------------------------------
const today = new Date(process.env.DEPLOY_TEST_TODAY ?? Date.now());
const supported = (major: number): { ok: boolean; why: string } => {
  const s = nodeSupport(major, today);
  return { ok: s.state === 'good', why: s.why };
};

// Instructions only: the comments explain the old mistakes and would match them.
const dockerfile = read('Dockerfile').replace(/^\s*#.*$/gm, '');
const fromLines = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
assert.ok(fromLines.length >= 1, 'the Dockerfile has a base image');
const majors = fromLines.map((ref) => {
  const m = /^node:(\d+)(?:[.-]|$)/.exec(ref);
  assert.ok(m, `every stage builds on an official node image with an explicit major version (got ${ref})`);
  return Number(m[1]);
});
assert.equal(new Set(majors).size, 1, `build and runtime stages use the same Node line (${majors.join(', ')})`);
const imageMajor = majors[0];
const window = supported(imageMajor);
assert.ok(window.ok, window.why);

const ci = read('.github/workflows/ci.yml').replace(/^\s*#.*$/gm, '');
const ciNodes = [...ci.matchAll(/node-version:\s*'?(\d+)/g)].map((m) => Number(m[1]));
assert.ok(ciNodes.length > 0, 'CI names its Node version');
assert.ok(ciNodes.every((n) => n === imageMajor), `CI tests on the Node line production runs (CI ${ciNodes.join(', ')}, image ${imageMajor})`);

const pkg = JSON.parse(read('package.json')) as { engines?: { node?: string } };
const engineMin = Number(/>=\s*(\d+)/.exec(pkg.engines?.node ?? '')?.[1]);
assert.ok(Number.isFinite(engineMin), 'package.json declares a minimum Node version');
assert.ok(engineMin <= imageMajor, 'the image satisfies package.json engines');
assert.ok(new Date(`${NODE_END_OF_LIFE[engineMin] ?? '1970-01-01'}T00:00:00Z`) > today, `package.json does not still allow an end-of-life Node (engines ${pkg.engines?.node})`);

// The table itself must be right about the past, or none of the above means anything.
assert.equal(supported(20).ok, false, 'Node 20 is past end of life');
assert.equal(NODE_END_OF_LIFE[20], '2026-04-30');

// ---- the image ---------------------------------------------------------------
const stages = dockerfile.split(/^FROM\s/m).slice(1);
const runtime = stages[stages.length - 1];
assert.match(runtime, /^USER\s+node\s*$/m, 'the running container is not root');
assert.ok(runtime.indexOf('USER node') > runtime.indexOf('COPY'), 'USER comes after the files are in place');
assert.doesNotMatch(dockerfile, /npm ci\s*\|\|/, 'no fallback from the lockfile to a fresh resolve');
assert.doesNotMatch(dockerfile, /npm install/, 'installs come from the lockfile only');
assert.match(dockerfile, /RUN npm ci\b/, 'the lockfile is installed exactly');
assert.match(dockerfile, /COPY package\.json package-lock\.json \.\//, 'a missing lockfile fails the build instead of being skipped');
assert.match(dockerfile, /npm prune --omit=dev/, 'build-only packages are removed before the runtime stage');
assert.doesNotMatch(dockerfile, /^ADD\s+https?:/m, 'nothing is downloaded into the image unverified');
// npm as the main process swallowed Railway's SIGTERM, so the server never closed cleanly.
assert.match(runtime, /^CMD \["node", "--import", "tsx", "server\/src\/server\.ts"\]\s*$/m, 'node is the main process, so it receives SIGTERM');
assert.match(read('server/src/server.ts'), /process\.once\(signal/, 'and the server handles it');

const dockerignore = read('.dockerignore').split('\n').map((l) => l.trim());
for (const needed of ['**/.env*', '!.env.example', '**/*.log', '*.patch', '*.bundle', 'marketing/', '_katmp/', '*.zip', 'node_modules', '.git']) {
  assert.ok(dockerignore.includes(needed), `.dockerignore excludes ${needed}`);
}
assert.ok(dockerignore.indexOf('!.env.example') > dockerignore.indexOf('**/.env*'), 'the .env.example exception comes after the rule it excepts');

// ---- CI ----------------------------------------------------------------------
assert.match(ci, /^permissions:\s*\n\s+contents:\s*read\s*$/m, 'the workflow token is read-only by default');
assert.doesNotMatch(ci, /pull_request_target/, 'no workflow runs fork code with repository secrets');
const uses = [...ci.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
assert.ok(uses.length > 0);
for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, `action pinned to a commit, not a movable tag: ${u}`);
const checkouts = (ci.match(/uses:\s*actions\/checkout@/g) ?? []).length;
const persistOff = (ci.match(/persist-credentials:\s*false/g) ?? []).length;
assert.equal(persistOff, checkouts, 'every checkout drops the token before dependencies run');
assert.doesNotMatch(ci, /npm install/, 'CI installs from the lockfile');
assert.match(ci, /npm run test:security/, 'CI runs the security regression suite');
assert.match(ci, /secret-scan\.mjs/, 'CI scans for committed credentials');
assert.match(ci, /npm audit --omit=dev --audit-level=high/, 'CI checks production dependencies for advisories');
assert.match(ci, /schedule:\s*\n\s*-\s*cron:/, 'the scans also run on a schedule, not only on push');

// ---- repository and platform ---------------------------------------------------
const gitignore = read('.gitignore').split('\n').map((l) => l.trim());
assert.ok(gitignore.includes('.env*') && gitignore.includes('!.env.example'), 'every .env variant is ignored, the template is not');
const railway = JSON.parse(read('railway.json')) as { deploy?: { restartPolicyMaxRetries?: number } };
assert.ok((railway.deploy?.restartPolicyMaxRetries ?? 0) >= 5, 'a crash loop gets more than three restarts before the site stays down');

console.log(`deploy: all assertions passed (${window.why}; non-root image, lockfile-only installs, dockerignore, CI token + pins, secret scan, restart policy)`);

// ---- the redirect URI the operator has to register -------------------------
//
// `redirect_uri_mismatch` is the standard first-attempt failure and it happens
// entirely at Google's end, so nothing reaches our logs and there is nothing to
// debug. The boot line exists so the exact string can be copied rather than
// guessed; these assertions are what keep it exact.
{
  const said: string[] = [];
  logProviderSetup({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', PUBLIC_URL: 'https://tifomaker.org/' } as NodeJS.ProcessEnv, (m) => said.push(m));
  assert.equal(said.length, 1);
  assert.match(said[0]!, /https:\/\/tifomaker\.org\/api\/auth\/google\/callback/, 'it prints the exact URI, with the trailing slash of PUBLIC_URL trimmed');
  assert.doesNotMatch(said[0]!, /secret/, 'and never the credentials');

  const quiet: string[] = [];
  logProviderSetup({} as NodeJS.ProcessEnv, (m) => quiet.push(m));
  assert.deepEqual(quiet, [], 'nothing is said when Google is not configured');

  const half: string[] = [];
  logProviderSetup({ GOOGLE_CLIENT_ID: 'id' } as NodeJS.ProcessEnv, (m) => half.push(m));
  assert.deepEqual(half, [], 'half a client is a warning, not a setup note');

  const noBase: string[] = [];
  logProviderSetup({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's' } as NodeJS.ProcessEnv, (m) => noBase.push(m));
  assert.match(noBase[0]!, /PUBLIC_URL/, 'without PUBLIC_URL it says the URI cannot be pinned down');
  console.log('  provider setup line: exact URI, no secrets, quiet when unconfigured');
}
