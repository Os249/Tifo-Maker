# Pro quality: Club kit, the supporter badge, and the credit line

The "kit" engineer's notes, 1 Nov 2026. Branch `pq-kit`. Scores are of the
OUTPUT a fan gets, judged from the real exports and screenshots listed under
each perk (`/home/claude/evidence/kit/`).

## Club kit (5 → see score below)

**What changed**

- **On the account.** Kits live on the account (`server/src/kitRepo.ts`,
  `kitRoutes.ts`; tables `pro_club_kits`, `pro_kit_logos` in `schema.sql`),
  so a kit made on a laptop is on the phone. Logos are PNG only, sniffed by
  their bytes, at most 512 px and 400 KB, kept with their metadata stripped,
  under the SHA-256 of what is kept, once per account; a kit names its logos by
  hash, so saving a kit again does not resend pictures, and a logo no kit
  names is deleted in the same write. At most 3 kits per account, decided
  under a per-account advisory lock (six racing PUTs: three saved, three
  told it is full, on memory and Postgres). Routes 404 for anyone Pro is not
  on for, like every Pro route; reads 120/min, writes 30/min, a body limit
  sized for four logos. The account export carries the kits, their logos and
  the credit line.
- **The browser** (`ui/clubKitStore.ts`, same exported API): signed in, the
  account's kits, with a copy in IndexedDB for when the server does not
  answer, shown only to the session that kept it. A kit saved or deleted
  offline is queued and goes up at the next load that gets an answer. The
  kits this browser made before move up once each and are then gone from the
  browser (one copy, never two); one that does not fit (the account has 3)
  stays and the sheet says so. Signed out, or an account with no kits on it:
  this browser's kits, exactly as before. The sheet says where the kits are
  ("On your account: here on every device you sign in on" / "You're
  offline…").
- **Everywhere** (`ui/kitEverywhere.ts`, `ui/kitActive.ts`): the kit used in
  a project stays with it (remembered by project id). The AI designer gets
  it with every design as `kit: { name, colours, font }` (two marked lines in
  `aiPanel.ts`, one in `net/api.ts`), and the AI panel says "Using kit: …"
  with a way to stop. A banner can be dressed in it in one undo step: the
  kit's first colour for the cloth, the kit colour that stands out most on it
  for the letters, the kit's font, its crest at the start end and, on a
  banner with no words yet, the club's name beside it; a sign keeps its words
  alone. Post it's band wears the kit's colours as a scarf stripe and its
  crest at the band's end, its title in the kit's font (a Pro voice only
  while Pro runs). The LED boards and the poster read `loadKits()` themselves
  (the "fonts" and "video" engineers).
- Pro rules unchanged: saving kits is free, the one free use, then Pro.

## Supporter crown → supporter badge

`ui/supporterBadge.ts`: the gold crown and "Pro supporter" / "داعم مميّز"
(the crown alone, its words spoken, in a comment). On the tifo cards and the
preview's author line (`community.ts`), the public tifo page's creator line
and its comments (`share.ts`), the community profile header and the editor's
profile overlay (`ui/profile.ts`), and the account page ("Your name shows this
badge in the community: @name ♛ Pro supporter"). The crown SVG moved to
`ui/crown.ts` so the public tifo page shows the badge without loading the rest
of Pro. The server already exposed `ownerSupporter`/`supporter` on the
gallery, one design, the profile and comments: a fact about the account (a
paid pass, now), never a plan or a date, not for the gift, and only to viewers
inside the preview while Pro is in preview; the suite checks each.

## No mark on any export → the credit line

`ui/creditLine.ts` `drawCreditLine(ctx, width, height, text, opts)`: a dark
rounded pill with a hairline and the credit in white, a short stripe in the
kit's colour, sized by the picture's area (a vertical clip gets the same size
as a landscape one; at least 12 px, at most 45% of the width), in the corner
the text starts from (an Arabic credit bottom right, right to left, an
`@handle` inside it kept as a left-to-right run) unless the site's mark is in
that corner. Kept on the account (`/api/pro/credit`), not with the kit: a
credit names who made the tifo, the same for every club, and it must be there
in a project that never used a kit. One value, typed in the same field
wherever an export is made (the stadium export panel, the Post it sheet,
Match Day's Record section). Free to try (every preview shows it); at export
"Your credit line" is one of the Pro items the export sheet names, and the
free version goes without it.

Wired on this branch into: the stadium video and its preview, the GIF, the 4K
poster, Post it, and the Match Day snapshot and recording. The "video"
engineer's rebuilt video and poster exports take `creditLine?: string`; the
merge connects them to `currentCredit()`.

## How it was measured

- `server/test/kits.test.mts` (routes and attacks, memory and Postgres).
- `e2e-pro-kit-sync.mjs`: two real browser contexts on one account, a
  browser-only kit moving up, offline save and delete, the AI request body,
  banners, Post it pixels, the credit line's box measured in every exported
  file (preview frame, GIF, video's last frame via ffmpeg, 4K poster, Post it,
  Match Day snapshot and clip), the badge in two languages, two themes and at
  390 px. `e2e-pro-kit.mjs` updated for kits on the account.
- `scripts/credit-shots.mts`: the credit on a night sky, a floodlit white
  stand, a busy crowd and a gold tifo, at 480 px, Full HD, 9:16 and 4K.

## Scores (the output, honestly)

- **Club kit: 8/10** (was 5). A kit saved on one device is on the other with
  its colours, crest and font; it survives offline and moves up from a
  browser once; and it now dresses more than the seats: the AI request
  carries it (the panel says so), one tap turns an empty stand banner into
  the club's cloth with its crest and its name in its font, and Post it's
  band is in the club's colours with its crest. Not 9: what the AI does with
  the kit is the "ai" engineer's server side, the LED boards and the poster
  read it on their own branches, and "Use in this project" still maps the
  seats to the nearest kit colour rather than re-composing the design.
  Evidence: `sync/sync-1440-laptop-saved.png`, `sync/sync-390-phone-sees-kit.png`,
  `sync/sync-390-offline.png`, `sync/sync-1440-laptop-sees-phone.png`,
  `sync/kit-ai-chip.png`, `sync/kit-banner-sign-dressed.png`,
  `sync/kit-banner-stand-dressed.png`, `sync/kit-post-it.png`.
- **Supporter badge: 8/10** (was 5). A real badge, the crown and "Pro
  supporter" / "داعم مميّز" in gold on the tifo card, the public tifo page,
  the profile header and the account page, right in both languages, both
  themes and at 390 px, and never leaking a plan or a date. Not 9: a comment
  shows the crown alone (no room for the words), and nothing yet tells a
  visitor what the badge means beyond its tooltip.
  Evidence: `badge-sheet.png`, `sync/badge-*.png`.
- **No mark on any export: 9/10** (was 8). The fan's own credit line, typed
  once and kept on the account, in the corner of the stadium video and its
  preview, the GIF, the 4K poster, Post it and the Match Day snapshot and
  clip, legible on a white stand, a night sky and a crowd, right to left in
  Arabic, and named in the export sheet so the free version goes without it.
  The video and poster the "video" engineer is rebuilding need its
  `creditLine` option connected at merge (`currentCredit().text`).
  Evidence: `credit-sheet.png`, `sync/credit-stadium-preview.png`,
  `sync/credit-stadium.gif`, `sync/credit-video-last-frame.png`,
  `sync/credit-poster-4k.png`, `sync/credit-matchday-snapshot.png`,
  `sync/credit-matchday-clip-last-frame.png`, `sync/credit-post-it-arabic.png`,
  `sync/credit-export-panel.png`.
