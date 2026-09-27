/**
 * Stadium switch — the single, shared way to change the loaded stadium.
 *
 * Stadiums differ in seat count and shape, so switching is done by the proven
 * existing flow: stash the current design (cells + palette + title) and the
 * source template in sessionStorage, then reload on the target template. The
 * load path (main.ts) picks the stash up and remaps the design onto the new bowl
 * by relative UV position (remapDesignAcrossStadiums), preserving the look and
 * keeping the app stable.
 *
 * Since projects, the result is a NEW project: a project keeps its stadium, so
 * the one being left is never rewritten onto another bowl.
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
  /** The caller already asked (the Stadium panel has its own, fuller dialog). */
  confirmed?: boolean;
}

/**
 * Make a copy of the open project on `toId`, after asking.
 *
 * A project keeps its stadium: the stadium decides the seats, and a design is
 * one colour per seat. So "switch stadium" makes a NEW project with the design
 * fitted onto the other bowl, and leaves this one as it is. Resolves false when
 * nothing happened (same stadium, or they said no), so the caller can put its
 * control back.
 */
export async function requestStadiumSwitch(toId: string, ctx: StadiumSwitchContext): Promise<boolean> {
  if (!toId || toId === ctx.fromId) return false;
  const [{ confirmModal }, { t, tl, tv }, { newProjectUrl, readRaw, stashNewProject }] = await Promise.all([
    import('./modal'),
    import('./i18n'),
    import('../core/projects'),
  ]);
  const stadium = tl(toId);
  const ok = ctx.confirmed || await confirmModal({
    title: tv('ed.proj.switchQ', { stadium }),
    message: tv('ed.proj.switchMsg', { stadium }),
    confirmLabel: t('ed.proj.switchGo'),
  });
  if (!ok) return false;
  let banners: string | null = null;
  try {
    const open = JSON.parse(sessionStorage.getItem('tifo_open_project') ?? 'null') as { banners?: string } | null;
    banners = open?.banners ? readRaw(open.banners) : null;
  } catch {
    banners = null;
  }
  try {
    sessionStorage.setItem(
      STADIUM_STASH_KEY,
      JSON.stringify({
        fromTemplate: ctx.fromId,
        palette: ctx.palette,
        cells: Array.from(ctx.cells),
        title: ctx.title,
        prevTemplate: ctx.fromId,
        banners,
      }),
    );
  } catch {
    /* if stash fails the copy simply starts blank on the new stadium */
  }
  const title = tv('ed.proj.copyOn', { name: ctx.title || t('np.nameDefault'), stadium }).slice(0, 80);
  stashNewProject({ title, templateId: toId });
  location.assign(newProjectUrl(toId));
  return true;
}
