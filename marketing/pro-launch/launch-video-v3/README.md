# Tifo Maker Pro launch video (v3): tifos published by fans

27.5 s, landscape 1920x1080, 30 fps. `launch.mp4` is the file to post.

The four tifos are real designs published on tifomaker.org by fans (all
four allow remixing), loaded from the public API and filmed by the site's
own Match Day code from a free camera
(`marketing/video-src/harness/run.mts fly community:<id> ...`):

| Time | Tifo | Maker | Page |
|---|---|---|---|
| 0.00, 9.22 | Barcelona at Camp Nou | @hmatadl13 | /t/2903cf3d-5e94-466f-b97f-061a754aab5d |
| 3.69 | Al-Ahli at King Abdullah Sports City | @FahadI | /t/2f9f8780-ebf1-40b8-8e1e-1b8d2370321d |
| 5.54 | Muangthong United ultras | @aungpaocharoenki | /t/8ae9cc6c-6087-433a-bdf5-89b2e8bb7f61 |
| 7.38 | The Qassim derby at Buraidah | @z_7xz | /t/ef731e8f-7549-428c-af92-f2a7c4f6d956 |

Each maker's handle is shown on screen with their tifo. Then: TIFOMAKER,
free; Pro is open; the film, the 4K poster, no mark and your credit, kit,
fonts and boards; the launch price.

Build: `python3 work/build.py` writes the Hyperframes composition (it needs
`work/music.pcm`), then `npx hyperframes check` and `render` in
`composition/`.

Music: "Heroic Age" by Kevin MacLeod (incompetech.com), CC BY 4.0. Credit:
"Music: Kevin MacLeod, incompetech.com (CC BY 4.0)".
