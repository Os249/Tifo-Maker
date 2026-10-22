/**
 * The password length limits, on their own.
 *
 * core/password.ts is the policy (and re-exports these, so the server and every
 * existing import see the same two numbers). They live in a module of their own
 * so that code which only has to SAY the limits, such as the translation table
 * that every page loads, can import them without the grader and its blocklist
 * coming along (performance plan P1.15). Changing a number here changes the
 * policy everywhere, server included.
 */

/** Minimum password length, in code points. */
export const PASSWORD_MIN = 12;

/**
 * Maximum password length. Above ASVS §6.2.9's "at least 64", and far below
 * anything that would make scrypt's HMAC step expensive.
 */
export const PASSWORD_MAX = 128;
