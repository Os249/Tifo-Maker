/**
 * A stand-in Moyasar for the browser suites (e2e-pay.mjs, e2e-pay-form.mjs):
 * invoices, payments made by the payment form, tokens and token charges, and
 * refunds, as far as server/src/moyasar.ts and Moyasar's own form use them
 * (docs.moyasar.com). Nothing here talks to Moyasar, and no real key or card
 * is involved: the card numbers below are Moyasar's published test numbers,
 * and what a card "does" is decided by its number.
 *
 *   4111 1111 1111 1111   Visa: 3-D Secure, then paid
 *   4201 3201 1111 1010   mada: 3-D Secure, then paid (company "mada")
 *   4000 0000 0000 0002   Visa: declined at once, no funds (response code 51)
 *
 * A payment that needs 3-D Secure is 'initiated' with a transaction_url on
 * https://3ds.moyasar.test/; the test stands in for the bank's page and ends
 * it with finish3ds(id, outcome).
 */
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';

/** The ways the bank's page can end, with the message Moyasar gives each (its "3DS errors" reference). */
export const OUTCOMES = {
  paid: null,
  auth: '3DS: Card authentication declined.',
  cancelled: '3DS: The authentication session has expired.',
  unavailable: '3DS: The authentication is unavailable, please try again later or contact issuer bank if problem persisted.',
  rejected: '3DS: The authentication attempt was rejected by the issuer bank.',
  error: '3DS: service error occurred.',
};

export function fakeMoyasar() {
  const invoices = new Map();
  const payments = new Map();
  const tokens = new Map();
  /** Every request, for the tests to look through: { method, path, key, body }. */
  const calls = [];
  /** Token charges fail this way while set: { message, code } or 'timeout-after-charging' or 'down'. */
  const state = { chargeFails: null };

  const tokenOf = (card) => {
    const id = `token_${randomBytes(18).toString('hex')}`;
    const t = { id, status: 'initiated', brand: card.company === 'master' ? 'master' : card.company, funding: 'credit', country: 'SA', month: card.month, year: card.year, name: card.name, last_four: card.number.slice(-4) };
    tokens.set(id, t);
    return t;
  };
  const companyOf = (number) => (number.startsWith('4201') ? 'mada' : number.startsWith('5') ? 'master' : 'visa');

  const view = (p) => JSON.parse(JSON.stringify(p));

  function createPayment(b, keyKind) {
    const id = b.given_id || randomUUID();
    if (payments.has(id)) return { code: 400, body: { type: 'invalid_request_error', message: 'Payment is already created.' } };
    const src = b.source || {};
    const p = {
      id, status: 'initiated', amount: b.amount, fee: 0, currency: b.currency, refunded: 0, refunded_at: null, captured: 0, description: b.description,
      invoice_id: null, ip: null, callback_url: b.callback_url, created_at: new Date().toISOString(), metadata: b.metadata || {}, source: {},
    };
    if (src.type === 'creditcard') {
      const number = String(src.number || '').replace(/\s+/g, '');
      const company = companyOf(number);
      p.source = { type: 'creditcard', company, name: src.name, number: `XXXX-XXXX-XXXX-${number.slice(-4)}`, gateway_id: 'fake', token: null, message: null, transaction_url: null, response_code: null };
      if (number === '4000000000000002') {
        p.status = 'failed';
        p.source.message = 'INSUFFICIENT FUNDS';
        p.source.response_code = '51';
      } else {
        p.source.transaction_url = `https://3ds.moyasar.test/authenticate?id=${id}`;
        if (src.save_card === true || src.save_card === 'true') {
          const t = tokenOf({ company, month: String(src.month), year: String(src.year).length === 2 ? `20${src.year}` : String(src.year), name: src.name, number });
          p.source.token = t.id;
        }
      }
      p._saveCard = src.save_card === true || src.save_card === 'true';
    } else if (src.type === 'token') {
      if (keyKind !== 'sk') return { code: 401, body: { type: 'authentication_error' } };
      const t = tokens.get(src.token);
      if (!t || t.status !== 'active') return { code: 400, body: { type: 'invalid_request_error', message: 'Token is not active' } };
      p.source = { type: 'creditcard', company: t.brand, name: t.name, number: `XXXX-XXXX-XXXX-${t.last_four}`, gateway_id: 'fake', token: t.id, message: 'APPROVED', transaction_url: null, response_code: '00' };
      const f = state.chargeFails;
      if (f && typeof f === 'object') {
        p.status = 'failed';
        p.source.message = f.message;
        p.source.response_code = f.code ?? null;
      } else {
        p.status = 'paid';
      }
    } else {
      return { code: 400, body: { type: 'invalid_request_error', message: 'unsupported source' } };
    }
    payments.set(id, p);
    return { code: 201, body: view(p) };
  }

  /** The bank's page ends: 'paid', or one of OUTCOMES' failures. Returns the query Moyasar adds to callback_url. */
  function finish3ds(id, outcome = 'paid') {
    const p = payments.get(id);
    if (!p) throw new Error(`no payment ${id}`);
    if (outcome === 'paid') {
      p.status = 'paid';
      p.source.message = 'APPROVED';
      p.source.response_code = '00';
      p.source.transaction_url = null;
      if (p.source.token && tokens.has(p.source.token)) tokens.get(p.source.token).status = 'active';
    } else {
      p.status = 'failed';
      p.source.message = OUTCOMES[outcome];
      p.source.transaction_url = null;
      if (p.source.token && tokens.has(p.source.token)) tokens.get(p.source.token).status = 'inactive';
    }
    return `id=${id}&status=${p.status}&message=${encodeURIComponent(p.source.message)}`;
  }

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' });
        res.end(code === 204 ? '' : JSON.stringify(obj));
      };
      if (req.method === 'OPTIONS') return send(204, null);
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      const basic = /^Basic (.+)$/.exec(req.headers.authorization || '');
      const key = basic ? Buffer.from(basic[1], 'base64').toString().replace(/:$/, '') : String(body.publishable_api_key || '');
      const keyKind = key.startsWith('sk_') ? 'sk' : key.startsWith('pk_') ? 'pk' : null;
      const path = (req.url || '').split('?')[0];
      calls.push({ method: req.method, path, key: keyKind, body });
      if (!keyKind) return send(401, { type: 'authentication_error' });
      if (state.chargeFails === 'down') return send(503, { type: 'api_error' });

      // ---- invoices (the hosted page, payments v1)
      const inv = /^\/v1\/invoices(?:\/([0-9a-f-]{36}))?$/.exec(path);
      if (inv && keyKind !== 'sk') return send(401, { type: 'authentication_error' });
      if (req.method === 'POST' && inv && !inv[1]) {
        const id = randomUUID();
        const i = { id, status: 'initiated', amount: body.amount, currency: body.currency, description: body.description, url: `https://checkout.moyasar.test/invoices/${id}`, success_url: body.success_url, back_url: body.back_url, metadata: body.metadata, payments: [] };
        invoices.set(id, i);
        return send(201, i);
      }
      if (req.method === 'GET' && inv?.[1]) return invoices.has(inv[1]) ? send(200, invoices.get(inv[1])) : send(404, { type: 'record_not_found' });

      // ---- payments
      if (req.method === 'POST' && path === '/v1/payments') {
        const r = createPayment(body, keyKind);
        return send(r.code, r.body);
      }
      const pay = /^\/v1\/payments\/([0-9a-f-]{36})(\/refund)?$/.exec(path);
      if (pay && keyKind !== 'sk') return send(401, { type: 'authentication_error' });
      if (req.method === 'GET' && pay && !pay[2]) return payments.has(pay[1]) ? send(200, view(payments.get(pay[1]))) : send(404, { type: 'record_not_found' });
      if (req.method === 'POST' && pay?.[2]) {
        const p = payments.get(pay[1]);
        if (p) { p.status = 'refunded'; p.refunded = p.amount; return send(200, view(p)); }
        for (const i of invoices.values()) {
          const x = i.payments.find((y) => y.id === pay[1]);
          if (x) { x.status = 'refunded'; x.refunded = x.amount; i.status = 'refunded'; return send(200, x); }
        }
        return send(404, { type: 'record_not_found' });
      }

      // ---- tokens
      const tok = /^\/v1\/tokens\/(token_[A-Za-z0-9]+)$/.exec(path);
      if (tok && keyKind !== 'sk') return send(401, { type: 'authentication_error' });
      if (req.method === 'GET' && tok) return tokens.has(tok[1]) ? send(200, tokens.get(tok[1])) : send(404, { type: 'record_not_found' });
      if (req.method === 'DELETE' && tok) return tokens.delete(tok[1]) ? send(204, null) : send(404, { type: 'record_not_found' });

      send(404, { type: 'not_found' });
    });
  });

  return {
    server, invoices, payments, tokens, calls, state, finish3ds,
    listen: (port) => new Promise((r) => server.listen(port, '127.0.0.1', r)),
    close: () => server.close(),
    /** Pay an invoice (the hosted page): Apple Pay, at the invoice's amount. */
    payInvoice(id) {
      const i = invoices.get(id);
      i.status = 'paid';
      i.payments.push({ id: randomUUID(), status: 'paid', amount: i.amount, currency: i.currency, refunded: 0, source: { type: 'applepay' } });
    },
  };
}
