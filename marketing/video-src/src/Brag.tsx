/**
 * The /brag-slim cut (github.com/latent-spaces/brag): a 20.5 s landscape
 * launch video. Hook, reveal, five sharp highlights, outro; every cut sits on
 * a bar of the music (114.84 BPM, bars 2.1 s apart, first downbeat at 1.60 s).
 * The pictures are the product's own output (see ../README.md).
 */
import React from 'react';
import { AbsoluteFill, Easing, Img, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { Audio, Video } from '@remotion/media';
import { C, CROWN_PATHS, DISPLAY, UI, fontsReady } from './theme';

void fontsReady;

/** The bars of the track, in frames at 30 fps: where the cuts are. */
const CUT = { pro: 111, film: 174, poster: 237, credit: 300, fonts: 364, led: 427, outro: 490, end: 616 };
export const BRAG_FRAMES = CUT.end;

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const out = Easing.bezier(0.22, 1, 0.36, 1);

const Crown: React.FC<{ size: number; color?: string }> = ({ size, color = C.gold }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
    {CROWN_PATHS.map((d) => <path key={d} d={d} />)}
  </svg>
);

/** Full-bleed picture: lands with a small settle on the cut, then drifts in. */
const Shot: React.FC<{ children: React.ReactNode; drift?: number; origin?: string }> = ({ children, drift = 0.06, origin = '50% 50%' }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  return (
    <AbsoluteFill
      style={{
        transformOrigin: origin,
        scale:
          interpolate(frame, [0, 10], [1.07, 1], { ...clamp, easing: out }) +
          interpolate(frame, [0, durationInFrames], [0, drift], clamp),
      }}
    >
      {children}
    </AbsoluteFill>
  );
};
const fill: React.CSSProperties = { width: '100%', height: '100%', objectFit: 'cover' };

/** The dark wash the words sit on, at the bottom of a picture. */
const Scrim: React.FC = () => (
  <AbsoluteFill style={{ background: 'linear-gradient(180deg, rgba(7,11,20,0.55) 0%, rgba(7,11,20,0) 22%, rgba(7,11,20,0) 48%, rgba(7,11,20,0.92) 100%)' }} />
);

const Wordmark: React.FC = () => (
  <div style={{ position: 'absolute', top: 54, left: 72, fontFamily: 'Inter', fontWeight: 800, fontSize: 44, letterSpacing: '0.02em', color: C.snow }}>
    TIFO<span style={{ color: C.maker }}>MAKER</span>
  </div>
);

/** A line that rises in at `at` and stays. */
const Rise: React.FC<{ at: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ at, children, style }) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        ...style,
        opacity: interpolate(frame, [at, at + 7], [0, 1], clamp),
        translate: interpolate(frame, [at, at + 12], ['0px 36px', '0px 0px'], { ...clamp, easing: out }),
      }}
    >
      {children}
    </div>
  );
};

/** A Pro perk's words, bottom right: the crown chip, its name, one line. */
const Perk: React.FC<{ title: string; sub: string }> = ({ title, sub }) => (
  <div dir="rtl" lang="ar" style={{ position: 'absolute', right: 96, left: 96, bottom: 84 }}>
    <Rise at={2} style={{ display: 'inline-flex', alignItems: 'center', gap: 12, fontFamily: UI, fontWeight: 800, fontSize: 40, color: C.gold, border: `2px solid ${C.goldLine}`, background: 'rgba(7,11,20,0.7)', borderRadius: 999, padding: '10px 28px' }}>
      <Crown size={40} />
      برو
    </Rise>
    <Rise at={4} style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 132, lineHeight: 1.15, color: C.snow, marginTop: 14, textShadow: '0 4px 30px rgba(0,0,0,.6)' }}>
      {title}
    </Rise>
    <Rise at={8} style={{ fontFamily: UI, fontWeight: 700, fontSize: 54, color: C.snow, opacity: 0.9, marginTop: 4, textShadow: '0 2px 16px rgba(0,0,0,.7)' }}>
      {sub}
    </Rise>
  </div>
);

const Tag: React.FC<{ text: string; pro?: boolean }> = ({ text, pro }) => (
  <div dir="rtl" style={{ position: 'absolute', top: 54, right: 72, display: 'flex', alignItems: 'center', gap: 10, fontFamily: UI, fontWeight: 800, fontSize: 40, padding: '10px 28px', borderRadius: 999, background: 'rgba(7,11,20,0.8)', color: pro ? C.gold : C.snow, border: `2px solid ${pro ? C.goldLine : C.night500}` }}>
    {pro ? <Crown size={38} /> : null}
    {text}
  </div>
);

// ------------------------------------------------------------------ scenes ---

/** Hook: the stand raises the tifo, and the two lines say what the site is. */
const Hook: React.FC = () => (
  <>
    <Shot drift={0.1} origin="50% 40%">
      <Video src={staticFile('film.mp4')} muted trimBefore={144} style={{ ...fill, scale: 1.18, translate: '0px 0px' }} />
    </Shot>
    <Scrim />
    <Wordmark />
    <div dir="rtl" lang="ar" style={{ position: 'absolute', right: 96, left: 96, bottom: 56, fontFamily: DISPLAY, fontWeight: 800, color: C.snow, lineHeight: 1.12, textShadow: '0 4px 30px rgba(0,0,0,.8)', display: 'flex', gap: 34, alignItems: 'baseline', whiteSpace: 'nowrap' }}>
      <Rise at={4} style={{ fontSize: 112 }}>صمّم تيفو ناديك</Rise>
      <Rise at={48} style={{ fontSize: 112, color: C.maker }}>وشوفه في ملعبه</Rise>
    </div>
  </>
);

/** Reveal: Pro. */
const ProReveal: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: `radial-gradient(90% 90% at 50% 45%, #1a2d57 0%, ${C.night900} 60%, ${C.night950} 100%)`, justifyContent: 'center', alignItems: 'center' }}>
      <div dir="rtl" lang="ar" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 40 }}>
          <div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 330, lineHeight: 1, color: C.gold, scale: interpolate(frame, [0, 12], [0.7, 1], { ...clamp, easing: Easing.bezier(0.34, 1.36, 0.64, 1) }), opacity: interpolate(frame, [0, 5], [0, 1], clamp) }}>
            برو
          </div>
          <div style={{ scale: interpolate(frame, [4, 18], [0, 1], { ...clamp, easing: Easing.bezier(0.34, 1.36, 0.64, 1) }), rotate: interpolate(frame, [4, 18], ['-25deg', '0deg'], { ...clamp, easing: out }) }}>
            <Crown size={300} />
          </div>
        </div>
        <Rise at={14} style={{ fontFamily: UI, fontWeight: 800, fontSize: 76, color: C.snow, marginTop: 30 }}>
          قريب… إضافات للي يبي أكثر
        </Rise>
      </div>
      <Wordmark />
    </AbsoluteFill>
  );
};

const Film: React.FC = () => (
  <>
    <Shot origin="50% 40%">
      <Video src={staticFile('film.mp4')} muted trimBefore={276} style={{ ...fill, scale: 1.2, translate: '0px -10px' }} />
    </Shot>
    <Scrim />
    <Perk title="فيلم يوم المباراة" sub="بجودة Full HD، وبنسخة طولية 9:16" />
  </>
);

const Poster: React.FC = () => (
  <>
    <Shot><Img src={staticFile('poster-land-ar.jpg')} style={fill} /></Shot>
    <AbsoluteFill style={{ background: 'linear-gradient(90deg, rgba(7,11,20,0.9) 0%, rgba(7,11,20,0.55) 38%, rgba(7,11,20,0) 62%)' }} />
    <div dir="rtl" lang="ar" style={{ position: 'absolute', left: 96, width: 760, bottom: 110, textAlign: 'right' }}>
      <Rise at={2} style={{ display: 'inline-flex', alignItems: 'center', gap: 12, fontFamily: UI, fontWeight: 800, fontSize: 40, color: C.gold, border: `2px solid ${C.goldLine}`, background: 'rgba(7,11,20,0.7)', borderRadius: 999, padding: '10px 28px' }}>
        <Crown size={40} />
        برو
      </Rise>
      <Rise at={4} style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 150, lineHeight: 1.15, color: C.snow, marginTop: 14 }}>بوستر 4K</Rise>
      <Rise at={8} style={{ fontFamily: UI, fontWeight: 700, fontSize: 52, color: C.snow, marginTop: 4 }}>عرضي أو طولي، عربي أو إنجليزي</Rise>
    </div>
  </>
);

/** The site's mark, then the fan's own credit, on the same frame. */
const Credit: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <>
      <AbsoluteFill style={{ scale: 1.5, translate: '-480px -270px' }}>
        <Img src={staticFile('credit-free.jpg')} style={fill} />
        <AbsoluteFill style={{ opacity: interpolate(frame, [28, 34], [0, 1], clamp) }}>
          <Img src={staticFile('credit-pro.jpg')} style={fill} />
        </AbsoluteFill>
      </AbsoluteFill>
      <AbsoluteFill style={{ background: 'linear-gradient(180deg, rgba(7,11,20,0.75) 0%, rgba(7,11,20,0) 40%)' }} />
      <AbsoluteFill style={{ opacity: interpolate(frame, [28, 30], [1, 0], clamp) }}><Tag text="المجانية" /></AbsoluteFill>
      <AbsoluteFill style={{ opacity: interpolate(frame, [30, 34], [0, 1], clamp) }}><Tag text="برو" pro /></AbsoluteFill>
      <div dir="rtl" lang="ar" style={{ position: 'absolute', left: 96, width: 1150, bottom: 150 }}>
        <Rise at={4} style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 120, lineHeight: 1.15, color: C.snow, textShadow: '0 4px 30px rgba(0,0,0,.7)' }}>بدون علامة الموقع</Rise>
        <Rise at={30} style={{ fontFamily: UI, fontWeight: 800, fontSize: 60, color: C.gold, textShadow: '0 2px 16px rgba(0,0,0,.8)' }}>واسمك أو اسم رابطتك مكانها</Rise>
      </div>
    </>
  );
};

const Fonts: React.FC = () => (
  <>
    <Shot origin="50% 35%"><Img src={staticFile('font-block.jpg')} style={{ ...fill, scale: 1.25, translate: '0px 90px' }} /></Shot>
    <Scrim />
    <Perk title="خطوط مميّزة" sub="عربية وإنجليزية، تنقري من آخر الملعب" />
  </>
);

const Led: React.FC = () => (
  <>
    <Shot drift={0.12} origin="38% 70%"><Img src={staticFile('led-panel.jpg')} style={{ ...fill, scale: 1.9, translate: '330px -330px' }} /></Shot>
    <AbsoluteFill style={{ background: 'linear-gradient(180deg, rgba(7,11,20,0.8) 0%, rgba(7,11,20,0.15) 45%, rgba(7,11,20,0) 60%)' }} />
    <div dir="rtl" lang="ar" style={{ position: 'absolute', right: 96, left: 96, top: 70 }}>
      <Rise at={2} style={{ display: 'inline-flex', alignItems: 'center', gap: 12, fontFamily: UI, fontWeight: 800, fontSize: 40, color: C.gold, border: `2px solid ${C.goldLine}`, background: 'rgba(7,11,20,0.7)', borderRadius: 999, padding: '10px 28px' }}>
        <Crown size={40} />
        برو
      </Rise>
      <Rise at={4} style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 120, lineHeight: 1.15, color: C.snow, marginTop: 10, textShadow: '0 4px 30px rgba(0,0,0,.7)' }}>كلامك على شاشات الملعب</Rise>
    </div>
  </>
);

/** Outro: the promise, then the question the tweet asks. */
const Outro: React.FC = () => (
  <AbsoluteFill dir="rtl" lang="ar" style={{ background: `radial-gradient(90% 90% at 50% 40%, #16264a 0%, ${C.night900} 60%, ${C.night950} 100%)`, justifyContent: 'center', alignItems: 'center', textAlign: 'center' }}>
    <Rise at={2} style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 136, lineHeight: 1.2, color: C.snow }}>
      تصميم التيفو <span style={{ color: C.green }}>مجاني</span>،<br />وبيظل مجاني
    </Rise>
    <Rise at={34} style={{ marginTop: 56, display: 'flex', alignItems: 'center', gap: 40, border: `2px solid ${C.goldLine}`, background: C.goldTint, borderRadius: 36, padding: '34px 64px' }}>
      <Crown size={110} />
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: 92, lineHeight: 1.1, color: C.gold }}>كم يستاهل شهر برو؟</div>
        <div style={{ fontFamily: 'Inter', fontWeight: 800, fontSize: 60, color: C.snow, direction: 'ltr', textAlign: 'right', marginTop: 8 }}>tifomaker.org/pro</div>
      </div>
    </Rise>
    <Wordmark />
  </AbsoluteFill>
);

/** One bed of music, a soft hit on the two big cuts, a softer tap on the rest. */
const Sound: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <>
      <Audio src={staticFile('brag/music.mp3')} volume={interpolate(frame, [0, BRAG_FRAMES - 36, BRAG_FRAMES], [0.9, 0.9, 0], clamp)} />
      {[CUT.pro, CUT.outro].map((f) => (
        <Sequence key={f} from={f} durationInFrames={30}><Audio src={staticFile('brag/hit.wav')} volume={0.5} /></Sequence>
      ))}
      {[CUT.film, CUT.poster, CUT.credit, CUT.fonts, CUT.led].map((f) => (
        <Sequence key={f} from={f} durationInFrames={15}><Audio src={staticFile('brag/tap.wav')} volume={0.28} /></Sequence>
      ))}
    </>
  );
};

const SCENES: [string, number, number, React.FC][] = [
  ['hook', 0, CUT.pro, Hook], ['pro', CUT.pro, CUT.film, ProReveal], ['film', CUT.film, CUT.poster, Film],
  ['poster', CUT.poster, CUT.credit, Poster], ['credit', CUT.credit, CUT.fonts, Credit], ['fonts', CUT.fonts, CUT.led, Fonts],
  ['led', CUT.led, CUT.outro, Led], ['outro', CUT.outro, CUT.end, Outro],
];

export const Brag: React.FC<{ poster?: boolean }> = ({ poster }) => (
  <AbsoluteFill style={{ background: C.night950, fontFamily: UI }}>
    <Sound />
    {SCENES.map(([name, from, to, Scene]) => (
      <Sequence key={name} from={from} durationInFrames={to - from} name={name}>
        <Scene />
      </Sequence>
    ))}
    {poster ? (
      <Sequence from={0} durationInFrames={1} name="poster frame">
        <Img src={staticFile('brag/poster.jpg')} style={fill} />
      </Sequence>
    ) : null}
  </AbsoluteFill>
);
