"""Writes the Hyperframes composition (index.html + one scene file per scene) for the /brag video."""
import json, numpy as np, pathlib
C = pathlib.Path('../composition')
MUSIC = 'assets/music/heroic-age.mp3'
# Beats of the track (`hyperframes beats`: 130 BPM, a beat every 0.46 s): the cuts.
# Short scenes are 4 beats, the film and the credit 6, so their words can be read.
T = [0, 3.755, 5.605, 8.375, 10.225, 12.985, 14.835, 16.685, 20.5]
NAMES = ['hook', 'pro', 'film', 'poster', 'credit', 'fonts', 'led', 'outro']

# Loudness of the music per 1/15 s, 0..1, for the glow behind the crown.
pcm = np.frombuffer(open('music.pcm', 'rb').read(), dtype='<i2').astype(float) / 32768
hop = 22050 // 15
rms = np.array([np.sqrt(np.mean(pcm[i:i + hop] ** 2)) for i in range(0, len(pcm) - hop, hop)])
rms = (rms - np.percentile(rms, 10)) / (np.percentile(rms, 98) - np.percentile(rms, 10))
rms = np.clip(rms, 0, 1)
def glow(sel, t0, t1):
    out = []
    for k in range(int(t0 * 15), int(t1 * 15)):
        out.append(f'tl.to("{sel}", {{ opacity: {0.35 + 0.5 * rms[k]:.2f}, duration: 0.06, ease: "none" }}, {k / 15 - t0:.3f});')
    return '\n    '.join(out)

FONTS = ''.join(
    f"@font-face {{ font-family: '{fam}'; font-weight: {w}; src: url('assets/fonts/{f}') format('woff2'); }}\n    "
    for fam, w, f in [('Changa', 700, 'changa-arabic-700-normal.woff2'), ('Changa', 800, 'changa-arabic-800-normal.woff2'),
                      ('Almarai', 700, 'almarai-arabic-700-normal.woff2'), ('Almarai', 800, 'almarai-arabic-800-normal.woff2'),
                      ('TM Inter', 700, 'inter-latin-700-normal.woff2'), ('TM Inter', 800, 'inter-latin-800-normal.woff2')])
BASE = FONTS + """#root { position: absolute; inset: 0; overflow: hidden; background: #070B14; color: #F1F4FB; font-family: 'TM Inter', 'Almarai', sans-serif; }
    .media { position: absolute; inset: 0; }
    .media img, .media video { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; object-fit: cover; }
    .scrim { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(7,11,20,.6) 0%, rgba(7,11,20,0) 24%, rgba(7,11,20,0) 46%, rgba(7,11,20,.94) 100%); }
    .words { position: absolute; direction: rtl; }
    .display { font-family: 'Changa', 'TM Inter', sans-serif; font-weight: 800; line-height: 1.15; text-shadow: 0 4px 30px rgba(0,0,0,.7); }
    .sub { font-family: 'TM Inter', 'Almarai', sans-serif; font-weight: 700; text-shadow: 0 2px 16px rgba(0,0,0,.8); }
    .chip { display: inline-flex; align-items: center; gap: 12px; font-weight: 800; font-size: 40px; color: #F5B43C; border: 2px solid rgba(245,180,60,.55); background: rgba(7,11,20,.78); border-radius: 999px; padding: 10px 28px; }
    .chip svg, .crown { fill: #F5B43C; }
    .mark { position: absolute; top: 108px; left: 192px; font-family: 'TM Inter', sans-serif; font-weight: 800; font-size: 44px; letter-spacing: .02em; }
    .mark b { color: #4A92F2; font-weight: 800; }
    .navy { position: absolute; inset: 0; background: radial-gradient(90% 90% at 50% 45%, #1a2d57 0%, #0B1120 60%, #070B14 100%); }"""
CROWN = '<path d="M3.2 7.6l4.6 3.6 3.4-5.7a.95.95 0 0 1 1.6 0l3.4 5.7 4.6-3.6a.6.6 0 0 1 .96.58L19.9 17H4.1L2.24 8.18a.6.6 0 0 1 .96-.58z"/><path d="M4.4 18.6h15.2V20a1 1 0 0 1-1 1H5.4a1 1 0 0 1-1-1z"/>'
def crown(px, id_=''): return f'<svg {f"id={chr(34)}{id_}{chr(34)} " if id_ else ""}class="crown" width="{px}" height="{px}" viewBox="0 0 24 24">{CROWN}</svg>'
def chip(id_): return f'<div><span id="{id_}" class="chip">{crown(40)}برو</span></div>'
RISE = lambda sel, at: f'tl.fromTo("{sel}", {{ y: 36, opacity: 0 }}, {{ y: 0, opacity: 1, duration: 0.4, ease: "power3.out" }}, {at});'
def settle(sel, d, s0=1.0, drift=0.06, x=0, y=0):
    # Lands on the cut with a small settle, then drifts in for the rest of the scene.
    return (f'tl.fromTo("{sel}", {{ scale: {s0 + 0.07:.3f}, x: {x}, y: {y} }}, {{ scale: {s0:.3f}, x: {x}, y: {y}, duration: 0.34, ease: "power3.out" }}, 0);\n    '
            f'tl.to("{sel}", {{ scale: {s0 + drift:.3f}, duration: {d - 0.36:.2f}, ease: "none" }}, 0.34);')

def scene(name, d, body, js, css=''):
    (C / 'compositions' / f'{name}.html').write_text(f"""<template>
  <style>
    {BASE}
    {css}
  </style>
  <div id="root" data-composition-id="{name}" data-width="1920" data-height="1080">
{body}
  </div>
  <script>
    const tl = gsap.timeline({{ paused: true }});
    {js}
    tl.to({{}}, {{ duration: 0.01 }}, {d - 0.02:.2f});
    window.__timelines["{name}"] = tl;
  </script>
</template>
""", encoding='utf-8')

D = [round(T[i + 1] - T[i], 2) for i in range(8)]
clip = lambda id_, d, cls='': f'id="{id_}" class="clip{(" " + cls) if cls else ""}" data-start="0" data-duration="{d}"'

# 1. Hook: the stand raises the tifo; two lines say what the site is.
d = D[0]
scene('hook', d, f"""    <div id="hook-media" class="media" data-layout-allow-overflow><video {clip('hook-film', d)} data-track-index="1" data-media-start="4.8" muted playsinline src="assets/film.mp4"></video></div>
    <div class="scrim"></div>
    <div class="mark">TIFO<b>MAKER</b></div>
    <div {clip('hook-words', d, 'words display')} data-track-index="2" style="right: 192px; left: 192px; bottom: 118px; font-size: 104px; display: flex; gap: 32px; white-space: nowrap;">
      <div id="hook-l1">صمّم تيفو ناديك</div><div id="hook-l2" style="color: #7FB0FF;">وشوفه في ملعبه</div>
    </div>""",
      settle('#hook-media', d, 1.18, 0.1) + '\n    ' + RISE('#hook-l1', 0.15) + '\n    ' + RISE('#hook-l2', 1.9) + '  // beat-locked: 1.915s')

# 2. Reveal: Pro. The crown's glow breathes with the music.
d = D[1]
scene('pro', d, f"""    <div class="navy"></div>
    <div id="pro-glow" style="position: absolute; left: 610px; top: 190px; width: 700px; height: 700px; border-radius: 50%; background: radial-gradient(circle, rgba(245,180,60,.34) 0%, rgba(245,180,60,0) 65%); opacity: .4;"></div>
    <div class="mark">TIFO<b>MAKER</b></div>
    <div {clip('pro-words', d, 'words')} data-track-index="1" style="inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;">
      <div style="display: flex; align-items: center; gap: 40px;">
        <div id="pro-word" class="display" style="font-size: 330px; line-height: 1; color: #F5B43C;">برو</div>
        <div id="pro-crown">{crown(300)}</div>
      </div>
      <div id="pro-sub" class="sub" style="font-size: 76px; font-weight: 800; margin-top: 30px;">فتحت. إضافات للي يبي أكثر</div>
    </div>""",
      'tl.fromTo("#pro-word", { scale: 0.7, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.4, ease: "back.out(1.7)" }, 0);  // beat-locked: 3.755s\n    '
      'tl.fromTo("#pro-crown", { scale: 0, rotation: -25 }, { scale: 1, rotation: 0, duration: 0.5, ease: "back.out(1.7)" }, 0.12);\n    '
      + RISE('#pro-sub', 0.22) + '\n    ' + glow('#pro-glow', T[1], T[2]))

def perk(name, d, media, title, sub, js, words_style='right: 192px; left: 192px; bottom: 118px;', size=128, scrim='<div class="scrim"></div>'):
    scene(name, d, f"""    {media}
    {scrim}
    <div {clip(name + '-words', d, 'words')} data-track-index="3" style="{words_style}">
      {chip(name + '-chip')}
      <div id="{name}-title" class="display" style="font-size: {size}px; margin-top: 12px;">{title}</div>
      {f'<div id="{name}-sub" class="sub" style="font-size: 52px;">{sub}</div>' if sub else ''}
    </div>""", js + '\n    ' + RISE(f'#{name}-chip', 0.06) + '\n    ' + RISE(f'#{name}-title', 0.13) + ('\n    ' + RISE(f'#{name}-sub', 0.27) if sub else ''))

# 3. The film.
d = D[2]
perk('film', d, f'<div id="film-media" class="media" data-layout-allow-overflow><video {clip("film-film", d)} data-track-index="1" data-media-start="9.2" muted playsinline src="assets/film.mp4"></video></div>',
     'فيلم يوم المباراة', 'Full HD وطولي 9:16', settle('#film-media', d, 1.2, 0.06, 0, -10))
# 4. The poster: words on the left, over the pitch.
d = D[3]
perk('poster', d, f'<div id="poster-media" class="media" data-layout-allow-overflow><img {clip("poster-img", d)} data-track-index="1" src="assets/poster-land-ar.jpg" alt=""></div>',
     'بوستر 4K', 'عرضي أو طولي', settle('#poster-media', d),
     words_style='left: 192px; width: 780px; bottom: 130px;', size=150,
     scrim='<div style="position: absolute; inset: 0; background: linear-gradient(90deg, rgba(7,11,20,.94) 0%, rgba(7,11,20,.7) 40%, rgba(7,11,20,0) 64%);"></div>')
# 5. The mark, then the fan's own credit, on the same frame.
d = D[4]
scene('credit', d, f"""    <div id="credit-media" class="media" data-layout-allow-overflow>
      <img {clip('credit-free', d)} data-track-index="1" src="assets/credit-free.jpg" alt="">
      <img id="credit-pro" class="clip" data-start="0" data-duration="{d}" data-track-index="2" src="assets/credit-pro.jpg" alt="" style="opacity: 0;">
    </div>
    <div style="position: absolute; inset: 0; background: linear-gradient(0deg, rgba(7,11,20,0) 0%, rgba(7,11,20,0) 13%, rgba(7,11,20,.8) 26%, rgba(7,11,20,.8) 42%, rgba(7,11,20,.15) 62%, rgba(7,11,20,.7) 100%);"></div>
    <div {clip('credit-tags', d, 'words')} data-track-index="3" style="top: 108px; right: 192px;">
      <span id="credit-tag-free" class="chip" style="color: #F1F4FB; border-color: #33415C; position: absolute; right: 0; top: 0; white-space: nowrap;">المجانية</span>
      <span id="credit-tag-pro" class="chip" style="position: absolute; right: 0; top: 0; opacity: 0;">{crown(40)}برو</span>
    </div>
    <div {clip('credit-words', d, 'words')} data-track-index="4" style="left: 192px; width: 1150px; bottom: 250px;">
      <div id="credit-title" class="display" style="font-size: 120px;">بدون علامة الموقع</div>
      <div id="credit-sub" class="sub" style="font-size: 60px; font-weight: 800; color: #F5B43C;">واسمك مكانها</div>
    </div>""",
      'tl.set("#credit-media", { scale: 1.5, x: -480, y: -270 }, 0);\n    '
      'tl.to("#credit-pro", { opacity: 1, duration: 0.2, ease: "none" }, 1.38);  // beat-grid: 11.605s\n    '
      'tl.to("#credit-tag-free", { opacity: 0, duration: 0.1, ease: "none" }, 1.38);\n    '
      'tl.to("#credit-tag-pro", { opacity: 1, duration: 0.15, ease: "none" }, 1.43);\n    '
      + RISE('#credit-title', 0.13) + '\n    ' + RISE('#credit-sub', 1.4))
# 6. A Pro face on the seats.
d = D[5]
perk('fonts', d, f'<div id="fonts-media" class="media" data-layout-allow-overflow><img {clip("fonts-img", d)} data-track-index="1" src="assets/font-block.jpg" alt=""></div>',
     'خطوط مميّزة', 'عربية وإنجليزية', settle('#fonts-media', d, 1.25, 0.06, 0, 90))
# 7. The LED boards: words at the top, the boards under them.
d = D[6]
perk('led', d, f'<div id="led-media" class="media" data-layout-allow-overflow><img {clip("led-img", d)} data-track-index="1" src="assets/led-panel.jpg" alt=""></div>',
     'كلامك على شاشات الملعب', '', settle('#led-media', d, 1.9, 0.12, 330, -330),
     words_style='right: 192px; left: 192px; top: 108px;', size=116,
     scrim='<div style="position: absolute; inset: 0; background: linear-gradient(180deg, rgba(7,11,20,.9) 0%, rgba(7,11,20,.5) 40%, rgba(7,11,20,0) 58%);"></div>')
# 8. Outro: the promise, then the question.
d = D[7]
scene('outro', d, f"""    <div class="navy"></div>
    <div id="outro-glow" style="position: absolute; left: 460px; top: 480px; width: 1000px; height: 520px; border-radius: 50%; background: radial-gradient(closest-side, rgba(245,180,60,.3) 0%, rgba(245,180,60,0) 100%); opacity: .4;"></div>
    <div class="mark">TIFO<b>MAKER</b></div>
    <div {clip('outro-words', d, 'words')} data-track-index="1" style="inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;">
      <div id="outro-promise" class="display" style="font-size: 136px; line-height: 1.2; text-shadow: none;">تصميم التيفو <span style="color: #3FC77F;">مجاني</span>،<br>وبيظل مجاني</div>
      <div id="outro-ask" style="margin-top: 56px; display: flex; align-items: center; gap: 40px; border: 2px solid rgba(245,180,60,.55); background: #1c1a17; border-radius: 36px; padding: 34px 64px;">
        {crown(110)}
        <div style="text-align: right;">
          <div class="sub" style="font-size: 44px; font-weight: 800; color: #F1F4FB; text-shadow: none;">سعر الإطلاق <span style="color: #A6B0C8; text-decoration: line-through; direction: ltr; unicode-bidi: isolate;">19.99</span></div>
          <div class="display" style="font-size: 104px; line-height: 1.1; color: #F5B43C; text-shadow: none;"><span style="direction: ltr; unicode-bidi: isolate;">13.99</span> ريال للشهر</div>
          <div style="font-family: 'TM Inter', sans-serif; font-weight: 800; font-size: 54px; direction: ltr; text-align: right; margin-top: 6px;">tifomaker.org/pro</div>
        </div>
      </div>
    </div>""",
      RISE('#outro-promise', 0.08) + '  // beat-locked: 16.685s\n    ' + RISE('#outro-ask', 1.1) + '\n    ' + glow('#outro-glow', T[7], T[8] - 0.1))

hosts = '\n'.join(
    f'      <div id="{n}" data-composition-id="{n}" data-composition-src="compositions/{n}.html" data-start="{T[i]}" data-duration="{D[i]}" data-track-index="1" data-track-kind="graphics" data-width="1920" data-height="1080"></div>'
    for i, n in enumerate(NAMES))
sfx = ''
(C / 'index.html').write_text(f"""<!doctype html>
<html lang="ar">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>
    <style>
      * {{ margin: 0; padding: 0; box-sizing: border-box; }}
      html, body {{ margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: #070B14; }}
      #root {{ width: 100%; height: 100%; }}
    </style>
  </head>
  <body>
    <!-- Launch cut (the price on the end card). /brag: Tifo Maker Pro. Cuts on the beats of the music (Heroic Age, 130 BPM). -->
    <div id="root" data-composition-id="main" data-start="0" data-duration="{T[8]}" data-width="1920" data-height="1080">
{hosts}
      <audio id="music" class="clip" data-start="0" data-duration="{T[8]}" data-track-index="2" data-volume="0.95" src="{MUSIC}"></audio>
{sfx}
    </div>
    <script>
      window.__timelines["main"] = gsap.timeline({{ paused: true }});
    </script>
  </body>
</html>
""", encoding='utf-8')
print('written', D, sum(D))
