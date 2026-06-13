import { FLOODLIGHT_CSS } from './floodlight';

/**
 * Installs the Floodlight design system: injects the token stylesheet and
 * pulls Inter + JetBrains Mono. Called once before the editor mounts. Kept
 * separate from index.html so the design tokens live in TS the rest of the
 * app imports from, while markup stays declarative.
 */
export function installTheme(): void {
  const fonts = document.createElement('link');
  fonts.rel = 'stylesheet';
  fonts.href =
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=JetBrains+Mono:wght@400;500&display=swap';
  document.head.appendChild(fonts);


  const style = document.createElement('style');
  style.textContent = FLOODLIGHT_CSS;
  document.head.appendChild(style);
}
