import { generateSpecViaProvider, activeProvider } from './aiProvider';
import {
  PHOTO_FACTS_PROMPT,
  aggregateFacts,
  factsToKnown,
  parsePhotoFacts,
  type FactsVote,
  type PhotoFacts,
  type PhotoKnown,
} from '../../src/core/photoFacts';

/**
 * Read a photograph of a ground, several times, and report what the readings
 * agreed on.
 *
 * Several times is the whole design. One vision call returns an answer for every
 * field whether or not the picture contains one, and an answer like that, handed
 * to a template that advertises where each number came from, is a lie with a
 * provenance label on it. Asking n times and keeping the agreement rate turns
 * the same call into a measurement with an error bar: three of four readings saw
 * a running track, one did not, and the caller can decide what that is worth.
 *
 * The calls go out together. They are independent readings of the same image, so
 * running them in sequence would multiply the user's wait by n for nothing.
 */
export const PHOTO_SAMPLE_DEFAULT = 3;
export const PHOTO_SAMPLE_MAX = 8;

export interface PhotoReadResult {
  vote: FactsVote;
  known: PhotoKnown;
  /** Fields firm enough to use. */
  used: string[];
  /** Fields the readings could not agree on, and by how much they failed. */
  dropped: Array<{ field: string; agreement: number; answered: number }>;
  /** One line per failed call, so a half-working key is visible rather than silent. */
  errors: string[];
}

export async function readGroundPhoto(image: string, samples = PHOTO_SAMPLE_DEFAULT): Promise<PhotoReadResult> {
  const n = Math.max(1, Math.min(PHOTO_SAMPLE_MAX, Math.round(samples)));
  if (activeProvider() === 'none') {
    const vote = aggregateFacts([]);
    return { vote, known: {}, used: [], dropped: [], errors: ['no AI provider configured'] };
  }
  const results = await Promise.all(
    Array.from({ length: n }, () =>
      generateSpecViaProvider('Describe this ground.', {
        system: PHOTO_FACTS_PROMPT,
        image,
        raw: true,
        tier: 'premium',
      })),
  );
  const facts: PhotoFacts[] = [];
  const errors: string[] = [];
  for (const r of results) {
    if (r.spec) facts.push(parsePhotoFacts(r.spec));
    else if (r.error) errors.push(r.error);
  }
  const vote = aggregateFacts(facts);
  const { known, used, dropped } = factsToKnown(vote);
  return { vote, known, used, dropped, errors };
}
