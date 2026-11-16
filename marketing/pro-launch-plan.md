# Tifo Maker Pro: pre-launch campaign plan

Draft of 15 Nov 2026 for Osamh to approve. Nothing here is posted, sent or
committed by Claude: every tweet, DM and email is a draft you refine and send.

All times are Riyadh time (UTC+3). "L" is launch day: the day Moyasar has
approved payments and the other session has finished the perk check. The
plan assumes L is Wednesday 18 Nov; if it slips, the L-days slide with it
and the days before simply repeat the "one perk video a night" rhythm.

## 0. What the code says today, and what is still open

Read on 15 Nov from `server/src/proPlan.ts`, `src/proPage.ts` and the
strings. Re-read before each video, since the other session may change it.

**Safe to promote (matches your list and the code):**

| Perk | Where it is in the code | Free has |
|---|---|---|
| Full HD Match Day film + vertical 9:16 | `pp.row.video`, `pexp.*`, `filmPlan.ts` (13 s) | the film at "your screen" size, with the tifomaker.org mark |
| 4K poster, Arabic and English type | `pp.row.poster` | nothing like it |
| No mark + your own credit line | `pp.row.mark`, `ui/creditLine.ts` | the tifomaker.org mark on exports |
| Club kit on your account | `pp.row.kit`, `ui/kitEverywhere.ts` | nothing like it |
| Pro fonts (Arabic and Latin) | `pp.row.fonts`, `core/proVoices.ts` | the standard fonts |
| Your words on the LED boards | `pp.row.led` | the boards without your own words (check in the recording) |
| Supporter crown | `pp.row.badge` | nothing; paid month only, never the gift |

**Mismatches between your brief and the live code. Please settle these
before the announcement tweet, because the tweet sends people to /pro:**

1. **"More AI designs" and "More Polish" are on Pro in the code.**
   `AI_ON_PRO = true` ("back on the list on 8 Nov, Osamh's decision"), so
   /pro lists them as rows today. Your brief says both came off.
2. **The smart cut-out is listed on /pro.** Pro's cut-out allowance (5 a day,
   15 a month) differs from free (1 a week), so `rowsFor()` shows the row.
   You said it is broken on the live site.
3. **Portrait styles are listed on /pro** (`pp.row.styles` in `PERK_ROWS`).
4. **The price in the code is SAR 19** (`OFFER.monthly.price`). The campaign
   says the price comes from the answers. Whatever the median says, the
   number has to be changed there by the session that owns Pro before L.
5. **The name.** The site calls it "المميّزة" in Arabic; the tweet calls it
   "برو". The image and the copy below say "برو", as fans will. On L day the
   page will say "المميّزة", so one tweet should say "برو (المميّزة بالموقع)".
6. **"Whoever answers hears first" is only true for signed-in accounts**
   (`ps.step3.b`: "Signed in, you'll hear first"). The self-reply below says
   so. People who answer only on X get told on X (section 5).

The image (`marketing/pro-launch/free-vs-pro-4x5.png`) shows only the seven
safe perks, so it stays true whichever way 1 to 3 are settled. The risk is
the other direction: a fan taps the link and sees rows on /pro that you do
not want to promise.

## 1. The announcement (tonight, Sunday 15 Nov)

### Main tweet (with the 4:5 image)

> شهور وأنا أبني تيفو ميكر لحالي، ودعمكم هو اللي خلاني أكمل 🤍
> وقريب بتنزل نسخة "برو" ♛
>
> وعد مني: تصميم التيفو بيظل مجاني بالكامل، وما راح أقفل أي شي أساسي.
> برو إضافات للي يبي أكثر (التفاصيل بالصورة)
>
> وقبل لا أحدد السعر أبي رأيكم:
> كم يستاهل شهر برو برأيك؟ اكتب رقمك بالريال 👇

What changed from your draft, and why:

- 👇 moved to the last line. It was pointing at the question, not the image,
  so the image now gets "(التفاصيل بالصورة)" and the arrow points at the
  replies, which is where you want people to go.
- "اكتب رقمك بالريال": answers come back in one currency and are easy to
  count. Without it you get "5$", "عشرين", "ولا شي" mixed.
- Everything else is yours. It is personal and short, and the promise is in
  the middle where it is read. Keep it under 280 characters if you are not
  on Premium (this version is about 265).

Image alt text: "مقارنة بين المجانية وبرو في تيفو ميكر: المحرر والملعب 3D
ويوم المباراة والحفظ والنشر مجانية دايم. برو يضيف فيلم Full HD وبوستر 4K
وبدون علامة الموقع وهوية النادي وخطوط مميّزة وشاشات الملعب وتاج الداعم."

### Self-reply (the link)

> وإذا تحب تحط رقمك بالموقع مباشرة: tifomaker.org/ar/pro
> ما فيه دفع ولا بطاقة. سجّل دخولك وجاوب، وبيوصلك الخبر أول الناس لما تفتح برو

- "سجّل دخولك" added because only signed-in answers go on the list.
- "أول الناس" for "أول واحد": everyone on the list hears at once.
- Use the `/ar/pro` address so the page opens in Arabic with riyals.
  Add `?utm_source=x&utm_campaign=pro_soon` if you want it counted apart on
  /admin (the site already cleans UTM out of the address bar).

### Timing

Post at **9:15 pm**. Stay online until 11 pm and reply to every answer in
that first hour and a half: X shows a tweet to more people when its replies
get replies early. Pin it.

## 2. Day by day

Evenings are the slot: after Isha, roughly 8:30 to 10:30 pm. Before posting
any night, look at the fixture list: if a big Saudi League match is on,
post 45 minutes before kick-off or 20 minutes after full time, never during.

| Day | Evening post on X (personal account) | Daytime work |
|---|---|---|
| **Sun 15 (tonight)** | 9:15 pm: announcement + image, self-reply with the link, pin | Reply to every price answer. Open the Gmail and the three TifoMaker accounts. Settle section 0. |
| **Mon 16** | 9:00 pm: perk video 1, **the Match Day film**. 10:30 pm: quote-tweet the best price answer | Send the first 10 to 15 DMs (section 4). Record footage for videos 2 and 3. Send outreach emails (section 5). |
| **Tue 17** | 8:45 pm: perk video 2, **4K poster**. 10:15 pm: "the answers so far" tweet (below) | Second batch of DMs. Record the rest. Read the median on /admin, decide the price. |
| **Wed 18 = L** | Launch (section 6), when payments are open and tested | Morning: one real purchase by you. Email the list. |
| **Thu 19 (L+1)** | perk video 3, **no mark + your credit** + quote the first buyers' exports | Reply to everyone who posts a Pro export |
| **Fri 20 (L+2)** | perk video 4, **club kit**. Friday is the big football night: post before the evening kick-offs | |
| **Sat 21 (L+3)** | perk video 5, **Pro fonts** | Last-day reminder of the founding offer if it runs 72 hours |
| **Sun 22 (L+4)** | perk video 6, **LED boards** | |
| **Mon 23 (L+5)** | perk video 7, **supporter crown**, as a thank-you to the first supporters by name | Look at the numbers, write down what worked |

If L slips to Thu 19 or later, Wed 18 becomes "perk video 3" and everything
after moves one day. Do not post a launch date until Moyasar has said yes.

### Replying to price answers (every day until L)

- Reply to **every** answer, within the hour while you are online. Short and
  personal: "١٥ منطقي 🤝 وش أكثر شي شدّك من الإضافات؟". A question back
  doubles the replies.
- Someone says "it should be free": do not argue. "التصميم مجاني وبيظل 🤍
  برو بس للي يبي الفيلم والبوستر وكذا".
- Someone names a high number: thank them, do not promise that price.
- Each evening quote-tweet **one** answer: the funniest, or the one that
  explains why. Ask the person first if the account is small or private-ish.
- Keep a simple tally of the X numbers (a note on your phone): they are not
  in /admin, and you need them for the median.

### Tuesday's "answers so far" tweet

> وصلني لين الحين [N] جواب على سعر برو 🙏
> أقل رقم: [X] ريال. أعلى رقم: [Y] ريال.
> باقي يوم وأقفل الأجوبة وأعلن السعر. اللي ما جاوب: كم يستاهل شهر برو؟

Only real numbers from /admin plus your X tally. If N is small, drop the
count and keep the range.

## 3. One video per perk

Common rules for all seven:

- **Real footage only**: screen recordings of the editor and Match Day on
  tifomaker.org, and the actual exported film and poster files. Remotion
  adds the frame, the captions, the Free/Pro labels, the cuts and the end
  card. Nothing is mocked up.
- **Sound on X**: the film's own crowd and tabl track, or silence with
  captions. No voice. **Shorts**: the same cut at 9:16 with an ElevenLabs
  voiceover in Arabic (script lines marked VO below).
- **Format**: 1080×1350 (4:5) for X, since it fills a phone timeline;
  1080×1920 for TikTok and Shorts from the same Remotion composition.
- **Look**: night navy ground, white type in Changa (headings) and Almarai,
  the gold crown and gold labels for Pro, green "مجاني" labels for Free, the
  scarf stripe as the top rule, wordmark and `tifomaker.org/pro` on the end
  card. Western digits. No club colours on the frame itself; the club's
  colours appear only inside the footage.
- **Captions burnt in**, large, 2 lines at most, since most X video is
  watched muted.
- **One design carried through the first three videos** (one club, one
  stadium), so the series feels like one story. Pick a tifo that reads well
  from the TV camera. Avoid a design across Kingdom Arena's north stand:
  the box gap splits it (`docs/pro-quality/video.md`).
- End card on every video until L: "برو · قريب ♛ — قول لنا كم يستاهل:
  tifomaker.org/pro". From L: "برو مفتوحة ♛ tifomaker.org/pro".

How to record (all videos): Chrome on a desktop, window at 1920×1080, site
in Arabic, dark theme, a Pro preview account. Record at 60 fps with OBS or
the OS recorder, cursor visible, no browser bookmarks bar, notifications
off. Export Pro files from the site itself and send me the raw files.

### Video 1: the Match Day film (Mon 16) — Free vs Pro, 22 s

The strongest perk, and the product is the footage.

| Time | Picture | Caption on screen |
|---|---|---|
| 0–2 s | The film's own reveal moment, full frame, crowd sound in (start on the best second, not on a title) | هذا تيفو صمّمته بدقايق |
| 2–6 s | Screen recording: the editor, the finished design, pressing Match Day, then Export video | تصمّمه مجاناً… وتصوّره فيلم |
| 6–11 s | Side by side. Left "المجانية": the film at screen size with the tifomaker.org mark. Right "برو ♛": the Full HD film. Slow zoom into the same seats on both | نفس الفيلم. برو: Full HD وبدون علامة |
| 11–18 s | The Full HD film alone: establishing shot, push-in, the reveal, the hold (cut the 13 s to its best 7) | 13 ثانية، مصوّرة داخل الملعب |
| 18–20 s | The vertical 9:16 version sliding in beside it inside a phone outline | ونسخة طولية للتيك توك والستوري |
| 20–22 s | End card | برو · قريب ♛ |

Shots to record:
1. Editor with the finished tifo, opening Match Day (10 s).
2. Clicking Export video and the size picker showing "مقاس شاشتك", Full HD
   and طولي 9:16 (8 s).
3. Exported files of the **same** tifo: the free screen-size film (with the
   mark), the Full HD film, the 9:16 film.

Caption (X):

> التيفو تصمّمه مجاناً، وبيظل مجاني.
> برو يصوّره لك فيلم Full HD من داخل الملعب، 13 ثانية، وبنسخة طولية للستوري ♛
>
> قبل لا أحدد السعر: كم يستاهل شهر برو برأيك؟

Shorts VO (about 20 s): "هذا التيفو صمّمته بدقايق، ومجاناً. ومع برو، الموقع
يصوّره لك فيلم كامل من داخل الملعب: لقطة من فوق، الكاميرا تقرّب، والمدرج
يرفع التيفو. Full HD، وبنسخة طولية لجوالك. الرابط بالوصف."

### Video 2: the 4K poster (Tue 17) — Pro alone, 16 s

| Time | Picture | Caption |
|---|---|---|
| 0–2 s | The finished landscape poster, full frame | بوستر يوم المباراة |
| 2–6 s | Screen recording: Export → "بوستر يوم المباراة (4K)", choosing landscape | ضغطة وحدة من نفس التصميم |
| 6–11 s | Slow zoom from the whole poster into the seats, to show 4K holds up; then the type column | 4K. قرّب زي ما تبي |
| 11–14 s | Landscape and portrait posters side by side, Arabic one and English one | عرضي أو طولي، عربي أو إنجليزي |
| 14–16 s | End card | برو · قريب ♛ |

Shots to record: the export menu and poster options (8 s); the four poster
files (landscape and portrait, Arabic and English) at full 4K.

Caption:

> بوستر 4K لتيفوك: عرضي أو طولي، بالعربي أو الإنجليزي، وبألوان ناديك.
> ينفع خلفية، وينفع تطبعه وتعلّقه ♛
>
> من إضافات برو الجاية. والتصميم نفسه؟ مجاني دايم.

Shorts VO: "صمّمت تيفو؟ برو يطلّعه لك بوستر 4K: الملعب، التيفو، واسم ناديك
بخط مرتب. عرضي أو طولي، عربي أو إنجليزي. قرّب زي ما تبي، الجودة ما تطيح."

### Video 3: no mark, and your own credit (L+1) — Free vs Pro, 15 s

| Time | Picture | Caption |
|---|---|---|
| 0–3 s | An exported picture; zoom to the bottom corner with the tifomaker.org mark | المجانية: علامة الموقع بالزاوية |
| 3–7 s | Wipe to the Pro export of the same picture: the mark gone | برو: بدون علامة |
| 7–12 s | Screen recording: typing your handle or group name into the credit field; the export with the credit pill in the corner | وتحط اسمك أو اسم رابطتك مكانها |
| 12–15 s | Three exports in a row, each with a different credit | شغلك باسمك ♛ |

Shots: the same export twice (free with mark, Pro without); typing the
credit line (use your own handle and one invented group name, not a real
group's); the exports carrying it.

Caption:

> التيفو تعبك، فخلّه باسمك.
> مع برو: بدون علامة الموقع، واسمك أو اسم رابطتك على كل تصدير ♛

### Video 4: club kit (L+2) — Pro alone, 20 s

| Time | Picture | Caption |
|---|---|---|
| 0–3 s | A plain banner and a default LED board | قبل |
| 3–8 s | Screen recording: picking the club kit; "Using kit: …" appears | اختر هوية ناديك مرة وحدة |
| 8–15 s | Fast cuts: "Dress this banner in …" on a banner, the poster in the kit's colours, the LED boards with the crest | وتلبس كل شي: البنرات، البوستر، الشاشات |
| 15–18 s | The same account opened on a phone, kit already there | ومحفوظة بحسابك على كل أجهزتك |
| 18–20 s | End card | |

Shots: saving a kit; dressing a banner; the poster and boards before and
after; the account on a second device (phone screen recording).

Caption:

> ألوان ناديك وشعاره وخطه، تحفظها مرة وحدة وتلبس كل شي: البنرات والبوستر وشاشات الملعب ♛
> هوية النادي، من إضافات برو.

Use your own club or a neutral invented kit in the video. The site is every
club's, so across the series rotate clubs (a Saudi one, a Premier League
one, a LaLiga one) and avoid leaning on one.

### Video 5: Pro fonts (L+3) — Free vs Pro, 18 s

| Time | Picture | Caption |
|---|---|---|
| 0–4 s | Split screen: the same Arabic word on the seats in a standard font and in a Pro font, from the TV camera | نفس الكلمة. نفس المدرج. |
| 4–10 s | Screen recording: the font picker, crowns on the Pro faces, tapping through 4 of them; the seats update each time | خطوط تنقري من آخر الملعب |
| 10–15 s | Three Pro faces on a real stand, one Arabic, one English, one stencil | عربي وإنجليزي |
| 15–18 s | End card | |

Shots: one word ("الزعيم"-style chant word of your choice, or a neutral
"يا هلا") in a standard font, then in 4 Pro fonts, each from the seat view
and the TV camera. Skip Classic and Ruqaa on seats: the docs say their thin
strokes break up there, they are for banners.

Caption:

> الخط يفرق، خصوصاً من آخر الملعب.
> خطوط برو مختارة عشان تنقري على المقاعد، عربي وإنجليزي ♛

### Video 6: the LED boards (L+4) — Free vs Pro, 18 s

| Time | Picture | Caption |
|---|---|---|
| 0–3 s | Match Day, camera along the pitch-side boards as they stand on free | شاشات الملعب… |
| 3–8 s | Screen recording: typing a chant into the boards panel | …تكتب عليها اللي تبي |
| 8–15 s | Four quick cuts of the moving boards: sponsor, chant ticker, score, countdown | هتاف، نتيجة، عدّ تنازلي |
| 15–18 s | End card | |

Shots: the boards on a free account; the boards panel; each of the four
modes running for 4 s in Match Day with sound.

Caption:

> شاشات الملعب تتحرك بكلامك: هتاف، نتيجة، عدّ تنازلي قبل ما ينرفع التيفو ♛
> من إضافات برو.

Use an invented score or your own club's, and no real sponsor's name.

### Video 7: the supporter crown (L+5) — Pro alone, 12 s

| Time | Picture | Caption |
|---|---|---|
| 0–4 s | A community tifo card and a profile header with the crown and "داعم مميّز" | اللي يدعم الموقع، يبان |
| 4–9 s | Scroll of real first supporters' tifos (with their permission) | شكراً لأول الداعمين 🤍 |
| 9–12 s | End card | |

Caption:

> تيفو ميكر شغل شخص واحد، وكل اشتراك برو يخليه يكمل.
> وهذا تاج الداعم جنب اسمك، شكراً من القلب ♛

This one is a thank-you more than an advert. It only makes sense after L,
with real supporters in it.

## 4. DM outreach on X (mutuals)

Who: accounts you follow that follow you back, active this month, posting
about football, their club, design or tifos. Start with the ones you have
actually talked to. 10 to 15 a day at most, each one written for that
person; X limits and mutes accounts that send the same DM many times.

Base version (rewrite the first line for each person):

> هلا [الاسم] 👋
> [سطر شخصي: شي حقيقي عن حسابه أو آخر شي كتبه أو مباراة ناديه]
> تعرف موقعي تيفو ميكر؟ قريب بنزّل له نسخة برو، وقبل لا أحدد السعر أسأل الناس كم يستاهل.
> ما أطلب إعلان ولا شي. بس إذا شفت التغريدة وعجبتك الفكرة، رأيك أو رتويت منك يفرق معي كثير 🤍
> [رابط التغريدة]

For someone who has used the site or posted a tifo from it:

> هلا [الاسم]، للحين أتذكر التيفو اللي سويته لـ[النادي] 🔥
> قريب أفتح برو (فيلم Full HD للتيفو وبوستر 4K وكذا)، وأبي أعطيك تجربه قبل الناس. تبي؟

Rules:
- One DM, one ask. If they do not answer, do not chase.
- Never ask for a retweet in the first line.
- Offer the big ones an early look (a gift week from /admin, if the other
  session confirms you can grant one) rather than asking for a favour.
- Send in the afternoon (4 to 7 pm), so anyone who helps does it before the
  evening post.

## 5. Email outreach

Sent from your own address, one by one, each with one line that proves you
know who they are.

### Who to look for

1. **Fan and ultras groups' media accounts** in the Saudi League (the
   groups' own design or media people), then Gulf and North African groups,
   who have the strongest tifo culture.
2. **Tifo and terrace culture pages**: accounts and sites that post tifos
   from around the world every week.
3. **Football designers**: people who post kit concepts, match posters and
   club graphics. They understand the tool in ten seconds.
4. **Arabic football content creators and podcasters** who cover fan
   culture, not only results.
5. **Sports and tech journalists** in Saudi media who write about local
   products and solo developers.
6. **Club fan-engagement or marketing staff** (lower priority before L:
   slow to reply).

### How to find a contact

- The account's bio and pinned tweet; the link in bio (Linktree and similar
  pages nearly always list an email "للتواصل والإعلانات").
- Their YouTube channel's About page ("View email address"); Instagram's
  Contact button; TikTok business accounts show an email.
- Their website's contact or "about" page; a podcast's show notes.
- For journalists: the byline page on the publication's site.
- If there is no public email, do not guess one and do not use a scraper:
  send a DM instead, or leave them.

Keep a sheet: name, platform, followers, why them, contact, date sent,
answer. One follow-up after 4 days, then stop.

### Arabic template

> العنوان: تيفو ميكر: موقع سعودي يصمم التيفو ويعرضه في ملعب 3D
>
> هلا [الاسم]،
>
> أنا أسامة، مطوّر سعودي أشتغل لحالي. [سطر شخصي: ليش أكتب لك أنت بالذات]
>
> بنيت موقع اسمه تيفو ميكر (tifomaker.org): المشجع يصمم تيفو ناديه ويشوفه
> في ملعبه الحقيقي ثلاثي الأبعاد، مقعد مقعد، مع وضع "يوم المباراة" اللي
> يرفع فيه المدرج التيفو. فيه ملاعب دوري روشن والدوري الإنجليزي والإسباني
> وغيرها، والتصميم مجاني بالكامل.
>
> بعد أيام أفتح نسخة برو (فيلم Full HD للتيفو، بوستر 4K، وإضافات ثانية).
> حبيت أوريك الموقع قبلها، وإذا شفت إنه يهم متابعينك فأنا جاهز أعطيك
> تجربة برو، أو أي لقطات ومعلومات تحتاجها.
>
> هذا فيديو قصير يوضّح الفكرة: [رابط]
>
> شاكر لك وقتك،
> أسامة
> [حسابك في إكس]

### English template

> Subject: Tifo Maker: design a tifo and see it in a real 3D stadium
>
> Hi [Name],
>
> I'm Osamh, a solo developer from Saudi Arabia. [One personal line: why
> you, specifically.]
>
> I built Tifo Maker (tifomaker.org). Fans design a tifo for their club and
> see it seat by seat in a 3D model of their real ground, with a Match Day
> mode where the stand raises it. It covers grounds from the Saudi League,
> the Premier League, LaLiga and more, and making a tifo is free.
>
> In a few days I'm opening a Pro plan (a Full HD film of the tifo, a 4K
> poster and a few other extras). I wanted to show you the site before
> then. If you think your audience would enjoy it, I'd be glad to give you
> Pro to try, or send footage and anything else you need.
>
> A short video of it: [link]
>
> Thanks for your time,
> Osamh
> [your X handle]

Notes: no attachments over 2 MB (link the video); no "partnership" or
"collaboration" wording in the first email; send between 10 am and 1 pm on
a weekday in their time zone.

## 6. Launch day (L)

### Before anything is posted

1. Moyasar approved, payments switched on, and **you have bought a month
   yourself with a real card** and seen it turn on.
2. The price in `proPlan.ts` is the announced price (the Pro session's job).
3. /pro shows only perks that work.
4. The launch video and the email are ready.

### Setting the price from the answers

- Take the answers on /admin → Pro and add your tally of X replies.
- Convert dollars to riyals (× 3.75). Leave "Not for me" answers out of the
  median, but write down what share they are.
- **Use the median**, not the average: one "100 ريال" joke answer moves an
  average and does not move a median.
- Round to a price that looks like a price (9, 15, 19, 25).
- Two checks before you announce it: the quick-pick buttons (5, 10, 15, 20,
  30) pull answers toward themselves, so the median will very likely be 10
  or 15; and the most a heavy Pro member can cost you is about SAR 9 a
  month in AI (`proPlan.ts`), so a price under 10 can lose money on heavy
  users. If the median is under 10, say so honestly ("أغلبكم قال X، وأقل
  سعر يغطي التكلفة هو Y") rather than quietly ignoring the answers.

### The launch tweet (9:00 pm, with the launch video)

> برو فتحت ♛
>
> سألتكم كم يستاهل الشهر، وجاوبني [N] شخص. الوسط كان [X] ريال، وهذا هو السعر: [X] ريال للشهر.
> تدفع مرة وحدة، وتنتهي لحالها. بدون تجديد تلقائي.
>
> والتصميم؟ مجاني مثل ما وعدتكم، وبيظل 🤍

Self-reply:

> الرابط: tifomaker.org/ar/pro (بالموقع اسمها "المميّزة")
> الدفع عن طريق ميسّر: مدى، Apple Pay، أو بطاقة.

Second reply: the founding offer (below).

"Pay once, it ends by itself, no auto-renewal" is true of payments v1 in
the code and is a selling point: say it.

### The launch video (25–30 s)

A cut of the best seconds of perk videos 1 and 2 plus one line each for the
rest: film (8 s) → poster (4 s) → no mark and credit (3 s) → kit, fonts,
boards (2 s each) → "التصميم مجاني دايم" (2 s) → price and link (3 s). The
film's crowd and tabl sound under all of it. It is built last, from footage
already recorded.

### The founding-member offer

It has to cost you nothing upfront and need no new payment code. Proposal:

**"المؤسسون": anyone who answered the price question or joined the list,
and buys a month in the first 72 hours, gets a second month from me.**

- You grant the extra 30 days by hand from /admin after their payment
  (the code already has a month that is "given" rather than paid; please
  confirm with the Pro session that /admin can grant one, and that a given
  month after a paid one extends it).
- Cost: no cash. At worst about SAR 9 of AI use per founder for the extra
  month, and most people use a fraction of that.
- No discount code, no change to the price or to Moyasar.
- It rewards exactly the people you promised would hear first, and gives
  everyone else a reason to buy in the first three days.

Tweet:

> للي جاوب على سؤال السعر أو سجّل في قائمة "علّمني": أنتم المؤسسون 🤍
> اشترك خلال 72 ساعة، والشهر الثاني عليّ.
> ما تحتاج كود. أضيفه لحسابك بنفسي.

Do not promise "this price forever": payments v1 sells single months with
no renewal, so there is nothing to lock a price onto yet. X-only answerers
qualify too: ask them to reply with their site username after buying.

If the Pro session says a month cannot be granted by hand, the fallback
that needs no code at all is the existing 7-day gift for founders, or their
handle in a "المؤسسون" thank-you thread.

### The email to the "tell me when Pro opens" list

Send it **one hour before** the launch tweet: they were promised first.

Arabic (for accounts whose language is Arabic):

> العنوان: برو فتحت، وأنت أول من يدري ♛
>
> هلا،
>
> طلبت أعلّمك أول ما تفتح برو في تيفو ميكر. فتحت اليوم، وأنت تدري قبل
> ما أعلنها في إكس.
>
> السعر [X] ريال للشهر، وحددناه من أجوبتكم. تدفع مرة وحدة وتنتهي لحالها،
> بدون تجديد تلقائي.
>
> برو يضيف: فيلم Full HD ليوم المباراة ونسخة طولية، بوستر 4K، تصدير بدون
> علامة الموقع وباسمك، هوية ناديك، خطوط مميّزة، كلامك على شاشات الملعب،
> وتاج الداعم.
>
> ولأنك من الأوائل: اشترك خلال 72 ساعة والشهر الثاني عليّ.
>
> [زر: شوف برو] tifomaker.org/ar/pro
>
> وتصميم التيفو مجاني مثل ما هو، وبيظل.
>
> شكراً إنك معي من البداية،
> أسامة

English:

> Subject: Pro is open, and you're hearing first ♛
>
> Hi,
>
> You asked to be told when Tifo Maker Pro opened. It opened today, and
> you're hearing before I post it on X.
>
> It's [X] SAR for a month, set from your answers. You pay once and it ends
> by itself; nothing renews.
>
> Pro adds: the Full HD Match Day film and a vertical version, a 4K poster,
> exports without our mark and with your own credit, your club kit, Pro
> fonts, your words on the LED boards, and the Supporter crown.
>
> Because you were early: get a month in the next 72 hours and the second
> month is on me.
>
> [Button: See Pro] tifomaker.org/pro
>
> Making a tifo is as free as it was, and stays that way.
>
> Thank you for being here from the start,
> Osamh

Check with the Pro session how this email is sent (the site's own mailer or
by hand) and that the list has each person's language.

### The rest of launch night

- Reply to every "اشتركت" with a thank-you and ask them to post their first
  Pro export; quote-tweet the first three.
- If a payment fails for someone, answer in public that you are on it and
  move to DMs. A fast fix in the open sells more than the video does.
- 11 pm: one tweet with a real number if it is a good one ("أول 20 مؤسس 🤍").

## 7. The new TifoMaker accounts

One new Gmail, used only for these. Same handle on X, TikTok and YouTube
(first choice `@tifomaker`, then `@tifomakerorg`). Same avatar (the site's
icon), same header (the Free vs Pro image's top half or a Match Day frame),
bio: "صمّم تيفو ناديك وشوفه في ملعبه 3D. مجاناً. tifomaker.org".

Your personal X stays the voice. The brand account's job in week one is to
look alive and to be the place the videos live.

| Day | X (brand) | TikTok and Shorts |
|---|---|---|
| 1 | Pinned intro tweet + a 10 s Match Day clip. Repost your announcement | Video 1 at 9:16 |
| 2 | Repost perk video 1. One "tifo of the day" from the community page (with the maker's handle) | Video 2 |
| 3 | Repost perk video 2 | A 12 s "صمّم تيفو في دقيقة" screen recording, no Pro in it |
| L | Repost the launch tweet; post the launch video natively too | Launch video |
| L+1 → L+4 | Repost each perk video; one community tifo a day | One perk video a day |

- The brand account **reposts** your tweets and does not copy them, so the
  replies stay under your tweet where the numbers are.
- Follow 30 to 50 relevant accounts in the first days (clubs, fan groups,
  designers); a new account that follows nobody looks like a bot.
- Do not post the price question from the brand account: one place for
  answers.

### Cross-posting the perk videos

- Each Remotion composition renders twice: 4:5 without voice for X, 9:16
  with the ElevenLabs Arabic voiceover for Shorts and TikTok.
- Upload the file natively to each platform. Never upload a file that has
  another platform's watermark on it.
- Keep titles and captions inside the middle of the 9:16 frame: TikTok and
  Shorts cover the bottom fifth and the right edge with their own buttons.
- Shorts: under 60 s, title in Arabic with the club or league name in it,
  `#Shorts` not needed. TikTok: 3 to 5 hashtags (#تيفو #دوري_روشن #مدرج
  plus the club in the video).
- These accounts start at zero and reach football fans slowly. Their value
  this week is that the videos exist somewhere with a link; the sales come
  from your X.

## 8. What I need from you to start building

1. Answers to section 0 (the five mismatches).
2. The club and stadium for the series' main tifo, or pick one from your
   own projects.
3. The raw recordings and exported files listed under each video. Video 1's
   three files first.
4. A yes to installing Remotion (the official plugin, and the `remotion`
   packages in a `marketing/video-src/` folder, outside the site's code).
5. The ElevenLabs API key, when we reach the first Shorts cut. Not needed
   for X.
6. The mutuals list (see the message: I cannot reach your Chrome from this
   session).
