/**
 * Turning something a person already has — an email address, a display name —
 * into a username this site will accept.
 *
 * Nobody should have to invent a handle to keep a drawing. The sign-up form has
 * derived one from the email since the save-flow rewrite, and now the Google
 * callback has to do exactly the same thing on the server, from the same rules.
 * Two copies of "what makes a valid username" is how the server ends up
 * rejecting a name the browser just promised was fine, so there is one.
 */

/** The server's rule, and therefore everyone's rule. */
export const USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/;

/**
 * A username from whatever we were given, on the `attempt`-th try.
 *
 * Attempt 0 is the clean name; every attempt after that adds four digits,
 * because the only reason to be called again is that the last one was taken.
 * The seed is an email (the local part is used) or a display name.
 *
 * `random` is injected so the server can use a cryptographic source and a test
 * can make the result predictable. It returns a float in [0, 1) like
 * `Math.random`.
 */
export function deriveUsername(seed: string, attempt: number, random: () => number = Math.random): string {
  const local = seed.includes('@') ? (seed.split('@')[0] ?? '') : seed;
  const base = local
    .replace(/[^a-zA-Z0-9_]/g, '')
    .slice(0, 16)
    .replace(/^_+/, '');
  // "fan" rather than padding with digits: `al` becomes `alfan`, which still
  // reads like a name someone chose.
  const stem = base.length >= 3 ? base : `${base}fan`;
  const suffix = (): string => String(Math.floor(1000 + random() * 9000));
  const name = attempt === 0 ? stem : `${stem}${suffix()}`;
  return USERNAME_RE.test(name) ? name : `tifo${suffix()}`;
}
