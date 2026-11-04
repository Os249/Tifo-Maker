/**
 * The club kit in use in this project: set by ui/clubKit.ts when "Use in this
 * project" is pressed (and when the project opens again, from what this
 * browser remembers), cleared when the fan stops using it.
 *
 * Read by what dresses itself in the kit without loading the kit's own code:
 * the AI designer sends it with every design (ui/aiPanel.ts), Post it lays
 * out its picture in it (ui/postMoment.ts), the credit line takes its colour
 * (ui/proCredit.ts). No strings, no network, no pictures: just enough to say
 * which kit, so the editor's start can carry it.
 */

/** What the AI designer is told about the kit (server/src/aiRoutes.ts reads `kit`). */
export interface AiKit {
  name: string;
  colours: string[];
  font?: string;
}

export const activeKit: { current: AiKit | null } = { current: null };

/**
 * The kit as the AI request carries it, or nothing. Its first 16 colours, in
 * the kit's order: a club's own colours come first, and a kit saved from a
 * busy design can hold a hundred.
 */
export function kitForAi(): { kit: AiKit } | Record<string, never> {
  const k = activeKit.current;
  return k && k.colours.length ? { kit: { name: k.name, colours: k.colours.slice(0, 16), ...(k.font ? { font: k.font } : {}) } } : {};
}
