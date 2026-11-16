/**
 * "What Pro adds": the video for the Pro announcement tweet (4:5, 30 s).
 *
 * Every picture in the window is the product's own output, made by the site's
 * code (the Match Day film, the 4K posters, the LED boards in Match Day, a Pro
 * font on the seats, the mark and the credit line). This file adds the
 * frame, the captions and the cuts. See ../README.md for where each came from.
 */
import React from 'react';
import { AbsoluteFill, Easing, Img, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { Audio, Video } from '@remotion/media';
import { C, CROWN_PATHS, DISPLAY, SCARF, UI, fontsReady } from './theme';

void fontsReady;

const FPS = 30;
const s = (sec: number) => Math.round(sec * FPS);

/** The scenes, in order: how long each holds the window. */
const SCENES = [
  { id: 'film', dur: s(9), n: 1, title: 'فيلم يوم المباراة', sub: 'بجودة Full HD، وبنسخة طولية 9:16' },
  { id: 'poster', dur: s(4), n: 2, title: 'بوستر 4K', sub: 'عرضي أو طولي، بالعربي أو الإنجليزي' },
  { id: 'credit', dur: s(3.5), n: 3, title: 'بدون علامة الموقع', sub: 'واسمك أو اسم رابطتك على التصدير' },
  { id: 'kit', dur: s(3), n: 4, title: 'هوية ناديك', sub: 'ألوانه وشعاره على البوستر والشاشات' },
  { id: 'fonts', dur: s(3), n: 5, title: 'خطوط مميّزة', sub: 'عربية وإنجليزية، تنقري من آخر الملعب' },
  { id: 'led', dur: s(3.5), n: 6, title: 'كلامك على شاشات الملعب', sub: 'هتاف، نتيجة، عدّ تنازلي' },
] as const;
const END = s(4);
const BODY = SCENES.reduce((a, x) => a + x.dur, 0);
export const TEASER_FRAMES = BODY + END;

const WIN = { x: 40, y: 128, w: 1000, h: 562 };
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const out = Easing.bezier(0.22, 1, 0.36, 1);

const Crown: React.FC<{ size: number; color?: string }> = ({ size, color = C.gold }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
    {CROWN_PATHS.map((d) => <path key={d} d={d} />)}
  </svg>
);

/** A still that drifts: a slow push from one scale and offset to another. */
const Drift: React.FC<{ src: string; from?: number; to?: number; x?: [number, number]; y?: [number, number]; fit?: 'cover' | 'contain' }> = ({
  src, from = 1, to = 1.08, x = [0, 0], y = [0, 0], fit = 'cover',
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  return (
    <Img
      src={staticFile(src)}
      style={{
        width: '100%', height: '100%', objectFit: fit,
        scale: interpolate(frame, [0, durationInFrames], [from, to], clamp),
        translate: interpolate(frame, [0, durationInFrames], [`${x[0]}px ${y[0]}px`, `${x[1]}px ${y[1]}px`], clamp),
      }}
    />
  );
};

/** A second picture that takes the window over part-way through a scene. */
const CutIn: React.FC<{ at: number; children: React.ReactNode }> = ({ at, children }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: interpolate(frame, [at, at + 8], [0, 1], clamp) }}>{children}</AbsoluteFill>
  );
};

/** A small label inside the window: which plan a picture is. */
const Tag: React.FC<{ text: string; pro?: boolean; side?: 'right' | 'left' }> = ({ text, pro, side = 'right' }) => (
  <div
    dir="rtl"
    style={{
      position: 'absolute', top: 20, [side]: 20, display: 'flex', alignItems: 'center', gap: 8,
      fontFamily: UI, fontWeight: 800, fontSize: 26, padding: '8px 18px', borderRadius: 999,
      background: 'rgba(7, 11, 20, 0.78)', color: pro ? C.gold : C.snow,
      border: `1.5px solid ${pro ? C.goldLine : C.night500}`,
    }}
  >
    {pro ? <Crown size={26} /> : null}
    {text}
  </div>
);

const Film: React.FC = () => (
  <Video src={staticFile('film.mp4')} muted trimBefore={s(3.3)} style={{ width: '100%', height: '100%', objectFit: 'cover', scale: 1.3, translate: '0px 40px' }} />
);

const Poster: React.FC = () => (
  <>
    <Drift src="poster-land-ar.jpg" from={1} to={1.1} />
    <CutIn at={s(2)}>
      <AbsoluteFill style={{ background: C.night950, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 28 }}>
        {['poster-port-ar.jpg', 'poster-port-en.jpg'].map((p) => (
          <Img key={p} src={staticFile(p)} style={{ height: 530, borderRadius: 10, boxShadow: '0 10px 40px rgba(0,0,0,.6)' }} />
        ))}
      </AbsoluteFill>
    </CutIn>
  </>
);

const Credit: React.FC = () => (
  <>
    <Drift src="credit-free.jpg" from={1.6} to={1.6} x={[-300, -300]} y={[-169, -169]} />
    <Tag text="المجانية" />
    <CutIn at={s(1.5)}>
      <Drift src="credit-pro.jpg" from={1.6} to={1.6} x={[-300, -300]} y={[-169, -169]} />
      <Tag text="برو" pro />
    </CutIn>
  </>
);

const Kit: React.FC = () => (
  <>
    <Drift src="poster-min-ar.jpg" from={1.02} to={1.1} />
    <CutIn at={s(1.5)}>
      <Drift src="led-big.jpg" from={1.5} to={1.7} y={[-120, -150]} />
    </CutIn>
  </>
);

const Fonts: React.FC = () => (
  <>
    <Drift src="font-stencil.jpg" from={1.25} to={1.4} y={[40, 50]} />
    <CutIn at={s(1.5)}>
      <Drift src="font-block.jpg" from={1.35} to={1.5} y={[60, 70]} />
    </CutIn>
  </>
);

const Led: React.FC = () => (
  <>
    <Drift src="led-panel.jpg" from={1} to={1} />
    <CutIn at={s(1.4)}>
      <Drift src="led-panel.jpg" from={2.3} to={2.6} x={[230, 260]} y={[-267, -302]} />
    </CutIn>
  </>
);

const MEDIA: Record<(typeof SCENES)[number]['id'], React.FC> = { film: Film, poster: Poster, credit: Credit, kit: Kit, fonts: Fonts, led: Led };

/** The words under the window: the perk's number, its name and one line about it. */
const Caption: React.FC<{ n: number; title: string; sub: string }> = ({ n, title, sub }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const leave = interpolate(frame, [durationInFrames - 6, durationInFrames], [1, 0], clamp);
  return (
    <div dir="rtl" lang="ar" style={{ position: 'absolute', left: 56, right: 56, top: 760, opacity: leave }}>
      <div
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 10, fontFamily: UI, fontWeight: 800, fontSize: 30, color: C.gold,
          border: `1.5px solid ${C.goldLine}`, background: C.goldTint, borderRadius: 999, padding: '8px 22px',
          opacity: interpolate(frame, [0, 8], [0, 1], clamp),
        }}
      >
        <Crown size={30} />
        <span>برو</span>
        <span style={{ color: C.mist }}>{n}</span>
      </div>
      <div
        style={{
          fontFamily: DISPLAY, fontWeight: 800, fontSize: 96, lineHeight: 1.15, color: C.snow, marginTop: 26,
          opacity: interpolate(frame, [3, 13], [0, 1], clamp),
          translate: interpolate(frame, [3, 16], ['0px 26px', '0px 0px'], { ...clamp, easing: out }),
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontFamily: UI, fontWeight: 700, fontSize: 46, lineHeight: 1.4, color: C.mist, marginTop: 16,
          opacity: interpolate(frame, [9, 20], [0, 1], clamp),
          translate: interpolate(frame, [9, 22], ['0px 20px', '0px 0px'], { ...clamp, easing: out }),
        }}
      >
        {sub}
      </div>
    </div>
  );
};

const Frame: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill
    style={{
      background: `radial-gradient(120% 70% at 50% 0%, #16264a 0%, ${C.night900} 55%, ${C.night950} 100%)`,
      fontFamily: UI, color: C.snow,
    }}
  >
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 12, background: SCARF }} />
    <div style={{ position: 'absolute', top: 44, left: 56, fontFamily: 'Inter', fontWeight: 800, fontSize: 34, letterSpacing: '0.02em' }}>
      TIFO<span style={{ color: C.maker }}>MAKER</span>
    </div>
    <div
      dir="rtl"
      style={{
        position: 'absolute', top: 36, right: 56, display: 'flex', alignItems: 'center', gap: 10, fontWeight: 800, fontSize: 28,
        color: C.gold, border: `1.5px solid ${C.goldLine}`, background: C.goldTint, borderRadius: 999, padding: '8px 22px',
      }}
    >
      <Crown size={30} />
      وش يضيف برو؟
    </div>
    {children}
  </AbsoluteFill>
);

/** The promise, on every frame of the body: free stays free. */
const Promise_: React.FC = () => (
  <div
    dir="rtl"
    style={{
      position: 'absolute', left: 56, right: 56, bottom: 54, display: 'flex', alignItems: 'center', gap: 16,
      fontWeight: 700, fontSize: 34, color: C.mist, borderTop: `1.5px solid ${C.night500}`, paddingTop: 26,
    }}
  >
    <span style={{ color: C.green, fontWeight: 800 }}>تصميم التيفو مجاني، وبيظل مجاني.</span>
    <span>برو إضافات.</span>
  </div>
);

const Dots: React.FC<{ active: number }> = ({ active }) => (
  <div style={{ position: 'absolute', top: 708, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 10, direction: 'rtl' }}>
    {SCENES.map((x) => (
      <div key={x.id} style={{ width: x.n === active ? 44 : 14, height: 8, borderRadius: 8, background: x.n === active ? C.gold : C.night500 }} />
    ))}
  </div>
);

const EndCard: React.FC = () => {
  const frame = useCurrentFrame();
  const rise = (from: number) => ({
    opacity: interpolate(frame, [from, from + 10], [0, 1], clamp),
    translate: interpolate(frame, [from, from + 14], ['0px 28px', '0px 0px'], { ...clamp, easing: out }),
  });
  return (
    <AbsoluteFill dir="rtl" lang="ar" style={{ justifyContent: 'center', alignItems: 'center', padding: '0 70px', textAlign: 'center' }}>
      <div style={{ ...rise(0), fontFamily: DISPLAY, fontWeight: 800, fontSize: 104, lineHeight: 1.15 }}>
        تصميم التيفو <span style={{ color: C.green }}>مجاني</span>،<br />وبيظل مجاني
      </div>
      <div style={{ ...rise(8), fontWeight: 700, fontSize: 46, color: C.mist, marginTop: 26 }}>
        <span style={{ color: C.gold }}>برو</span> إضافات للي يبي أكثر
      </div>
      <div style={{ ...rise(12), fontWeight: 700, fontSize: 36, color: C.mist, marginTop: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
        ومعها تاج الداعم <Crown size={38} /> جنب اسمك
      </div>
      <div
        style={{
          ...rise(18), marginTop: 70, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
          border: `1.5px solid ${C.goldLine}`, background: C.goldTint, borderRadius: 28, padding: '34px 54px',
        }}
      >
        <div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 64, color: C.gold }}>كم يستاهل شهر برو؟</div>
        <div style={{ fontWeight: 700, fontSize: 38, color: C.snow }}>السعر أنتم اللي تحددونه</div>
        <div style={{ fontFamily: 'Inter', fontWeight: 800, fontSize: 44, direction: 'ltr' }}>tifomaker.org/pro</div>
      </div>
    </AbsoluteFill>
  );
};

/** The music (music/make_track.py): 120 BPM, so every cut above lands on a beat. */
const Sound: React.FC = () => <Audio src={staticFile('track.m4a')} />;

export const ProTeaser: React.FC = () => {
  let at = 0;
  return (
    <Frame>
      <Sound />
      {SCENES.map((sc) => {
        const from = at;
        at += sc.dur;
        const Media = MEDIA[sc.id];
        return (
          <Sequence key={sc.id} from={from} durationInFrames={sc.dur} name={sc.id}>
            <div
              style={{
                position: 'absolute', left: WIN.x, top: WIN.y, width: WIN.w, height: WIN.h, borderRadius: 22, overflow: 'hidden',
                background: C.night950, border: `1.5px solid ${C.night500}`,
              }}
            >
              <Media />
            </div>
            <Dots active={sc.n} />
            <Caption n={sc.n} title={sc.title} sub={sc.sub} />
            <Promise_ />
          </Sequence>
        );
      })}
      <Sequence from={BODY} durationInFrames={END} name="end">
        <EndCard />
      </Sequence>
    </Frame>
  );
};
