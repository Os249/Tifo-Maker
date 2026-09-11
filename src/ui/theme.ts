import './floodlight.css';

/**
 * Installs the Floodlight design system.
 *
 * The stylesheet is a static import so Vite emits it as a <link> in the built
 * HTML, applied before first paint. It used to be injected into a <style> tag
 * here at runtime, which produced a flash of unstyled content and a layout
 * shift of 1.171 as the whole page re-laid-out around it.
 *
 * The webfonts are declared in index.html for the same reason; nothing is
 * appended to <head> from JavaScript any more.
 */
export function installTheme(): void {
  /* Kept as a no-op so the call sites, which run before the editor mounts,
     do not all need touching; the import above does the work. */
}
