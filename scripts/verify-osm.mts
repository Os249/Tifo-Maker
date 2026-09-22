/**
 * Does the stadium lookup actually find stadiums?
 *
 * `verify-stadiumfit` proves the estimator is right about a footprint it is
 * handed. Nothing proved the app could GET a footprint, which is how a feature
 * shipped where typing "Anfield" returned nothing after 48 seconds: every test
 * fed the fitter a ring from a fixture, and the one step between the user and
 * the fitter was the only step never exercised.
 *
 * This hits the real service. That is the point — a mocked search cannot fail
 * the way the shipped one did.
 *
 *   npx tsx scripts/verify-osm.mts            # the standard list
 *   npx tsx scripts/verify-osm.mts "San Siro" # one ground
 *
 * It is deliberately not part of `npm run build`: it depends on a public API
 * that is sometimes busy, and a red build over somebody else's load is noise.
 * Run it after touching src/net/osm.ts, and before shipping anything that
 * claims to look a stadium up.
 */

import { findStadiums, withGeometry, OsmError } from '../src/net/osm';

/**
 * Grounds that must resolve, and what a right answer looks like.
 *
 * `expect` is matched case-insensitively against the returned name, because OSM
 * often carries the official name rather than the one fans use — San Siro is
 * tagged Giuseppe Meazza, the Maracanã is tagged Jornalista Mário Filho. A test
 * that demanded the searched string back would fail on correct answers.
 */
const CASES: { q: string; expect: RegExp; note?: string }[] = [
  { q: 'Anfield', expect: /anfield/i },
  { q: 'Old Trafford', expect: /old trafford/i },
  { q: 'Wembley Stadium', expect: /wembley/i, note: 'a relation, not a way' },
  { q: 'King Fahd International Stadium', expect: /king fahd/i },
  { q: 'Allianz Arena', expect: /allianz/i },
  { q: 'San Siro', expect: /meazza|siro/i, note: 'nickname → official name' },
  { q: 'Maracana', expect: /maracan|mário filho|mario filho/i, note: 'nickname → official name' },
  { q: 'Camp Nou Barcelona', expect: /camp nou/i, note: 'city needed: OSM has it as Spotify Camp Nou' },
  { q: 'Estadio Santiago Bernabéu', expect: /bernab/i },
  // Arabic works, but the word matters: OSM tags the big grounds as استاد, and
  // searching ملعب (the everyday word) returns local five-a-side pitches instead.
  // That is why the Arabic help text names the right word rather than leaving
  // fans to guess — it was found by running exactly this case and watching it fail.
  { q: 'استاد الملك فهد الدولي', expect: /king fahd|فهد/i, note: 'Arabic name' },
  { q: 'Al-Awwal Park', expect: /awwal/i },
  { q: 'Amman International Stadium', expect: /amman|عمان/i },
];

/** Names that must NOT resolve, so a pass cannot be faked by returning anything. */
const NEGATIVE = ['Qwertyuiop Stadium', 'Zzzzzz Ground'];

/** Inputs that used to produce an HTTP 400 because they went into a regex raw. */
const HOSTILE = ['Stadium (', 'a[b', 'x*+?', 'München "quoted"', '\\\\backslash'];

const ok = (s: string): string => `\u001b[32m✓\u001b[0m ${s}`;
const bad = (s: string): string => `\u001b[31m✗\u001b[0m ${s}`;

let failures = 0;

async function one(q: string, expect: RegExp, note?: string): Promise<void> {
  const t0 = Date.now();
  try {
    const hits = await findStadiums(q);
    if (!hits.length) {
      failures++;
      console.log(bad(`${q} — no results`));
      return;
    }
    const top = await withGeometry(hits[0]);
    const ms = Date.now() - t0;
    const matched = expect.test(top.name);
    const drawable = top.ring.length >= 6;
    if (!matched) failures++;
    if (!drawable) failures++;
    const line =
      `${q} → ${top.name}${top.where ? ` (${top.where})` : ''} ` +
      `[${top.osmType}/${top.id}] ${top.ring.length} pts` +
      `${top.capacity ? `, capacity ${top.capacity.toLocaleString()}` : ', no capacity tag'} — ${ms} ms` +
      `${note ? `  · ${note}` : ''}`;
    console.log(matched && drawable ? ok(line) : bad(`${line}${matched ? '' : '  ← name mismatch'}${drawable ? '' : '  ← no outline'}`));
  } catch (e) {
    failures++;
    const kind = e instanceof OsmError ? e.kind : 'threw';
    console.log(bad(`${q} — ${kind}: ${(e as Error).message}`));
  }
}

async function main(): Promise<void> {
  const only = process.argv[2];
  const cases = only ? [{ q: only, expect: /.+/, note: undefined }] : CASES;

  console.log(`\nLooking up ${cases.length} ground${cases.length === 1 ? '' : 's'} against the live service.\n`);
  for (const c of cases) await one(c.q, c.expect, c.note);

  if (!only) {
    console.log('\nNames that should find nothing:');
    for (const q of NEGATIVE) {
      try {
        const hits = await findStadiums(q);
        if (hits.length) { failures++; console.log(bad(`${q} → ${hits.length} results, expected none`)); }
        else console.log(ok(`${q} → nothing, correctly`));
      } catch (e) {
        failures++;
        console.log(bad(`${q} — threw instead of returning nothing: ${(e as Error).message}`));
      }
    }

    // The old code put the user's text straight into an Overpass regex, so any
    // of these returned HTTP 400 in under half a second and the panel reported
    // it as "OpenStreetMap is not answering". None of them may throw now.
    console.log('\nInputs that used to crash the query:');
    for (const q of HOSTILE) {
      try {
        await findStadiums(q);
        console.log(ok(`${JSON.stringify(q)} → handled`));
      } catch (e) {
        failures++;
        console.log(bad(`${JSON.stringify(q)} — threw: ${(e as Error).message}`));
      }
    }
  }

  console.log(
    failures === 0
      ? `\n\u001b[32mAll good.\u001b[0m\n`
      : `\n\u001b[31m${failures} failure${failures === 1 ? '' : 's'}.\u001b[0m Rerun before blaming the service — it rate-limits.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
