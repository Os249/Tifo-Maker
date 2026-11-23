# Prompt for the local posting session

Copy everything below the line into a new local Claude Code session that has
Claude in Chrome turned on and this repository open. It posts or schedules only
what you have approved in the Social HQ, and only after checking it is signed in
to TifoMaker's own accounts.

---

You are posting TifoMaker's approved social media posts from my Chrome. Work
carefully: these go out publicly under the brand's name and cannot be taken back
once people have seen them.

## Hard rules

1. **Only approved posts.** A post goes out only if its status in the Social HQ is
   "approved". Anything waiting, needing changes or skipped is left alone.
2. **Text exactly as approved.** Copy the post and reply text character for
   character from `marketing/social/hq/data.json`. Do not rewrite, translate, add
   emoji or hashtags, or "improve" anything. The only change you may make is
   filling a `[placeholder]` with a value I give you in this chat; if a post still
   has a placeholder and I haven't given you the value, skip it and tell me.
3. **Right account or nothing.** Before touching a platform, confirm the signed-in
   account is TifoMaker's (checks below). If it's a different account, or signed
   out, stop and ask me to sign in. Never type a password, a code or any login
   details yourself, and never switch accounts on your own.
4. **Ask once before publishing.** Before the first post or schedule of the
   session, show me the full list of what you are about to publish (platform,
   post id, time, text, media file) and wait for my "go". After that you may work
   through the list without asking again, unless something differs from what I
   approved.
5. **Stop when unsure.** If a page looks different from what's described here, a
   button is missing, an upload fails, or anything asks for payment, permissions or
   a confirmation you don't understand, stop and tell me what you see. Don't work
   around it.
6. **Times are Riyadh time** (Asia/Riyadh, UTC+3). Check the time zone each
   scheduler uses before setting a time.

## Step 1: get the latest posts and approvals

1. `git fetch origin claude/tifo-social-media-strategy-g1psvc` and check that branch
   out (or merge it), so `marketing/social/hq/data.json` and the media files are
   current.
2. Read the approvals from the Social HQ artifact,
   https://claude.ai/artifact/5xf59cBrzQEEeYv5W8mxEM. Use the ArtifactData tool to list
   the `reviews` collection (each document id is a post id, with `status` and `note`)
   and the `media` collection (files I uploaded to a post's card). If you can't read
   it, ask me to paste the list of approved post ids.
3. Build the list: approved posts whose time is in the next 10 days, whose media
   exists, and whose "Before posting" condition is met. For fixture-dependent
   posts, check the match date and opponent on spl.com.sa first; if it has moved,
   skip the post and tell me.
4. Show me the list (rule 4) and wait.

## Step 2: check each account

Open each in a new tab and check before doing anything else on it:

| Platform | Open | It must show |
|---|---|---|
| X | https://x.com/home, then your profile | The profile URL is `x.com/tifomaker` and the handle shown is `@tifomaker` |
| TikTok | https://www.tiktok.com/tiktokstudio | The account in TikTok Studio is `@tifomaker` |
| YouTube | https://studio.youtube.com | The channel is TifoMaker with the handle `@tifomaker` |

If any check fails, stop and tell me which.

## Step 3: post or schedule

### X
1. Open the composer. Paste the post text. Attach the media file(s) listed for the
   post, in the order listed.
2. If the post has a "First reply", it has to go out as a reply to the post, not
   inside it. X's scheduler may not schedule a reply. If it doesn't, post the main
   post at its time (schedule it), and tell me the time so I can add the reply, or
   come back and add the reply yourself right after it goes live if I've asked you
   to stay.
3. To schedule, use the calendar icon in the composer and set the date and time.
   If there is no scheduling option on this account, tell me instead of posting now.
4. Pin x-01 to the profile once it is live (profile, the post's menu, "Pin to your
   profile").

### TikTok (TikTok Studio on the web)
1. Upload the video. Paste the caption text, then the hashtags at the end.
2. Pick a cover frame from the first second.
3. Schedule it for the post's time if the option is there (TikTok Studio allows
   scheduling a few days ahead). Otherwise tell me.
4. **Trending sounds** can only be added properly in the phone app. If a post's
   notes say to add a trending sound, do not post it from the web: tell me, and I'll
   post that one from my phone.
5. After it is up, post the pinned comment and pin it (if the post has one).

### YouTube (YouTube Studio)
1. Upload the video. Title and description from the post, Arabic.
2. Under the video's languages, add the English title and description where the
   post gives one. Don't put both languages in the same box.
3. Add it to the playlist named in the post. Visibility: Schedule, at the post's
   time.
4. For yt-01 (channel setup): Customisation, Branding: banner
   `marketing/social/hq/media/yt-banner.jpg`; Profile: Arabic description, then
   "Add language" for the English one; Layout: channel trailer for people who
   haven't subscribed = the promo video.

## Step 4: report

1. Add a line per post to `marketing/social/POSTING-LOG.md`: date, post id, platform,
   posted or scheduled, time, and the link.
2. In the Social HQ, update that post's document in the `reviews` collection with
   `posted: true`, `postedAt` and `link` (use ArtifactData `update`, keeping
   `status` as it is).
3. Tell me in a short list what went out, what is scheduled, and what was skipped
   and why.
