/**
 * Pro's tools in the editor, loaded only for an account Pro is on for.
 *
 * The editor's start carries none of this (it is at its string budget, and
 * most visitors never see Pro): toolbar.ts imports this module once /api/pro
 * says Pro is live, and each perk below mounts its own controls, with its own
 * words, into the panels that are already there.
 *
 *   proExport   the stadium video's Pro sizes (Match Day's film of the tifo,
 *               Full HD or vertical 9:16) and the 4K match-day poster;
 *   proStyles   portrait styles for a face or a player photo;
 *   proFonts    the Pro display fonts, for text and banners;
 *   clubKit     a club's colours, logos and font, saved once on the account
 *               and dropped into any project in one tap;
 *   proCredit   the fan's own credit line, in a corner of every export.
 *
 * Every one is free to try in the editor and the 3D view; what Pro decides is
 * what leaves the site, and that question is asked in one place (proGate.ts).
 * A perk that fails to load takes nothing else down with it.
 */
import type { DesignStore } from '../core/design';
import type { ObjectLayer } from '../core/objects';
import type { SeatMap } from '../core/types';
import type { Editor } from '../render/editor';
import type { Preview3D } from '../render/preview3d';
import type { CutoutHost } from './smartCutout';

/** What the editor lends its Pro tools. Filled by toolbar.ts. */
export interface ProToolsContext {
  root: HTMLElement;
  editor: Editor;
  store: DesignStore;
  map: SeatMap;
  objects: ObjectLayer;
  getPreview: () => Preview3D | null;
  /** Put a line in the editor's status bar. */
  say(msg: string): void;
  /** The project's name, for file names. */
  title(): string;
  /** Switch to the Stadium view and wait for the 3D preview. */
  ensurePreview(): Promise<Preview3D | null>;
  /** Redraw the palette strip after the palette changed. */
  paletteChanged(): void;
  /** The picture armed in the import bar, and a way to put another in its place (portrait styles). */
  importPicture?: CutoutHost;
  /**
   * The stadium export's Pro choices, set by proExport once it has mounted.
   * toolbar.ts reads them when Preview or Export is pressed.
   */
  stadium?: {
    /** The video's size, or null for the size of the screen (free). */
    size(): { width: number; height: number } | null;
    /** The names of the Pro items the chosen options add, for the export sheet. */
    items(): string[];
    /**
     * Make the video at a Pro size: Match Day's film of the tifo
     * (ui/proFilm.ts), without the mark when `clean`, its cards going up in
     * the reveal picked in the Animation panel. Resolves with the status line.
     */
    film?(size: { width: number; height: number }, how: { clean: boolean; reveal: string }): Promise<string>;
    /** Play that film into the Preview's canvas, as it is drawn; it stops when the canvas leaves the page. */
    previewFilm?(size: { width: number; height: number }, canvas: HTMLCanvasElement, how: { clean: boolean; reveal: string }): Promise<void>;
  };
}

let mounted = false;

export async function mountProTools(ctx: ProToolsContext): Promise<void> {
  if (mounted) return;
  mounted = true;
  const perks: Promise<unknown>[] = [
    import('./proExport').then((m) => m.mountProExport(ctx)),
    import('./proStyles').then((m) => m.mountProStyles(ctx)),
    import('./proFonts').then((m) => m.mountProFonts(ctx)),
    import('./clubKit').then((m) => m.mountClubKit(ctx)),
    import('./proCredit').then((m) => m.mountProCredit()),
  ];
  const results = await Promise.allSettled(perks);
  for (const r of results) {
    if (r.status === 'rejected') console.warn('[tifo] a Pro tool did not load', r.reason);
  }
}
