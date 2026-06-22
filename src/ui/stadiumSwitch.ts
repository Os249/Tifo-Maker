/**
 * Stadium switch — the single, shared way to change the loaded stadium.
 *
 * Stadiums differ in seat count and shape, so switching is done by the proven
 * existing flow: stash the current design (cells + palette + title) and the
 * source template in sessionStorage, then reload on the target template. The
 * load path (main.ts) picks the stash up and remaps the design onto the new bowl
 * by relative UV position (remapDesignAcrossStadiums), preserving the look and
 * keeping the app stable. Reversible: switching back remaps back.
 *
 * Both the legacy #stadium dropdown and the new Stadium panel call this — one
 * code path, no duplication. The stash SHAPE must match the pickup in main.ts.
 */

export const STADIUM_STASH_KEY = 'tifo_stadium_remap';

export interface StadiumSwitchContext {
  /** Currently-loaded template id (the bowl we're leaving). */
  fromId: string;
  /** Current palette to carry across. */
  palette: string[];
  /** Current seat cells to remap onto the new bowl. */
  cells: Uint8Array | number[];
  /** Document title to preserve. */
  title: string;
}

/**
 * Stash the current design and reload on `toId`. No-op if switching to the same
 * stadium. If stashing fails we still switch (the design simply isn't carried).
 */
export function requestStadiumSwitch(toId: string, ctx: StadiumSwitchContext): void {
  if (!toId || toId === ctx.fromId) return;
  try {
    sessionStorage.setItem(
      STADIUM_STASH_KEY,
      JSON.stringify({
        fromTemplate: ctx.fromId,
        palette: ctx.palette,
        cells: Array.from(ctx.cells),
        title: ctx.title,
        prevTemplate: ctx.fromId,
      }),
    );
  } catch {
    /* if stash fails we simply switch without carrying — acceptable fallback */
  }
  location.search = `?template=${encodeURIComponent(toId)}`;
}
