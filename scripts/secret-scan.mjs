/**
 * Fail if a credential is committed.
 *
 * Checks every file git tracks (not node_modules, not ignored files) for the
 * shapes real keys have: the providers this project uses or might (Resend,
 * Google/Gemini, OpenAI, Anthropic, OpenRouter, Groq, Hugging Face), code hosts
 * and clouds (GitHub, AWS, npm, Stripe, Slack), private keys, and database URLs
 * that carry a real password. High-confidence patterns only, so a failure means
 * look now, not "probably noise".
 *
 * Runs in CI on every push and weekly, and locally with:
 *   node scripts/secret-scan.mjs
 *
 * A test fixture that must look like a key can carry the comment
 * "secret-scan: allow" on the same line. Never use it for a real key: rotate
 * the key instead, because history keeps what a later commit deletes.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const RULES = [
  ['Resend API key', /\bre_[A-Za-z0-9]{6,}_[A-Za-z0-9]{16,}\b/],
  ['Google / Gemini API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{32,}/],
  ['OpenRouter API key', /\bsk-or-v1-[a-f0-9]{32,}\b/],
  ['OpenAI API key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{40,}/],
  ['Groq API key', /\bgsk_[A-Za-z0-9]{40,}\b/],
  ['Hugging Face token', /\bhf_[A-Za-z0-9]{30,}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ['AWS access key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['Stripe live key', /\b[sr]k_live_[0-9a-zA-Z]{20,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/],
];

// A database URL is only a secret when it has a real password for a real host.
const DB_URL = /\bpostgres(?:ql)?:\/\/([^:@\s/'"`]+):([^@\s'"`]+)@([^/\s:'"`?]+)/g;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host', 'db', 'postgres', 'database', 'example.com', 'hostname', 'HOST']);
const PLACEHOLDERS = /^(?:pass(?:word)?|postgres|tifo|user|secret|changeme|x+|\*+|\.\.\.|<[^>]*>|\$\{[^}]*\}|\$[A-Z_]+)$/i;

const MAX_BYTES = 2 * 1024 * 1024;

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0')
  .filter(Boolean);

const findings = [];
const redact = (s) => (s.length <= 8 ? '****' : `${s.slice(0, 6)}…(${s.length} chars)`);

for (const file of files) {
  let size;
  try {
    size = statSync(file).size;
  } catch {
    continue; // deleted in the working tree
  }
  if (size > MAX_BYTES) continue;
  const buf = readFileSync(file);
  if (buf.subarray(0, 8000).includes(0)) continue; // binary
  const lines = buf.toString('utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.includes('secret-scan: allow')) return;
    for (const [kind, re] of RULES) {
      const m = re.exec(line);
      if (m) findings.push(`${file}:${i + 1}  ${kind}  ${redact(m[0])}`);
    }
    for (const m of line.matchAll(DB_URL)) {
      const [, , password, host] = m;
      if (LOCAL_HOSTS.has(host) || PLACEHOLDERS.test(password)) continue;
      findings.push(`${file}:${i + 1}  Database URL with a password  ${m[1]}:${redact(password)}@${host}`);
    }
  });
}

if (findings.length) {
  console.error(`secret-scan: ${findings.length} possible credential(s) in tracked files:\n`);
  for (const f of findings) console.error(`  ${f}`);
  console.error('\nIf one is real: revoke it at the provider first, then remove it. Deleting the line does not remove it from git history.');
  process.exit(1);
}
console.log(`secret-scan: ${files.length} tracked files, no credentials found`);
