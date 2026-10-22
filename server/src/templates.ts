import { seatTable } from './seatTable';
import type { TemplateInfo } from './routes';

/**
 * The grounds the server accepts designs on, with the seat count each one
 * must have.
 *
 * Every ground that ships in the bundle — the built-in catalogue AND the
 * legacy grounds saved designs still point at — not only the three generic
 * bowls. With just those three here, a design on the Jewel, Al-Awwal, Kingdom
 * Arena or any other real-venue ground could not be saved at all ("known
 * templateRef required"), and its share page fell back to the generic bowl.
 *
 * Seat counts come from the SAME generator the browser uses — core/ being
 * DOM-free is what makes server-side validation byte-identical. They are read
 * from the table that generator wrote (seatTable.ts) instead of generating
 * all 104 seat maps at every boot (performance plan P1.31); a ground the table
 * does not match is generated here, as it always was.
 */
export function shippedTemplateInfo(): TemplateInfo[] {
  return seatTable.shipped().map((e) => ({ id: e.id, version: e.version, name: e.name, seatCount: e.seats }));
}
