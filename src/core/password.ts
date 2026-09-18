/**
 * The password policy. One module, used by the browser and by the server.
 *
 * Why one module. The sign-up form checked `password.length < 8`, the register
 * route checked `password.length < 8`, the change-password dialog checked
 * `next.value.length < 8` and the reset page checked `pw.value.length < 8` —
 * four copies of one rule in four files that knew nothing about each other.
 * Raising the bar in three of them and forgetting the fourth is not a
 * hypothetical; it is what happens the second time someone edits this. So the
 * rule lives here, the server imports it (it already imports `src/core/*`), and
 * the form imports the same function to say the same thing before the round
 * trip. The server is still the authority — the browser copy only buys the user
 * an answer without waiting.
 *
 * What the rules are, and why they are not the usual ones.
 *
 * NIST SP 800-63B rev 4 is explicit that a verifier "SHALL NOT impose other
 * composition rules (e.g., requiring mixtures of different character types)",
 * and OWASP ASVS 5.0 §6.2.5 repeats it. The "one capital, one number, one
 * symbol" ritual produces `Tifo@2024` — nine characters, entirely predictable,
 * and miserable to type on a phone — while forbidding
 * `the curva sings at midnight`, which is better by every measure. So there are
 * no composition rules here at all. Length plus a blocklist does the work:
 *
 *   - 12 characters minimum. ASVS §6.2.1 puts the floor at 8 and "strongly
 *     recommends" 15; NIST's SHALL for password-only sign-in is 15. 12 is the
 *     deliberate middle for a site where the funnel is the scarce resource —
 *     it is four characters of real margin over today's rule without being the
 *     thing that ends a sign-up.
 *   - 128 maximum, and a password that exceeds it is REJECTED, never truncated
 *     (ASVS §6.2.8). Silent truncation means the user's password is not the one
 *     they typed. The ceiling exists only so a megabyte of text cannot be fed
 *     to scrypt.
 *   - Every printable character, spaces included, and Unicode: Arabic, emoji,
 *     anything. Counted in code points, so an emoji is one character, not two.
 *   - A blocklist that is checked against the *folded* password, so `L1verp00l`
 *     is caught by the entry `liverpool` and `Password2026!` by `password`.
 *     ASVS §6.2.11 asks for context-specific words; on a tifo site that means
 *     club names, and they are in the list for the same reason `password` is.
 *
 * The 12-character floor is doing more work than it looks like. Most of a
 * published "top 3,000 passwords" list is six to eight characters long, so it
 * is already rejected before the blocklist is consulted. What survives is the
 * long stuff — `passwordpassword`, `qwertyuiop123456`, `liverpoolforever` —
 * which is what the folding and the pattern rules below are aimed at.
 *
 * There is no network call in here. Checking a password against Have I Been
 * Pwned would catch more, but it puts an outbound request from the sign-up path
 * to a third party and a dependency on that party being up; this is a local
 * decision instead.
 */

/** Minimum password length, in code points. */
export const PASSWORD_MIN = 12;

/**
 * Maximum password length. Above ASVS §6.2.9's "at least 64", and far below
 * anything that would make scrypt's HMAC step expensive.
 */
export const PASSWORD_MAX = 128;

/**
 * Why a password was refused. A code rather than a sentence, because the
 * browser has to say it in Arabic and the server has to say it in a JSON body,
 * and neither should be parsing the other's English.
 */
export type PasswordProblem =
  | 'blank'
  | 'short'
  | 'long'
  | 'digits'
  | 'repeated'
  | 'sequence'
  | 'context'
  | 'common';

export interface PasswordVerdict {
  ok: boolean;
  problem: PasswordProblem | null;
  /** Characters still needed. Only meaningful when `problem === 'short'`. */
  missing: number;
  /**
   * 0 refused · 1 weak · 2 fair · 3 good · 4 strong.
   *
   * This drives the meter and nothing else. It is a rough estimate of how much
   * guessing the password would take, not a promise — a bar cannot know that
   * the passphrase is a line from a song. Passing (score ≥ 1) is the only thing
   * that gates anything.
   */
  score: 0 | 1 | 2 | 3 | 4;
}

/** What the password must not be built out of: this person's own identifiers. */
export interface PasswordContext {
  email?: string;
  username?: string;
}

/**
 * NFC, per NIST's "SHOULD apply the normalization process for stabilized
 * strings using Normalization Form Canonical Composition".
 *
 * For ASCII this is the identity function, which is why applying it to existing
 * accounts is safe. It matters for Arabic, where the same letter can arrive
 * either precomposed or as a base letter plus a mark: without this, a password
 * typed on one keyboard would not match the same password typed on another.
 */
export function normalizePassword(raw: string): string {
  return (raw ?? '').normalize('NFC');
}

/**
 * Length in code points. `'👏'.length` is 2 in JavaScript and 1 to a human;
 * NIST says "each Unicode code point SHALL be counted as a single character".
 */
export function passwordLength(pw: string): number {
  return [...pw].length;
}

/**
 * Substitutions people believe are clever. `p@ssw0rd` and `password` are the
 * same password to anyone with a cracking rig, and they must be the same
 * password to this blocklist.
 */
const LEET: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'i',
  '!': 'i',
  '|': 'i',
  '3': 'e',
  '4': 'a',
  '@': 'a',
  '5': 's',
  $: 's',
  '7': 't',
  '+': 't',
  '8': 'b',
  '9': 'g',
  '(': 'c',
};

/**
 * Arabic letters, and Arabic digits, told apart.
 *
 * `\u0600-\u06ff` in one range would be wrong: it sweeps in ٠١٢٣ (the
 * Arabic-Indic digits) and the harakat, so `كلمة١٢٣٤` would look like eight
 * letters when it is four letters and four digits — and `١٢٣٤٥٦٧٨٩٠١٢` would
 * look like a word instead of the keypad run it is.
 */
const AR_LETTER = /[\u0621-\u064a\u066e-\u06d3\u06fa-\u06ff]/;
const AR_DIGIT = /[\u0660-\u0669\u06f0-\u06f9]/;

/**
 * Reduce a password to what a cracking wordlist would see: lower-cased,
 * punctuation and spaces dropped, and — when asked — leet undone, so
 * `P@ssw0rd` and `password` become the same string.
 *
 * Both foldings are tried, because undoing leet is not free: it turns the `0`
 * of `2026` into an `o`, which is fine for matching `password` and wrong for
 * matching `liverpool2026`. Checking with and against costs two passes over a
 * string that is at most 128 characters long.
 */
function fold(s: string, leet: boolean): string {
  let out = '';
  for (const ch of s.toLowerCase()) {
    const mapped = leet ? (LEET[ch] ?? ch) : ch;
    if (/[a-z0-9]/.test(mapped) || AR_LETTER.test(mapped) || AR_DIGIT.test(mapped)) out += mapped;
  }
  return out;
}

/** Just the letters of a folded string — the part a wordlist matches against. */
function letters(s: string): string {
  let out = '';
  for (const ch of s) {
    if (/[a-z]/.test(ch) || AR_LETTER.test(ch)) out += ch;
  }
  return out;
}

/** `abcabcabcabc` and `aaaaaaaaaaaa` both reduce to their unit. */
function collapseRepeat(s: string): string {
  for (let unit = 1; unit <= s.length >> 1; unit++) {
    if (s.length % unit) continue;
    const head = s.slice(0, unit);
    if (head.repeat(s.length / unit) === s) return head;
  }
  return s;
}

/**
 * The blocklist, as base words rather than passwords.
 *
 * Storing `liverpool` catches `liverpool`, `Liverpool1`, `L1verp00l2026`,
 * `liverpoolliverpool` and `!!liverpool!!` in one entry, because everything is
 * compared after folding, digit-stripping and repeat-collapsing. A flat list of
 * finished passwords would need hundreds of rows to cover the same ground and
 * would still miss the next variation.
 *
 * Four groups: the passwords everyone already knows, the words this particular
 * site invites (clubs, players, terrace vocabulary — ASVS §6.2.11's
 * "context-specific words"), the Arabic equivalents in both scripts, and the
 * site's own name.
 */
// `@__PURE__` so the bundler may drop all of this from a page that never
// checks a password. `src/ui/i18n.ts` imports the two length constants from
// here, and i18n is on every page including the landing page; without the
// annotation a `new Set(...)` at module scope is assumed to have side effects
// and the whole word list ships with the marketing page.
const BLOCKED = /* @__PURE__ */ new Set<string>(
  (
    // The classics and their neighbours.
    `password passwort passw contrasena motdepasse senha wachtwoord parola
     qwerty qwertz azerty qwertyuiop asdfgh asdfghjkl zxcvbn zxcvbnm poiuytrewq
     qazwsx qazwsxedc zaqwsx wsxedc abcdef abcdefg abcd letmein letmeinnow
     welcome welcomehome iloveyou iloveu ilovehim ilovehermore loveyou lovely
     admin administrator adminadmin root toor superuser sysadmin guest test
     testing testtest demo default changeme changeit secret secrete topsecret
     master masterkey monkey dragon shadow sunshine princess pokemon starwars
     superman batman spiderman ironman jordan michael jennifer jessica ashley
     charlie thomas daniel matthew joshua andrew hunter ranger trustno
     whatever freedom computer internet samsung google facebook instagram
     snapchat youtube twitter microsoft windows apple iphone android gmail
     hotmail yahoo outlook nothing anything something nobody nevermind
     baseball basketball hockey soccer football footballer champion champions
     winner winners legend legends forever together always never money life
     love lover loveme hello helloworld goodbye friend friends family home
     school student teacher summer winter spring autumn january february
     december birthday happybirthday merrychristmas newyear
     access accessgranted security secure private public online offline
     newpassword mypassword thepassword passwordone oldpassword
     killer flower butterfly chocolate cookie coffee pizza burger
     asdasd qweqwe zxczxc abcabc aaaaaa iiiiii oooooo` +
    // A tifo site's own vocabulary. These are the words this audience reaches
    // for first, which is exactly what makes them bad passwords here.
    ` tifo tifomaker tifomakerorg tifos curva curvasud curvanord ultras ultra
     ultrasgroup stadium stadion estadio derby matchday kickoff goalkeeper
     striker penalty offside dugout terrace theterrace stand thestand
     choreo choreography banner bannerdrop flag flagday supporter supporters
     fanatic fanatics awayday awaydays northstand southstand kop thekop
     liverpool liverpoolfc anfield ynwa youllneverwalkalone
     manchester manutd manunited oldtrafford reddevils glory gloryglory
     mancity etihad cityzens arsenal gunners emirates chelsea stamfordbridge
     tottenham spurs everton newcastle westham leeds aston villa
     barcelona barca fcbarcelona campnou visca viscabarca culer
     realmadrid madrid madridista bernabeu halamadrid atletico atleti
     sevilla valencia betis athletic bilbao
     juventus juve forzajuve milan acmilan rossoneri inter intermilan nerazzurri
     napoli forzanapoli roma forzaroma lazio fiorentina
     bayern bayernmunich fcbayern dortmund borussia bvb schalke leipzig
     leverkusen hamburg
     psg parissaintgermain marseille lyon monaco lille
     ajax feyenoord psveindhoven porto benfica sporting braga
     galatasaray fenerbahce besiktas trabzonspor
     zamalek alahly ahly esperance raja wydad
     alhilal hilal zaeem alnassr nassr alittihad ittihad alahli ahli
     alshabab shabab alettifaq alfateh alraed damac abha
     celtic rangers ajaxamsterdam
     ronaldo cristiano cristianoronaldo messi lionelmessi neymar mbappe
     benzema salah mohamedsalah haaland vinicius bellingham modric ramos
     iniesta xavi zidane zizou maradona pele ronaldinho beckham kaka
     drogba lampard gerrard scholes rooney henry kante mane firmino
     alonso buffon casillas neuer` +
    // Arabic, both as typed and as transliterated. Same reasoning as above:
    // these are the first words an Arabic-speaking fan reaches for.
    ` كلمةالسر كلمةالمرور الرقمالسري سري مرحبا اهلا اهلاوسهلا حبيبي حبيبتي
     احبك بحبك اللهاكبر الحمدلله بسماللهالرحمنالرحيم ماشاءالله انشاءالله
     السعودية الرياض جدة مكة المدينة الدمام الخبر الكويت الامارات دبي
     الهلال النصر الاتحاد الاهلي الشباب زعيمالاسيا العالمي
     كرةالقدم ملعب مدرج جمهور مشجع
     kalimatalsir alsalamalaikum salamalaikum habibi habibti ahebek
     alhamdulillah mashallah inshallah allahuakbar bismillah
     saudiarabia alsaudia riyadh jeddah makkah madinah dammam khobar
     kuwait dubai qatar bahrain oman lebanon
     mohammed muhammad ahmed ahmad mahmoud abdullah abdulaziz abdulrahman
     khaled khalid faisal fahad sultan salman nasser osama osamah omar
     fatima aisha maryam noura sara hind reem`
  )
    .split(/\s+/)
    .filter(Boolean),
);

/** Longest run stepping by ±1 in code point: `abcdef`, `98765`. */
function longestLadder(s: string): number {
  let best = 1;
  let run = 1;
  let dir = 0;
  for (let i = 1; i < s.length; i++) {
    const step = s.charCodeAt(i) - s.charCodeAt(i - 1);
    if ((step === 1 || step === -1) && (dir === 0 || step === dir)) {
      dir = step;
      run++;
    } else if (step === 1 || step === -1) {
      dir = step;
      run = 2;
    } else {
      dir = 0;
      run = 1;
    }
    if (run > best) best = run;
  }
  return best;
}

/** Rows of a QWERTY keyboard, plus the two common diagonal walks. */
const ROWS = [
  '`1234567890-=',
  'qwertyuiop[]\\',
  "asdfghjkl;'",
  'zxcvbnm,./',
  '!@#$%^&*()',
  '1qaz2wsx3edc4rfv5tgb6yhn7ujm',
  'qazwsxedcrfvtgbyhnujmikolp',
];

const MAX_WALK = 16;

/** Longest stretch that walks straight along one keyboard row, either way. */
function longestWalk(s: string): number {
  let best = 1;
  for (const row of ROWS) {
    const back = [...row].reverse().join('');
    for (let i = 0; i < s.length; i++) {
      // No row is longer than this, and a walk that long is condemned already —
      // the cap keeps a 128-character password from costing a quadratic scan on
      // an endpoint anyone can call.
      for (let len = Math.min(MAX_WALK, s.length - i); len > best; len--) {
        const slice = s.slice(i, i + len);
        if (row.includes(slice) || back.includes(slice)) {
          best = len;
          break;
        }
      }
    }
  }
  return best;
}

/** Longest run of one repeated character: `aaaa`. */
function longestRepeat(s: string): number {
  let best = 1;
  let run = 1;
  for (let i = 1; i < s.length; i++) {
    run = s[i] === s[i - 1] ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

/**
 * A rough bit estimate for the meter.
 *
 * Pool size from the character classes present, shrunk by how few distinct
 * characters are actually used — `Aaaaaaaaaaa1` touches three classes and is
 * still one letter repeated. Deliberately crude: it informs a bar, it does not
 * decide anything.
 */
function estimateBits(pw: string): number {
  const chars = [...pw];
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9\s]/.test(pw)) pool += 33;
  if (/\s/.test(pw)) pool += 1;
  if (/[^ -]/.test(pw)) pool += 100;
  const distinct = new Set(chars).size;
  const effective = Math.max(2, Math.min(pool, distinct * 3));
  return chars.length * Math.log2(effective);
}

function band(bits: number): 1 | 2 | 3 | 4 {
  if (bits < 45) return 1;
  if (bits < 60) return 2;
  if (bits < 80) return 3;
  return 4;
}

/**
 * How much of a password one blocklist word has to account for before the
 * password counts as that word wearing a hat.
 *
 * Whole-string equality was the first attempt and it was useless: `password`
 * was caught and `password1234` was not, which is the wrong way round — the
 * second is what people actually type. So a blocked word is enough on its own
 * when it makes up this much of the password's letters. At 0.55,
 * `liverpoolfc!!` and `Password2026!` are refused while `the curva sings at
 * midnight` and `coffee-table-lamp` are not, because in a long enough phrase no
 * single blocked word dominates — which is exactly the property that makes a
 * phrase a good password.
 */
const BLOCK_SHARE = 0.55;

/** Is this password mostly one word from the blocklist? */
function isBlocked(pw: string): boolean {
  for (const leet of [false, true]) {
    const alpha = letters(fold(pw, leet));
    if (!alpha) continue;
    // `passwordpassword` is `password` said twice, and must be judged as such.
    for (const candidate of new Set([alpha, collapseRepeat(alpha)])) {
      const floor = Math.max(4, candidate.length * BLOCK_SHARE);
      for (const word of BLOCKED) {
        if (word.length >= floor && candidate.includes(word)) return true;
      }
    }
  }
  return false;
}

/** The identifiers this person already told us, folded and worth comparing. */
function contextWords(ctx?: PasswordContext): string[] {
  const raw: string[] = [];
  if (ctx?.username) raw.push(ctx.username);
  if (ctx?.email) {
    const [local, domain] = ctx.email.split('@');
    if (local) raw.push(local);
    // The domain's first label only: `gmail`, not `gmail.com`.
    if (domain) raw.push(domain.split('.')[0] ?? '');
  }
  return raw.map((w) => fold(w, false)).filter((w) => w.length >= 4);
}

/**
 * The whole policy, in the order that produces the most useful complaint.
 *
 * Length first, because it is what is wrong nine times out of ten and the
 * answer ("four more characters") is actionable. Structure after that, so
 * someone who typed `aaaaaaaaaaaaaa` is told it is repetitive rather than told
 * it is long enough.
 */
export function checkPassword(raw: string, ctx?: PasswordContext): PasswordVerdict {
  const pw = normalizePassword(raw ?? '');
  const len = passwordLength(pw);
  const no = (problem: PasswordProblem, missing = 0): PasswordVerdict => ({
    ok: false,
    problem,
    missing,
    score: 0,
  });

  if (!pw.trim()) return no('blank');
  if (len < PASSWORD_MIN) return no('short', PASSWORD_MIN - len);
  if (len > PASSWORD_MAX) return no('long');

  // Twelve digits is a date, a phone number or a keypad run far more often than
  // it is a choice, and it is under 40 bits even when it is a choice.
  if (/^[\d٠-٩]+$/.test(pw)) return no('digits');

  const lower = pw.toLowerCase();
  const folded = fold(pw, false);

  // One unit typed over and over is as long as the unit, not as long as it
  // looks: `abcabcabcabc` is three characters of choice.
  const unit = collapseRepeat(lower);
  if (unit.length * 3 <= lower.length) return no('repeated');

  // One character held down is a repeat, not a run: `aaaaaaaaaaaaaa1` deserves
  // to be told it repeats, not that it walks along the keyboard.
  const held = longestRepeat(lower);
  if (held >= 6 && held >= lower.length * 0.7) return no('repeated');

  // A straight run — down the alphabet, up the digits, along a keyboard row —
  // that accounts for most of what was typed.
  const run = Math.max(longestLadder(lower), longestWalk(lower));
  if (run >= 6 && run >= lower.length * 0.7) return no('sequence');

  // Their own email or username, however dressed up.
  for (const word of contextWords(ctx)) {
    if (folded.includes(word) || (folded.length >= 4 && word.includes(folded))) return no('context');
  }

  if (isBlocked(pw)) return no('common');

  return { ok: true, problem: null, missing: 0, score: band(estimateBits(pw)) };
}

/**
 * Words for the suggested passphrase.
 *
 * Short, common, unambiguous when read aloud, and deliberately disjoint from
 * the blocklist above — a suggested password that the policy then refuses would
 * be a small humiliation.
 *
 * Just under three hundred words, so each one is about 8.2 bits: four of them
 * plus a two-digit number is roughly 39 bits of real choice, in something a
 * person can retype from memory. That is not a secret for a bank. It is a good
 * password for a tifo account, and it is far better than what anyone invents
 * under pressure at a sign-up form — which is the only alternative on offer at
 * that moment.
 */
const PHRASE_WORDS = /* @__PURE__ */ (
  `amber anchor arrow badge banjo basil beacon bean bell berry
   birch blade blanket bloom blue board bolt bottle branch brave bread breeze
   brick bridge bright brook brush bubble bucket buffalo bugle cabin cable
   cactus camel candle canvas canyon carbon cargo carpet castle cedar chalk
   charm cherry chess chest chime cider cinder circle clay cliff cloak clock
   cloud clover coast cobalt coin comet copper coral cotton cove crane crate
   crayon creek crest crown crystal cube cymbal daisy dawn delta denim desert
   diary dice dock dolphin domino donut dove dragonfly drift drum dune dusk
   eagle east echo ember emerald falcon feather fern fiddle field flame
   flint flute forest forge fox frost galaxy garden garnet gate ginger
   glacier glass globe glove granite grape grove guitar hammer harbor harvest
   hazel heron hill hollow honey horizon ivory jade jasmine jetty jewel
   jungle juniper kayak kettle kite lagoon lake lantern lark laurel leaf
   ledge lemon lentil lighthouse lilac linen lion lotus lunar lynx maple
   marble marsh meadow melon meteor mint mirror mist moss mountain mulberry
   nectar needle nest nickel noble north nutmeg oak oasis ocean olive
   onyx opal orbit orchard otter owl paddle palm paper parade parsley
   pasture pearl pebble pepper petal pewter pine pilot plateau plum
   pocket pollen pond poppy prairie prism puzzle quartz quiet quill radish
   rain raven reed reef ribbon ridge river robin rocket rose rudder saffron
   sage sail salt sand sapphire satin saucer scarf sea seed shell shore
   silk silver slate sled smoke snow sonnet spark sparrow spice spiral
   spruce squash stable star steam stone stork storm stream sugar summit
   swallow swan sycamore table talon tandem teak thistle thunder tide
   tiger timber topaz torch tower trail tulip tundra turtle valley vanilla
   velvet vessel vine violet walnut walrus wave whale wheat whisper willow
   window wolf wooden wren yarn yellow zephyr zinc`
)
  .split(/\s+/)
  .filter(Boolean);

/** Cryptographic randomness, unbiased. `Math.random()` has no business here. */
function pick<T>(list: readonly T[]): T {
  const limit = Math.floor(0x1_0000_0000 / list.length) * list.length;
  const buf = new Uint32Array(1);
  let n = 0;
  do {
    crypto.getRandomValues(buf);
    n = buf[0]!;
  } while (n >= limit);
  return list[n % list.length]!;
}

/**
 * A password worth suggesting: four words and two digits, hyphenated.
 * Around 25 characters, so it clears the minimum with room to spare, and it
 * passes `checkPassword` by construction (a test holds that).
 */
export function suggestPassphrase(): string {
  const words = [pick(PHRASE_WORDS), pick(PHRASE_WORDS), pick(PHRASE_WORDS), pick(PHRASE_WORDS)];
  const digits = pick(TWO_DIGITS);
  return `${words.join('-')}-${digits}`;
}

/** 10 through 99. A leading zero would be dropped by half the people typing it. */
const TWO_DIGITS = /* @__PURE__ */ Array.from({ length: 90 }, (_, i) => String(i + 10));

/** How many words the suggester draws from, so a test can assert the entropy. */
export const PHRASE_WORD_COUNT = PHRASE_WORDS.length;
