/**
 * What it takes to build a Match Day away from Match Day: the seats, the
 * design, the ground, the scene's banners and pictures, and a way to pause
 * the editor's own 3D view meanwhile. main.ts lends them once the editor is
 * up; Pro's film and poster (ui/proFilm.ts, ui/proPoster.ts) borrow them to
 * draw Match Day off screen, from the editor's export panel.
 *
 * In the editor's start chunk, so it holds no strings and imports no code:
 * the types only.
 */
import type { BannerStore } from '../core/banner';
import type { DesignStore } from '../core/design';
import type { AssetStore } from '../core/sceneAssets';
import type { SeatMap, StadiumTemplate } from '../core/types';

export interface MatchDayDeps {
  map: SeatMap;
  store: DesignStore;
  template: StadiumTemplate;
  assetStore: AssetStore;
  bannerStore?: BannerStore;
  /** Stop the editor's 3D view drawing while Match Day draws off screen, and start it again. */
  pausePreview(): void;
  resumePreview(): void;
}

let deps: MatchDayDeps | null = null;

export function setMatchDayDeps(d: MatchDayDeps): void {
  deps = d;
}

/** Null until the editor has lent them (and on any page that is not the editor). */
export function matchDayDeps(): MatchDayDeps | null {
  return deps;
}
