/**
 * Read an Arabic voice-over line in TifoMaker's ElevenLabs voice.
 *
 *   node marketing/video-studio/voice/say.mjs <voice-id> <out.mp3> "<line>"
 *   node marketing/video-studio/voice/say.mjs <voice-id> <out.mp3> --file script.txt
 *
 * Every Arabic word must carry its harakat (decided 26 Nov 2026): without them
 * the voice guesses, and a guess can change the meaning. A line with a bare
 * word is refused, and the bare words are listed.
 *
 * The API key is a network secret on the environment (api.elevenlabs.io), so
 * nothing here holds it; the proxy adds it to the request.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [voice, out, ...rest] = process.argv.slice(2);
const text = rest[0] === '--file' ? readFileSync(rest[1], 'utf8').trim() : rest.join(' ').trim();
if (!voice || !out || !text) {
  console.error('usage: say.mjs <voice-id> <out.mp3> "<line>" | --file script.txt');
  process.exit(2);
}

/** Arabic words with no haraka at all (fatha to sukun, shadda, dagger alif, tanwin). */
export function bareWords(s) {
  const words = s.match(/[ء-يًٰ-ْٱ]+/g) || [];
  return words.filter((w) => /[ء-ي]/.test(w) && !/[ً-ْٰ]/.test(w) && !/^(?:و|ف|ب|ل|ك)$/.test(w));
}
const bare = bareWords(text);
if (bare.length) {
  console.error(`refused: ${bare.length} word(s) without harakat: ${[...new Set(bare)].join('، ')}`);
  process.exit(1);
}

const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text, model_id: 'eleven_v3', language_code: 'ar' }),
});
if (!r.ok) {
  console.error('ElevenLabs said', r.status, (await r.text()).slice(0, 300));
  process.exit(1);
}
writeFileSync(out, Buffer.from(await r.arrayBuffer()));
console.log('saved', out);
