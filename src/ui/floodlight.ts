/*
 * Floodlight — Tifo Maker design system.
 *
 * One idea: the canvas is lit, everything else is the unlit concourse. The ink
 * ramp is a compressed 4-step dark so panels recede; the contrast budget is
 * spent only on text and two accents. Accent division is strict and enforced
 * by the glow rule: terracotta ACTS (tools, primary actions, active state),
 * violet SELECTS (focus, presence, viewport). Danger never glows; accents
 * always do.
 *
 * Injected at runtime by theme.ts so the design tokens live in one TS module
 * the rest of the app can import from, while the CSS stays declarative.
 */

export const FLOODLIGHT_TOKENS = {
  ink0: '#0B1120',
  ink1: '#0F172A',
  ink2: '#161E31',
  ink3: '#1E2942',
  canvasPit: '#070B14',
  line1: '#243049',
  line2: '#33415C',
  text1: '#F1F4FB',
  text2: '#A6B0C8',
  text3: '#6B7793',
  flare: '#1C6FE0',
  flareHover: '#3B86EE',
  flarePress: '#155EC4',
  flareInk: '#FFFFFF',
  violet: '#8B7CFF',
  violetPress: '#5B4CCF',
  violetInk: '#FFFFFF',
  ok: '#0FBF6B',
  warn: '#F5B43C',
  danger: '#F0455A',
} as const;

/*
 * The design system's CSS now lives in ./floodlight.css.
 *
 * It used to be a template literal exported from here and injected into a
 * <style> tag at runtime, which meant the browser painted the editor with the
 * user-agent defaults first and restyled it once 1.3MB of JavaScript had
 * downloaded and run. Every element on the page moved at that point: a measured
 * cumulative layout shift of 1.171, where 0.25 is already "poor", and in an
 * editor a shift moves the canvas under a pointer that is already travelling.
 * As a real .css file Vite emits a <link> the browser applies before first
 * paint, and the shift disappears.
 */

