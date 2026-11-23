# How TifoMaker videos are made (from 24 Nov 2026)

The first videos were rejected for three reasons: they looked generic, one of them
claimed something untrue ("I made my club's tifo from my phone", when the editor only
runs on a computer), and they had no real voice. This is the standard every video
now has to meet, and the pipeline that makes it possible for one person to keep it up.

## The standard

1. **Real tifos only.** Either a design a fan made in the TifoMaker community, posted
   with their permission and their name on it, or a design we make properly around a
   club's nickname, chant, symbol or history. Never flat colour blocks.
2. **Nothing misleading.** No "from my phone". No render passed off as a match photo:
   when a frame could be mistaken for a real stand, the video says it was designed in
   TifoMaker. No claims the site can't back up today.
3. **The best moment first.** The finished tifo, already up, in the first second.
   No logo intro, no "watch this".
4. **Arabic.** On-screen text in Gulf Arabic, large, in the top third (TikTok's
   buttons cover the bottom and right).
5. **A real male voice, only when the video needs one.** Many videos work better with
   on-screen text and a trending sound. When there is a voice, it is a person.
6. **It loops.** The last frame matches the first.
7. **Credit on screen.** The designer's handle, small, for as long as their tifo is up.

## The pipeline

### 1. Capture the tifo in 3D (Playwright, the real app)

A script opens a design in the real app on a desktop-sized window, switches to
Match Day on the High or Ultra tier, and runs the camera moves the video needs:
low in the stand, a rise across it, the wide bowl. It saves frames rather than a
screen recording, so the motion is smooth at 60 fps whatever the machine.

Community designs load by id (`/api/designs/<id>/scene`), so any public design can
be captured without touching its owner's account.

### 2. Put the video together (Remotion)

A Remotion project in `marketing/video-studio/` holds one composition per format,
in the brand's colours and type (Changa, Almarai), 1080×1920 for TikTok and Shorts
and 1920×1080 for X:

| Composition | Used by | What it does |
|---|---|---|
| `FanTifo` | tt-01, x-06 | A fan's tifo going up, with their credit |
| `ClubMontage` | tt-02 | Three tifos, one per beat |
| `ReplyBuild` | tt-03 | TikTok's comment sticker, then the build and the reveal |
| `DerbyDuel` | tt-04 | Home end, away end, both together, vote prompt |
| `CardCount` | tt-05 | Question, zoom to single seats, the real card count by colour |
| `GroundStory` | tt-06 | Real photo beside the model, voice over the build |
| `BuildLapse` | tt-07 | Empty stand to finished tifo, looped |

Remotion is free for individuals and companies of up to three people; check
remotion.dev/license if that changes. In the session that builds this, install
Remotion's own agent skills first so the code follows their current API.

### 3. Voice

Decided: a real male voice, only where needed. Still to choose (see the question in
the chat): your own voice, a hired Saudi voice actor, or one of the newer
human-sounding AI voices. Whichever it is, the script for each video is written to be
read aloud in under 25 seconds.

### 4. Sound

Exports carry no music by default. The trending sound is added in the TikTok app,
which pushes in-app sounds harder. A licensed fallback track goes on the X and
YouTube versions.

### 5. Export and review

Two clean exports per video (9:16 and 16:9), H.264, no watermark. Each one is
uploaded to its post's card in the Social HQ for approval before anything is posted.

## Order of work

1. The capture script, tested on one community design.
2. `FanTifo`, used to remake tt-01.
3. `ClubMontage` (tt-02), then the rest in posting order.
