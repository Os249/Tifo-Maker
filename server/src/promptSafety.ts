/**
 * First-line safety screen for AI prompts. This is a conservative keyword guard
 * that blocks the clearly-harmful categories BEFORE a prompt reaches the model
 * (the model providers also enforce their own safety on top of this). It is not
 * a complete moderation system — it errs toward letting normal tifo prompts
 * through while catching the obvious abuse a football-tifo tool should never help
 * with. Tune the lists as needed.
 */

export type PromptScreen = { ok: true } | { ok: false; message: string };

const BLOCK_MESSAGE =
  'This request was blocked because it may break the Acceptable Use rules. Try a different design idea.';

// Anything sexual involving minors — zero tolerance. Two ways to match:
//  1) explicit single tokens; 2) a minor-word together with a sexual-word.
const CSAM_TOKENS =
  /\b(csam|child\s?porn|childporn|cp\s?content|pedophil|paedophil|lolicon|loli|shota)\b/i;
const MINOR_WORDS =
  /\b(child|children|kid|kids|minor|minors|underage|under[- ]?age|preteen|pre[- ]?teen|toddler|infant|schoolgirl|schoolboy|little\s?(girl|boy))\b/i;
const SEXUAL_WORDS = /\b(sex|sexual|nude|nudes|naked|porn|pornographic|erotic|rape|molest|fondle)\b/i;

// Terrorism / violent extremism / hate symbols and praise.
const EXTREMISM =
  /\b(isis|isil|daesh|al[- ]?qaeda|al[- ]?shabaab|boko\s?haram|nazi|neo[- ]?nazi|swastika|kkk|ku\s?klux|white\s?power|heil\s?hitler|sieg\s?heil|jihadi|jihadist|suicide\s?bomb(er|ing)?)\b/i;

// Calls for violence / genocide against a group.
const VIOLENCE = /\b(genocide|ethnic\s?cleansing|kill\s?all|gas\s?the|lynch|death\s?to)\b/i;

// Weapon / explosive / bioweapon construction (not a tifo prompt — block).
const WEAPONS =
  /\b(?:how\s?to\s?)?(?:make|build|construct|synthesi[sz]e)\b[^.]{0,30}\b(bomb|explosive|ied|nerve\s?agent|sarin|anthrax|ricin|chemical\s?weapon)\b/i;

/** Returns ok:false with a user-facing message when a prompt should be blocked. */
export function screenPrompt(prompt: string): PromptScreen {
  const t = prompt.toLowerCase();
  if (CSAM_TOKENS.test(t)) return { ok: false, message: BLOCK_MESSAGE };
  if (MINOR_WORDS.test(t) && SEXUAL_WORDS.test(t)) return { ok: false, message: BLOCK_MESSAGE };
  if (EXTREMISM.test(t)) return { ok: false, message: BLOCK_MESSAGE };
  if (VIOLENCE.test(t)) return { ok: false, message: BLOCK_MESSAGE };
  if (WEAPONS.test(t)) return { ok: false, message: BLOCK_MESSAGE };
  return { ok: true };
}
