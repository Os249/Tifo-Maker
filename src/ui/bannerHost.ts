import type { ToolId } from '../core/types';

/**
 * The one seam between the Banner view and the rest of the editor.
 *
 * `toolbar.ts` is 2,800 lines of carefully-worn behaviour whose job is the seat
 * grid. Teaching it about banners in nine different places would be nine more
 * chances to break painting, which is the product. Instead it asks this object
 * one question at each decision point — "is a banner the thing in front of the
 * user right now?" — and hands the action over if it is.
 *
 * Nothing here knows what a banner IS. That lives in `bannerView.ts`, which
 * registers itself as `current` when it mounts.
 */
export interface BannerHost {
  /** True while the Banner view is the one on screen. */
  readonly active: boolean;
  setTool(tool: ToolId): void;
  undo(): void;
  redo(): void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  fit(): void;
  zoomBy(factor: number): void;
  /** The active painting colour, mirrored from the shared palette. */
  setColor(hex: string): void;
  /** Place a text object on the banner. Returns false if there was nothing to place. */
  placeText(o: { text: string; fontId: string; arcDeg: number; color: string }): boolean;
  placeShape(o: { shape: string; color: string }): boolean;
  placeImage(o: { bitmap: ImageBitmap; name: string }): boolean;
  /**
   * The keys, which have to reach the banner too.
   *
   * They did not. Ctrl+Z in the Banner view undid the SEAT design — a
   * surface that was not even on screen — and Delete deleted the seat
   * editor's selection, so the one thing a user could not do to a banner by
   * keyboard was the thing they were looking at. Each returns true when it
   * did something, so the caller knows not to fall through to the seats.
   */
  deleteSelected(): boolean;
  duplicateSelected(): boolean;
  /** Move the selected item by this many CSS pixels at the current zoom. */
  nudge(dxPx: number, dyPx: number): boolean;
  /** Let go of whatever is selected. */
  escape(): boolean;
}

/**
 * Fired on `document` whenever the banner's undo stacks move, or the view
 * changes surface.
 *
 * The toolbar mounts before the Banner view's chunk has even been downloaded,
 * so it cannot subscribe to a store that does not exist yet. An event it can
 * listen for from the start is the only arrangement that does not leave the
 * Undo button a beat behind — which is precisely the bug the September editor
 * audit found on the seat surface, and it reappeared here the first time this
 * was wired through a subscription.
 */
export const BANNER_HISTORY_EVENT = 'tifo:banner-history';

export const bannerHost: { current: BannerHost | null } = { current: null };

/** Is the Banner view the surface the user is looking at? */
export function bannerActive(): boolean {
  return bannerHost.current?.active === true;
}
