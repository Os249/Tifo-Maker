"""
The launch video (v3): writes the Hyperframes composition, one scene file per scene.

Four tifos published by fans on tifomaker.org, filmed from a flying camera as
the seats go up, then what the site is, then Pro and the launch price. Cut to "Heroic Age" (Kevin MacLeod,
CC BY 4.0), 62.37 s to the track's own ending: 130 BPM, a bar every 1.85 s.
Run from this folder:  python3 build.py   (needs work/music.pcm, see README)
"""
import numpy as np, pathlib
C = pathlib.Path('../composition')
MUSIC = 'assets/heroic-age-end.mp3'
# Beats of the excerpt (hyperframes beats on the whole track, minus 62.37 s).
T = dict(barca=0, ahli=3.69, mtu=5.54, qassim=7.38, title=9.22, brand=12.91, pro=14.77, film=16.63, poster=18.46, credit=20.32, more=22.13, price=23.99, end=27.5)
NAMES = list(T)[:-1]
START = [T[n] for n in NAMES]
D = [round(list(T.values())[i + 1] - START[i], 3) for i in range(len(NAMES))]

pcm = np.frombuffer(open('music.pcm', 'rb').read(), dtype='<i2').astype(float) / 32768
hop = 22050 // 15
rms = np.array([np.sqrt(np.mean(pcm[i:i + hop] ** 2)) for i in range(0, len(pcm) - hop, hop)])
rms = np.clip((rms - np.percentile(rms, 10)) / (np.percentile(rms, 98) - np.percentile(rms, 10)), 0, 1)
def glow(sel, t0, t1):
    return '\n    '.join(f'tl.to("{sel}", {{ opacity: {0.35 + 0.5 * rms[k]:.2f}, duration: 0.06, ease: "none" }}, {k / 15 - t0:.3f});'
                           for k in range(int(t0 * 15) + 1, min(int(t1 * 15), len(rms))))

FONTS = ''.join(
    f"@font-face {{ font-family: '{fam}'; font-weight: {w}; src: url('assets/fonts/{f}') format('woff2'); }}\n    "
    for fam, w, f in [('Changa', 700, 'changa-arabic-700-normal.woff2'), ('Changa', 800, 'changa-arabic-800-normal.woff2'),
                      ('Almarai', 700, 'almarai-arabic-700-normal.woff2'), ('Almarai', 800, 'almarai-arabic-800-normal.woff2'),
                      ('TM Inter', 700, 'inter-latin-700-normal.woff2'), ('TM Inter', 800, 'inter-latin-800-normal.woff2')])
BASE = FONTS + """#root { position: absolute; inset: 0; overflow: hidden; background: #070B14; color: #F1F4FB; font-family: 'TM Inter', 'Almarai', sans-serif; }
    .media { position: absolute; inset: 0; }
    .media img, .media video { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; object-fit: cover; }
    .scrim { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(7,11,20,.5) 0%, rgba(7,11,20,0) 20%, rgba(7,11,20,0) 52%, rgba(7,11,20,.92) 100%); }
    .flash { position: absolute; inset: 0; background: #F1F4FB; opacity: 0; }
    .words { position: absolute; direction: rtl; }
    .display { font-family: 'Changa', 'TM Inter', sans-serif; font-weight: 800; line-height: 1.15; text-shadow: 0 4px 30px rgba(0,0,0,.75); }
    .sub { font-family: 'TM Inter', 'Almarai', sans-serif; font-weight: 700; text-shadow: 0 2px 16px rgba(0,0,0,.85); }
    .chip { display: inline-flex; align-items: center; gap: 12px; font-weight: 800; font-size: 40px; color: #F5B43C; border: 2px solid rgba(245,180,60,.55); background: rgba(7,11,20,.8); border-radius: 999px; padding: 10px 28px; }
    .place { display: inline-flex; align-items: center; gap: 14px; font-weight: 800; font-size: 44px; color: #F1F4FB; background: rgba(7,11,20,.8); border: 2px solid #33415C; border-radius: 999px; padding: 12px 30px; white-space: nowrap; }
    .place i { width: 16px; height: 16px; border-radius: 50%; background: #D9F000; display: inline-block; }
    .chip svg, .crown { fill: #F5B43C; }
    .mark { position: absolute; top: 108px; left: 192px; font-family: 'TM Inter', sans-serif; font-weight: 800; font-size: 44px; letter-spacing: .02em; text-shadow: 0 2px 16px rgba(0,0,0,.8); }
    .mark b { color: #4A92F2; font-weight: 800; }
    .navy { position: absolute; inset: 0; background: radial-gradient(90% 90% at 50% 45%, #1a2d57 0%, #0B1120 60%, #070B14 100%); }"""
CROWN = '<path d="M3.2 7.6l4.6 3.6 3.4-5.7a.95.95 0 0 1 1.6 0l3.4 5.7 4.6-3.6a.6.6 0 0 1 .96.58L19.9 17H4.1L2.24 8.18a.6.6 0 0 1 .96-.58z"/><path d="M4.4 18.6h15.2V20a1 1 0 0 1-1 1H5.4a1 1 0 0 1-1-1z"/>'
def crown(px): return f'<svg class="crown" width="{px}" height="{px}" viewBox="0 0 24 24">{CROWN}</svg>'
def chip(id_): return f'<div><span id="{id_}" class="chip">{crown(40)}برو</span></div>'
RISE = lambda sel, at, y=36: f'tl.fromTo("{sel}", {{ y: {y}, opacity: 0 }}, {{ y: 0, opacity: 1, duration: 0.36, ease: "power3.out" }}, {at});'
FLASH = lambda name: f'tl.fromTo("#{name}-flash", {{ opacity: 0.55 }}, {{ opacity: 0, duration: 0.22, ease: "power2.out" }}, 0);'
def settle(sel, d, s0=1.0, drift=0.05, x=0, y=0):
    return (f'tl.fromTo("{sel}", {{ scale: {s0 + 0.06:.3f}, x: {x}, y: {y} }}, {{ scale: {s0:.3f}, x: {x}, y: {y}, duration: 0.3, ease: "power3.out" }}, 0);\n    '
            f'tl.to("{sel}", {{ scale: {s0 + drift:.3f}, duration: {d - 0.32:.2f}, ease: "none" }}, 0.3);')
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
clip = lambda id_, d, cls='': f'id="{id_}" class="clip{(" " + cls) if cls else ""}" data-start="0" data-duration="{d}"'
dur = dict(zip(NAMES, D))
def video(name, d, src): return f'<div id="{name}-media" class="media" data-layout-allow-overflow><video {clip(name + "-v", d)} data-track-index="1" muted playsinline src="assets/{src}"></video></div>'
def image(name, d, src): return f'<div id="{name}-media" class="media" data-layout-allow-overflow><img {clip(name + "-img", d)} data-track-index="1" src="assets/{src}" alt=""></div>'
flash = lambda name: f'<div id="{name}-flash" class="flash"></div>'

MAKER = lambda id_, handle: f'<span id="{id_}" class="place" style="direction: ltr;"><i></i>@{handle}</span>'
# 1. Cold open: a fan's tifo goes up round the whole of Camp Nou.
d = dur['barca']
scene('barca', d, f"""    {video('barca', d, 'barca.mp4')}
    <div class="scrim"></div>
    <div class="mark">TIFO<b>MAKER</b></div>
    <div {clip('barca-by', d, 'words')} data-track-index="2" style="right: 192px; top: 108px;">{MAKER('barca-chip', 'hmatadl13')}</div>
    <div {clip('barca-words', d, 'words display')} data-track-index="3" style="right: 192px; left: 192px; bottom: 118px; font-size: 118px;">
      <div id="barca-l1">هذا التيفو صمّمه مشجّع</div>
    </div>""", RISE('#barca-l1', 0.25) + '\n    ' + RISE('#barca-chip', 1.84, 20) + '  // beat-grid: 1.83s')

# 2-4. Three more, by three more fans, one cut a bar.
for name, src, handle in [('ahli', 'ahli.mp4', 'FahadI'), ('mtu', 'mtu.mp4', 'aungpaocharoenki'), ('qassim', 'qassim.mp4', 'z_7xz')]:
    d = dur[name]
    scene(name, d, f"""    {video(name, d, src)}
    {flash(name)}
    <div {clip(name + '-words', d, 'words')} data-track-index="2" style="right: 192px; bottom: 112px;">{MAKER(name + '-place', handle)}</div>""",
          FLASH(name) + '\n    ' + RISE(f'#{name}-place', 0.12, 20))

# 5. What the site is, over a closer look at the first one.
d = dur['title']
scene('title', d, f"""    {video('title', d, 'barca-close.mp4')}
    {flash('title')}
    <div class="scrim"></div>
    <div {clip('title-words', d, 'words display')} data-track-index="3" style="right: 192px; left: 192px; bottom: 118px; font-size: 98px; display: flex; gap: 30px; white-space: nowrap;">
      <div id="title-l1">صمّم تيفو ناديك</div><div id="title-l2" style="color: #7FB0FF;">وشوفه في ملعبه</div>
    </div>""", FLASH('title') + '\n    ' + RISE('#title-l1', 0.2) + '\n    ' + RISE('#title-l2', 0.93) + '  // beat-grid: 10.15s')

# 6. The name, and that it is free.
d = dur['brand']
scene('brand', d, f"""    <div class="navy"></div>
    <div {clip('brand-words', d, 'words')} data-track-index="1" style="inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; direction: ltr;">
      <div id="brand-mark" style="font-family: 'TM Inter', sans-serif; font-weight: 800; font-size: 210px; letter-spacing: .02em; line-height: 1;">TIFO<span style="color: #4A92F2;">MAKER</span></div>
      <div id="brand-free" class="display" style="direction: rtl; font-size: 100px; margin-top: 34px; text-shadow: none;">مجاناً. <span style="color: #3FC77F;">ودايم مجاناً.</span></div>
    </div>""", 'tl.fromTo("#brand-mark", { scale: 1.25, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: "power3.out" }, 0);\n    ' + RISE('#brand-free', 0.42))

# 7. Pro is open.
d = dur['pro']
scene('pro', d, f"""    <div class="navy"></div>
    <div id="pro-glow" style="position: absolute; left: 610px; top: 190px; width: 700px; height: 700px; border-radius: 50%; background: radial-gradient(circle, rgba(245,180,60,.34) 0%, rgba(245,180,60,0) 65%); opacity: .4;"></div>
    <div {clip('pro-words', d, 'words')} data-track-index="1" style="inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;">
      <div style="display: flex; align-items: center; gap: 40px;">
        <div id="pro-word" class="display" style="font-size: 330px; line-height: 1; color: #F5B43C;">برو</div>
        <div id="pro-crown">{crown(300)}</div>
      </div>
      <div id="pro-sub" class="sub" style="font-size: 76px; font-weight: 800; margin-top: 30px;">فتحت. إضافات للي يبي أكثر</div>
    </div>""",
      'tl.fromTo("#pro-word", { scale: 0.7, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.36, ease: "back.out(1.7)" }, 0);\n    '
      'tl.fromTo("#pro-crown", { scale: 0, rotation: -25 }, { scale: 1, rotation: 0, duration: 0.45, ease: "back.out(1.7)" }, 0.1);\n    '
      + RISE('#pro-sub', 0.2) + '\n    ' + glow('#pro-glow', T['pro'], T['film']))

def perk(name, media, title, sub, js, words_style='right: 192px; left: 192px; bottom: 118px;', size=128, scrim='<div class="scrim"></div>'):
    d = dur[name]
    scene(name, d, f"""    {media}
    {flash(name)}
    {scrim}
    <div {clip(name + '-words', d, 'words')} data-track-index="3" style="{words_style}">
      {chip(name + '-chip')}
      <div id="{name}-title" class="display" style="font-size: {size}px; margin-top: 12px;">{title}</div>
      {f'<div id="{name}-sub" class="sub" style="font-size: 52px;">{sub}</div>' if sub else ''}
    </div>""", FLASH(name) + '\n    ' + js + '\n    ' + RISE(f'#{name}-chip', 0.05) + '\n    ' + RISE(f'#{name}-title', 0.1) + ('\n    ' + RISE(f'#{name}-sub', 0.2) if sub else ''))

perk('film', image('film', dur['film'], 'hold.jpg'), 'فيلم يوم المباراة', 'Full HD وطولي 9:16', settle('#film-media', dur['film'], 1.02, 0.07))
perk('poster', image('poster', dur['poster'], 'poster.jpg'), 'بوستر 4K', 'عرضي أو طولي', settle('#poster-media', dur['poster']),
     words_style='left: 192px; width: 780px; bottom: 130px;', size=150,
     scrim='<div style="position: absolute; inset: 0; background: linear-gradient(90deg, rgba(7,11,20,.94) 0%, rgba(7,11,20,.7) 40%, rgba(7,11,20,0) 64%);"></div>')
# The mark, then the fan's own credit, on the same frame.
d = dur['credit']
scene('credit', d, f"""    <div id="credit-media" class="media" data-layout-allow-overflow>
      <img {clip('credit-free', d)} data-track-index="1" src="assets/credit-free.jpg" alt="">
      <img id="credit-pro" class="clip" data-start="0" data-duration="{d}" data-track-index="2" src="assets/credit-pro.jpg" alt="" style="opacity: 0;">
    </div>
    {flash('credit')}
    <div style="position: absolute; inset: 0; background: linear-gradient(0deg, rgba(7,11,20,0) 0%, rgba(7,11,20,0) 13%, rgba(7,11,20,.82) 26%, rgba(7,11,20,.82) 44%, rgba(7,11,20,.15) 64%, rgba(7,11,20,.6) 100%);"></div>
    <div {clip('credit-words', d, 'words')} data-track-index="4" style="left: 192px; width: 1150px; bottom: 250px;">
      <div id="credit-title" class="display" style="font-size: 120px;">بدون علامة الموقع</div>
      <div id="credit-sub" class="sub" style="font-size: 60px; font-weight: 800; color: #F5B43C;">واسمك مكانها</div>
    </div>""",
      FLASH('credit') + '\n    tl.set("#credit-media", { scale: 1.5, x: -480, y: -270 }, 0);\n    '
      'tl.to("#credit-pro", { opacity: 1, duration: 0.18, ease: "none" }, 0.92);  // beat-grid: 21.24s\n    '
      + RISE('#credit-title', 0.1) + '\n    ' + RISE('#credit-sub', 0.95))
perk('more', image('more', dur['more'], 'led-panel.jpg'), 'وهوية ناديك، وخطوطه، وشاشات ملعبه', '', settle('#more-media', dur['more'], 1.9, 0.1, 330, -330),
     words_style='right: 192px; left: 192px; top: 108px;', size=96,
     scrim='<div style="position: absolute; inset: 0; background: linear-gradient(180deg, rgba(7,11,20,.92) 0%, rgba(7,11,20,.55) 40%, rgba(7,11,20,0) 58%);"></div>')

# The price, on the track's last hit.
d = dur['price']
scene('price', d, f"""    <div class="navy"></div>
    <div id="price-glow" style="position: absolute; left: 460px; top: 300px; width: 1000px; height: 560px; border-radius: 50%; background: radial-gradient(closest-side, rgba(245,180,60,.3) 0%, rgba(245,180,60,0) 100%); opacity: .4;"></div>
    <div class="mark">TIFO<b>MAKER</b></div>
    <div {clip('price-words', d, 'words')} data-track-index="1" style="inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;">
      <div id="price-box" style="display: flex; align-items: center; gap: 44px; border: 2px solid rgba(245,180,60,.55); background: #1c1a17; border-radius: 40px; padding: 40px 72px;">
        {crown(150)}
        <div style="text-align: right;">
          <div class="sub" style="font-size: 50px; font-weight: 800; color: #F1F4FB; text-shadow: none;">سعر الإطلاق <span style="color: #A6B0C8; text-decoration: line-through; direction: ltr; unicode-bidi: isolate;">19.99</span></div>
          <div class="display" style="font-size: 132px; line-height: 1.1; color: #F5B43C; text-shadow: none;"><span style="direction: ltr; unicode-bidi: isolate;">13.99</span> ريال للشهر</div>
        </div>
      </div>
      <div id="price-url" style="font-family: 'TM Inter', sans-serif; font-weight: 800; font-size: 76px; direction: ltr; margin-top: 44px;">tifomaker.org/pro</div>
      <div id="price-free" class="sub" style="font-size: 46px; color: #A6B0C8; margin-top: 18px; text-shadow: none;">وتصميم التيفو <span style="color: #3FC77F; font-weight: 800;">مجاني، وبيظل مجاني</span></div>
    </div>""",
      'tl.fromTo("#price-box", { scale: 0.86, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.36, ease: "back.out(1.5)" }, 0.04);  // beat-locked: 23.99s\n    '
      + RISE('#price-url', 0.5) + '\n    ' + RISE('#price-free', 0.95) + '\n    ' + glow('#price-glow', T['price'], T['end'] - 0.2))

hosts = '\n'.join(
    f'      <div id="{n}" data-composition-id="{n}" data-composition-src="compositions/{n}.html" data-start="{START[i]}" data-duration="{D[i]}" data-track-index="1" data-track-kind="graphics" data-width="1920" data-height="1080"></div>'
    for i, n in enumerate(NAMES))
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
    <!-- Tifo Maker Pro launch video (v3): tifos published by fans on the site. Every cut is on a beat of the music. -->
    <div id="root" data-composition-id="main" data-start="0" data-duration="{T['end']}" data-width="1920" data-height="1080">
{hosts}
      <audio id="music" class="clip" data-start="0" data-duration="{T['end']}" data-track-index="2" data-volume="0.95" src="{MUSIC}"></audio>
    </div>
    <script>
      window.__timelines["main"] = gsap.timeline({{ paused: true }});
    </script>
  </body>
</html>
""", encoding='utf-8')
print('written', dict(zip(NAMES, D)), sum(D))
