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
import { NODE_END_OF_LIFE, NODE_SECURITY_FLOOR, missingSecurityFixes, nodeSupport } from '../src/nodeSupport';

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

// The patch is pinned, and is at or above the last security release. A floating
// `node:24-slim` let a cached base layer keep serving an unpatched Node.
const pins = fromLines.map((ref) => {
  const m = /^node:(\d+\.\d+\.\d+)(?:-|$)/.exec(ref);
  assert.ok(m, `every stage pins an exact Node release, not a floating tag (got ${ref})`);
  return m[1]!;
});
assert.equal(new Set(pins).size, 1, `build and runtime stages use the same Node release (${pins.join(', ')})`);
const floor = missingSecurityFixes(pins[0]!);
assert.equal(floor, null, `the image's Node ${pins[0]} is missing published security fixes; use ${floor} or later`);
assert.ok(NODE_SECURITY_FLOOR[imageMajor], `server/src/nodeSupport.ts has a security floor for Node ${imageMajor}`);
// ...and the check itself knows what it is looking for.
assert.equal(missingSecurityFixes('24.22.0'), '24.22.1', 'the release before the October 2026 fixes is caught');
assert.equal(missingSecurityFixes('v24.22.1'), null);
assert.equal(missingSecurityFixes('24.23.0'), null, 'a later minor is not mistaken for an older one');
assert.equal(missingSecurityFixes('24.9.9'), '24.22.1', 'versions compare as numbers, not text');

const ci = read('.github/workflows/ci.yml').replace(/^\s*#.*$/gm, '');
const ciNodes = [...ci.matchAll(/node-version:\s*'?(\d+)/g)].map((m) => Number(m[1]));
assert.ok(ciNodes.length > 0, 'CI names its Node version');
assert.ok(ciNodes.every((n) => n === imageMajor), `CI tests on the Node line production runs (CI ${ciNodes.join(', ')}, image ${imageMajor})`);

const pkg = JSON.parse(read('package.json')) as { engines?: { node?: string }; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
const engineMin = Number(/>=\s*(\d+)/.exec(pkg.engines?.node ?? '')?.[1]);
assert.ok(Number.isFinite(engineMin), 'package.json declares a minimum Node version');
assert.ok(engineMin <= imageMajor, 'the image satisfies package.json engines');
assert.ok(new Date(`${NODE_END_OF_LIFE[engineMin] ?? '1970-01-01'}T00:00:00Z`) > today, `package.json does not still allow an end-of-life Node (engines ${pkg.engines?.node})`);

// The table itself must be right about the past, or none of the above means anything.
assert.equal(supported(20).ok, false, 'Node 20 is past end of life');
assert.equal(NODE_END_OF_LIFE[20], '2026-04-30');

// ---- the security headers' package ------------------------------------------
// The server builds helmet's middleware itself, once (performance plan P1.30),
// so helmet is a direct dependency, pinned exactly: a minor release changes
// what the defaults send, and the header pin in security.test.mts is what
// decides whether that is accepted, not an install.
assert.match(pkg.dependencies?.helmet ?? '', /^\d+\.\d+\.\d+$/, 'helmet is a direct runtime dependency, pinned to one version');
assert.match(read('server/src/routes.ts'), /^import helmet from 'helmet';$/m, 'and the server uses it directly');

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
// And it runs the bundle with plain node, not TypeScript under tsx (performance plan P1.31).
assert.match(runtime, /^CMD \["node", "server\/build\/server\.mjs"\]\s*$/m, 'node is the main process, so it receives SIGTERM, running the server bundle');
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

// ---- the server bundle (performance plan P1.31) --------------------------------
// The image runs server/build/server.mjs, made in the build stage. It must
// never be public, never carry a secret or a source map, and never hide a
// dependency from npm audit.
{
  const buildStage = stages[0];
  const at = (re: RegExp): number => { const m = re.exec(buildStage); return m ? m.index : -1; };
  assert.ok(at(/^RUN npm run build:prod$/m) >= 0 && at(/^RUN npm run build:server$/m) > at(/^RUN npm run build:prod$/m), 'the build stage makes the seat table and the bundle, after the site');
  assert.ok(at(/^RUN npm prune --omit=dev/m) > at(/^RUN npm run build:server$/m), 'before the build tools are pruned');
  const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
  assert.equal(scripts['build:server'], 'tsx scripts/seat-table.mts && node scripts/bundle-server.mjs', 'build:server writes the seat table and bundles');
  assert.equal(scripts.start, 'NODE_ENV=production node server/build/server.mjs', 'npm start runs the bundle too');
  for (const tool of ['tsx', 'esbuild']) {
    assert.equal(pkg.dependencies?.[tool], undefined, `${tool} is not a runtime dependency: it never reaches the image`);
    assert.ok(pkg.devDependencies?.[tool], `${tool} is a build dependency`);
  }
  assert.ok(dockerignore.includes('server/build'), 'a local bundle never enters the build context: the image makes its own');
  const { BUNDLE_OPTIONS } = await import('../../scripts/bundle-server.mjs');
  assert.equal(BUNDLE_OPTIONS.outfile, 'server/build/server.mjs');
  assert.doesNotMatch(String(BUNDLE_OPTIONS.outfile), /(^|\/)dist\//, 'the bundle is outside dist/, the public web root');
  assert.equal(BUNDLE_OPTIONS.sourcemap, false, 'no source map');
  assert.equal(BUNDLE_OPTIONS.packages, 'external', 'every package stays an import, visible to npm audit');
  assert.equal('define' in BUNDLE_OPTIONS, false, 'nothing defined at build time: process.env is read at run time');
  assert.doesNotMatch(read('scripts/bundle-server.mjs'), /\bdefine\s*:/, 'nor anywhere in the bundler script');
  // Build one and look at it.
  const { build } = await import('esbuild');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const out = `${mkdtempSync(`${tmpdir()}/tifo-bundle-`)}/server.mjs`;
  await build({ ...(BUNDLE_OPTIONS as object), outfile: out, logLevel: 'silent' } as Parameters<typeof build>[0]);
  const bundle = read(out);
  assert.doesNotMatch(bundle, /sourceMappingURL/, 'no source map, inline or linked');
  assert.match(bundle, /process\.env\.DATABASE_URL/, 'the database URL is read when it runs');
  assert.match(bundle, /process\.env\.AI_ADMIN_PASSWORD/, 'and so is the admin password');
  const imported = [...bundle.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm), ...bundle.matchAll(/^import\s+"([^"]+)"/gm)].map((m) => m[1]);
  const runtimeDeps = new Set(Object.keys(pkg.dependencies ?? {}));
  for (const spec of new Set(imported)) {
    if (spec.startsWith('node:')) continue;
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    assert.ok(runtimeDeps.has(name), `the bundle imports ${spec}, which must be a runtime dependency`);
  }
  assert.ok(!imported.some((x) => x.startsWith('tsx') || x.startsWith('esbuild')), 'and never a build tool');
  // Nothing in the public web root is a map or a server file.
  const { existsSync, readdirSync } = await import('node:fs');
  if (existsSync('dist')) {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
    const files = walk('dist');
    assert.deepEqual(files.filter((f) => f.endsWith('.map')), [], 'no source maps in dist/');
    assert.deepEqual(files.filter((f) => /server\.mjs$|seat-table\.json$/.test(f)), [], 'no server file in dist/');
  }
  console.log(`  server bundle: built outside dist/, no map, no define, ${new Set(imported).size} imports all runtime dependencies or node:`);
}

// ---- the seat table ----------------------------------------------------------
// The server reads every ground's seat count and royal box from
// server/data/seat-table.json instead of generating 104 seat maps at boot
// (performance plan P1.31). The counts decide whether a design may be saved,
// so the table must be exactly what the generator makes: every ground is
// generated again here and compared, row by row.
{
  const { formatSeatTable, generateSeatTable, readSeatTable, SEAT_TABLE_PATH } = await import('../src/seatTable');
  const { shippedTemplates } = await import('../../src/core/stadiumCatalog');
  const started = Date.now();
  const fresh = generateSeatTable();
  const onDisk = readSeatTable(SEAT_TABLE_PATH);
  assert.ok(onDisk, 'server/data/seat-table.json exists and reads as a table');
  assert.equal(onDisk.size, shippedTemplates().length, 'one row per shipped ground');
  for (const row of fresh) assert.deepEqual(onDisk.get(row.key), row, `${row.key}: the table's row is what the generator makes (run npm run seats:table)`);
  assert.equal(read(SEAT_TABLE_PATH), formatSeatTable(fresh), 'and the file is byte for byte what the generator writes');
  console.log(`  seat table: ${fresh.length} grounds regenerated and identical (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

console.log(`deploy: all assertions passed (${window.why}; image pinned to Node ${pins[0]}, at or above the security floor; non-root image, lockfile-only installs, dockerignore, CI token + pins, secret scan, restart policy)`);

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
