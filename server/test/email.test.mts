/**
 * Email delivery is now something the server can be asked about.
 *
 * Every assertion here failed before this change: a refused send answered 202
 * with {ok:true}, nothing counted it, and no endpoint could tell a missing key
 * from a refused one. The provider is stubbed, because the point is what the
 * SERVER does when a send fails — not whether Resend is up.
 */
import { generateSeatMap } from '../../src/core/seatmap';
import { DEFAULT_TEMPLATE } from '../../src/core/template';
import { MemoryAuthRepository, MemoryDesignRepository } from '../src/memoryRepo';
import { buildApp, type TemplateInfo } from '../src/routes';
import { configWarnings } from '../src/preflight';
import type { EmailSender, EmailMessage } from '../src/email';

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, x: unknown = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`);
};

class Stub implements EmailSender {
  sent: EmailMessage[] = [];
  refuse: string | null = null;
  async send(msg: EmailMessage): Promise<void> {
    if (this.refuse) throw new Error(this.refuse);
    this.sent.push(msg);
  }
}

const map = generateSeatMap(DEFAULT_TEMPLATE);
const templates: TemplateInfo[] = [
  { id: DEFAULT_TEMPLATE.id, version: DEFAULT_TEMPLATE.version, name: DEFAULT_TEMPLATE.name, seatCount: map.count },
];
const mail = new Stub();
const auth = new MemoryAuthRepository();
const designs = new MemoryDesignRepository((id) => auth.usernameOf(id));
const app = await buildApp(designs, auth, templates, { emailSender: mail });

const reg = async (n: string) => app.inject({
  method: 'POST', url: '/api/auth/register',
  payload: { username: n, password: 'correct-horse-battery-9', email: `${n}@example.com`, acceptedVersion: '1' },
});

console.log('\n— registration says whether the email went out —');
let r = await reg('alpha1');
check('a sent one reports emailSent: true', r.json().emailSent === true, JSON.stringify(r.json()).slice(0, 90));
const tokenA = r.json().token;

mail.refuse = 'The tifomaker.org domain is not verified';
r = await reg('bravo1');
check('registration still succeeds when mail is refused', r.statusCode === 201, String(r.statusCode));
check('...and says emailSent: false', r.json().emailSent === false, JSON.stringify(r.json()).slice(0, 110));
const tokenB = r.json().token;

console.log('\n— resend tells the truth —');
let rs = await app.inject({ method: 'POST', url: '/api/auth/verify/resend', headers: { authorization: `Bearer ${tokenB}` } });
check('a refused resend is a 502, not a 202', rs.statusCode === 502, `${rs.statusCode} ${rs.body.slice(0, 80)}`);
check('...and does not leak the provider text to the caller', !/tifomaker\.org domain/.test(rs.body), rs.body.slice(0, 80));

mail.refuse = null;
rs = await app.inject({ method: 'POST', url: '/api/auth/verify/resend', headers: { authorization: `Bearer ${tokenB}` } });
check('a successful resend is a 202', rs.statusCode === 202 && rs.json().emailSent === true, `${rs.statusCode} ${rs.body.slice(0, 60)}`);

console.log('\n— the cooldown —');
rs = await app.inject({ method: 'POST', url: '/api/auth/verify/resend', headers: { authorization: `Bearer ${tokenB}` } });
check('a second resend inside a minute is refused', rs.statusCode === 429, `${rs.statusCode} ${rs.body.slice(0, 80)}`);
check('...and says how long to wait', typeof rs.json().retryInSeconds === 'number' && rs.json().retryInSeconds <= 60, rs.body.slice(0, 80));
// A refusal must not start the clock, or one bad send locks you out for a minute.
mail.refuse = 'rate_limit_exceeded';
const rsA = await app.inject({ method: 'POST', url: '/api/auth/verify/resend', headers: { authorization: `Bearer ${tokenA}` } });
mail.refuse = null;
const rsA2 = await app.inject({ method: 'POST', url: '/api/auth/verify/resend', headers: { authorization: `Bearer ${tokenA}` } });
check('a refused send does not spend the cooldown', rsA.statusCode === 502 && rsA2.statusCode === 202, `${rsA.statusCode} then ${rsA2.statusCode}`);

console.log('\n— the admin can ask what the mail is doing —');
const open = await app.inject({ method: 'GET', url: '/api/admin/email' });
check('it is admin-gated', open.statusCode === 403, String(open.statusCode));

console.log('\n— preflight says it out loud —');
const prodNoKey = configWarnings({ NODE_ENV: 'production' } as NodeJS.ProcessEnv);
const w = prodNoKey.find((x) => x.key === 'RESEND_API_KEY');
check('no key in production is a warning', !!w, w?.effect.slice(0, 60));
check('...and it says nobody is receiving anything', /NO EMAIL IS BEING SENT/.test(w?.effect ?? ''));
const devNoKey = configWarnings({} as NodeJS.ProcessEnv);
check('but not in development', !devNoKey.some((x) => x.key === 'RESEND_API_KEY'));
const oddFrom = configWarnings({ NODE_ENV: 'production', RESEND_API_KEY: 'k', EMAIL_FROM: 'a@gmail.com' } as NodeJS.ProcessEnv);
check('a From off the verified domain is a warning', oddFrom.some((x) => x.key === 'EMAIL_FROM'));
const okFrom = configWarnings({ NODE_ENV: 'production', RESEND_API_KEY: 'k', EMAIL_FROM: 'TifoMaker <no-reply@tifomaker.org>' } as NodeJS.ProcessEnv);
check('the default From is not', !okFrom.some((x) => x.key === 'EMAIL_FROM'));

await app.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
