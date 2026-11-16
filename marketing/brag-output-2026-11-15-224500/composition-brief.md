# Hyperframes Composition Brief: Tifo Maker Pro

## Objective
A short launch-style brag video for Tifo Maker, focused on the Pro plan that
opens in a few days.

## Output
- Composition directory: `composition/`
- Rendered video: `brag.mp4`
- Format: landscape, 1920x1080, 30 fps
- Duration: 20.5 s

## Source Material
- Project root: the Tifo Maker repository
- Primary files read: `server/src/proPlan.ts`, `src/proPage.ts`,
  `src/ui/i18n/strings.ts`, `docs/DESIGN.md`, `src/ui/tokens.css`
- Product name: TifoMaker
- Strongest claim: design your club's tifo and see it in its stadium
- Key visual to show: the Match Day film of an end stand raising a tifo
- Copy that must appear:
  - صمّم تيفو ناديك وشوفه في ملعبه
  - تصميم التيفو مجاني، وبيظل مجاني
  - كم يستاهل شهر برو؟ tifomaker.org/pro

## Creative Direction
- Tone preset: cinematic, restrained
- Interpretation: full-bleed product footage, big Arabic type, hard cuts on
  the bar, no jokes
- Angle: making a tifo is free and stays free; Pro is extras, shown as what
  they actually produce
- Hook: a dark arena, then the stand turns into "الزعيم"
- Outro: the free promise, then the price question
- Avoid: generic SaaS language, abstract filler, club colours on the frame

## Visual Identity (src/ui/tokens.css)
- Background: night navy #0B1120 / #070B14
- Text: #F1F4FB
- Accent: gold #F5B43C for Pro, green #3FC77F for "free", blue #4A92F2 for
  the wordmark's MAKER
- Display font: Changa 800; body: Almarai and Inter (files in
  `composition/assets/fonts/`)

## Storyboard
The storyboard in `brag-plan.md` is the contract: hook 3.76 s, Pro 1.85 s,
five highlights of 1.85 or 2.77 s, outro 3.82 s.

## Audio
- Audio role: one serious orchestral bed, no effects
- Music: `heroic-age.mp3` ("Heroic Age", Kevin MacLeod, CC BY 4.0; the
  20.5 s from 0:52, already faded), volume 0.95
- Music cue guidance: `hyperframes beats` (130 BPM); every cut on a beat
- Audio-reactive treatment: subtle; the glow behind the crown follows RMS

## Hyperframes Instructions
Followed: one scene per sub-composition, timed clips with stable ids, a
paused GSAP timeline per scene, `hyperframes check` as the gate (0 errors,
17/17 contrast checks), local render only.
