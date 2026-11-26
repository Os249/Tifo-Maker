# Prompt for a local session: HUMAIN Voice setup and samples

Make an empty folder on your laptop (for example `~/tifomaker-humain`), open Claude
Code in that folder with Claude in Chrome turned on, and paste everything below the
line.

---

You are helping TifoMaker, a fan-made stadium tifo designer, set up HUMAIN Voice
text-to-speech for its social media videos, and record sample voice-overs for the
owner to choose from. Work only inside this folder. Everything you make goes here.

## Rules

1. **Never show, print, log or copy an API key**, in the chat, in a file you write,
   or in a command line. Do not create, view or copy keys in the HUMAIN console. The
   owner puts the key in `.env` themselves (step 2).
2. **Read only** in the HUMAIN console and docs: don't change settings, voices,
   billing or plans, and don't buy anything. If a page asks for payment,
   permissions or a confirmation you don't understand, stop and tell me.
3. **Don't post or publish anything** anywhere.
4. If something here doesn't match what you see, say so instead of guessing.

## Step 1: find the API details (Chrome)

In my signed-in Chrome, open https://console.voice.humain.com and, if it helps,
https://docs.voice.humain.com. Find and write down in `humain-api.md`:

- **The API URL** for text-to-speech (the SDK calls it `API_URL` or
  `HUMAIN_VOICE_API_URL`; it looks like `https://<host>`), and the Socket.IO path if
  it isn't the default `/socket.io` (the older `sautech.humain.com` uses
  `/realtime/socket.io`).
- **How the key is sent.** The SDK sends an `x-api-key` header; confirm or correct.
- **The text-to-speech model names.** The SDK (v0.19.0) knows `nebula`. Note any
  newer model and how to select it.
- **The output format.** The SDK says PCM16 at 24,000 Hz for Nebula.
- **Dialects, and whether text with harakat (Arabic diacritics) is supported or
  recommended.**
- Any **usage limits or costs** shown for the account.

## Step 2: the key

Tell me: "Create a new key in the console and put it in a file called `.env` in this
folder, as one line: `HUMAIN_VOICE_API_KEY=<your key>`. Tell me when it's there."
Wait for me. Then check only that the file exists and that the line starts with
`HUMAIN_VOICE_API_KEY=`, without printing it. Add `.env` to a `.gitignore` in this
folder.

## Step 3: list the voices

```
npm init -y
npm install @humain-voice/sdk@0.19.0
```

Write `list-voices.mjs`, which reads the key and URL from the environment (run it
with `node --env-file=.env`, after adding `HUMAIN_VOICE_API_URL=<the URL from step 1>`
to `.env` yourself; the URL is not secret). Use the SDK's `TTSClient` and
`listVoices()`, and save `voices.json` with each voice's id, label, gender, dialect,
languages, and emotions and styles when present. Print a short table (no key).

## Step 4: record the samples

Pick every **male** voice whose dialect is Saudi, Najdi, Hijazi or Gulf (up to 6;
if there are more, prefer young, energetic and conversational over formal or
news-reader voices). For each one, synthesise this script with the Nebula model
(or the newer model from step 1, if there is one), exactly as written, harakat
included:

```
تِيفُو نَادِيكْ، بِمَلْعَبَهْ الْحَقِيقِي، كُرْسِي كُرْسِي. نُمُورْ مَا تَهَابْ الْمَوْتْ! تِيفُو صَمَّمَهْ وَاحِدْ مِنْ جُمْهُورْ الْاِتِّحَادْ… وِشُوفُوهْ كَيْفْ يِرْتِفِعْ بِالْمُدَرَّجْ.
```

Use `client.synthesize(text, { voice_id, model })`, which returns raw PCM16 mono at
24,000 Hz. Save each as a playable WAV: write a proper 44-byte WAV header (PCM, 1
channel, 16-bit, 24000 Hz) before the bytes, or convert with ffmpeg if it is
installed (`ffmpeg -f s16le -ar 24000 -ac 1 -i in.pcm out.wav`). Name the files
`samples/<voice-label>.wav`.

If step 1 says a dialect or style can be set per request, record the first voice
once more with Saudi dialect and an energetic style, as
`samples/<voice-label>-saudi-energetic.wav`.

## Step 5: summary

Write `README.md` in this folder: the API URL and path, the model used, a table of
the voices recorded (label, id, dialect, gender, file), anything from step 1 that
matters (harakat support, limits, costs), and anything that failed and why. No key
anywhere.

## Step 6: hand it back

Tell me the folder is ready, list the files, and remind me to attach
`README.md`, `voices.json`, `humain-api.md` and the `samples/` files in my cloud
session (or to push them, if this folder is inside a clone of the TifoMaker repo, on
the branch `claude/tifo-social-media-strategy-g1psvc` under
`marketing/social/hq/media/voices/humain/`, never `.env`).
