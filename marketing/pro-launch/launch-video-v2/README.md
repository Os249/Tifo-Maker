# Tifo Maker Pro launch video (v2)

27.5 s, landscape 1920x1080, 30 fps. `launch.mp4` is the file to post;
`launch.jpg` is its poster frame (also baked in as frame 0).

Storyboard, every cut on a beat of the music:

| Time | Scene |
|---|---|
| 0.00 | King Abdullah Sports City from the air: تخيّل مدرج ناديك… |
| 2.75 | Its east end raises "العميد" (Al-Ittihad) |
| 5.54 | Its west end raises "الراقي" (Al-Ahli) |
| 7.38 | Al-Awwal Park raises "العالمي" (Al-Nassr) |
| 9.22 | Kingdom Arena raises "الزعيم" (Al-Hilal): صمّم تيفو ناديك وشوفه في ملعبه |
| 12.91 | TIFOMAKER: مجاناً. ودايم مجاناً. |
| 14.77 | برو فتحت |
| 16.63 | The film, the 4K poster, no mark and your credit, kit, fonts and boards |
| 23.99 | سعر الإطلاق 13.99 ريال للشهر (19.99 struck through), tifomaker.org/pro |

The tifos are showcase designs (`marketing/video-src/harness/tifos.js`)
rendered by the site's own Match Day and film code
(`marketing/video-src/harness/run.mts clip ...`). The composition is a
Hyperframes project: `python3 work/build.py` writes it (it needs
`work/music.pcm`: the music decoded to mono 22.05 kHz 16-bit), then
`npx hyperframes check` and `npx hyperframes render` in `composition/`.

Music: "Heroic Age" by Kevin MacLeod (incompetech.com), CC BY 4.0, from
1:02 to the end of the track. Credit it wherever the video is posted:
"Music: Kevin MacLeod, incompetech.com (CC BY 4.0)".
