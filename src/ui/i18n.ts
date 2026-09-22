/**
 * Bilingual i18n (English + Saudi-dialect Arabic) with full RTL support.
 *
 * The Arabic is intentionally colloquial Saudi — the way fans on the curva
 * actually talk — not formal MSA. e.g. "ببلاش" (free) over "مجاناً",
 * "صمّم" / "سوّي" phrasing, "تشوفه" over "مشاهدته".
 *
 * One source of truth: every translatable string has a key. The landing page
 * marks elements with data-i18n; the editor calls t(key). Switching language
 * flips <html dir/lang>, persists the choice, and re-applies the DOM.
 */

import { PASSWORD_MAX, PASSWORD_MIN } from '../core/password';

export type Lang = 'en' | 'ar';

const STRINGS: Record<string, { en: string; ar: string }> = {
  // ---- nav / chrome ----
  'nav.how': { en: 'How it works', ar: 'كيف يشتغل' },
  'nav.features': { en: 'Features', ar: 'المميزات' },
  'nav.clubs': { en: 'For clubs', ar: 'للأندية' },
  'nav.openEditor': { en: 'Open the editor', ar: 'افتح المحرر' },
  'nav.community': { en: 'Community', ar: 'المجتمع' },
  'nav.terms': { en: 'Terms', ar: 'الشروط' },
  'nav.privacy': { en: 'Privacy', ar: 'الخصوصية' },
  'nav.legal': { en: 'Legal', ar: 'الشروط والخصوصية' },
  // ---- slimmed sign-in / sign-up ----
  'auth.identity': { en: 'Email or username', ar: 'البريد أو اسم المستخدم' },
  'auth.identityPh': { en: 'you@example.com', ar: 'you@example.com' },
  'auth.errIdentity': { en: 'Enter your email or username.', ar: 'اكتب بريدك أو اسم المستخدم.' },
  'auth.termsInline': {
    en: 'By creating an account you agree to the',
    ar: 'بإنشائك حساب فأنت توافق على',
  },

  // ---- save / draft / publish (the rebuilt save flow) ----
  'ed.obj.x': { en: 'Across', ar: 'أفقي' },
  'ed.obj.y': { en: 'Up', ar: 'رأسي' },
  'common.close': { en: 'Close', ar: 'إغلاق' },
  'common.cancel': { en: 'Cancel', ar: 'إلغاء' },
  'common.optional': { en: 'optional', ar: 'اختياري' },

  'ed.publish': { en: 'Publish to the community', ar: 'انشره في المجتمع' },
  'ed.downloadCopy': { en: 'Download a .tifo copy', ar: 'نزّل نسخة .tifo' },

  // Deliberately says "in this browser", not "saved". It is localStorage, and
  // browsers do clear it; promising more than that is how people lose work.
  'draft.savedLocal': { en: 'Saved in this browser', ar: 'محفوظ في هذا المتصفح' },
  'draft.savedAccount': { en: 'Saved to your account', ar: 'محفوظ في حسابك' },
  'draft.full': {
    en: 'This browser is out of storage, so your work is not being kept here. Download a .tifo copy.',
    ar: 'ذاكرة المتصفح ممتلئة، فشغلك ما ينحفظ هنا. نزّل نسخة .tifo.',
  },
  'draft.blocked': {
    en: 'This browser is blocking storage, so your work is not being kept here. Download a .tifo copy.',
    ar: 'المتصفح يمنع التخزين، فشغلك ما ينحفظ هنا. نزّل نسخة .tifo.',
  },
  'save.toAccount': { en: 'Saved to your account', ar: 'انحفظ في حسابك' },
  'save.claimed': { en: 'Your tifo is now in your account', ar: 'تيفوك صار في حسابك' },
  'save.claiming': { en: 'Moving your tifo into your account...', ar: 'ننقل تيفوك إلى حسابك...' },
  'save.failed': { en: 'Save failed', ar: 'فشل الحفظ' },
  'save.localFailed': {
    en: 'This browser will not keep your tifo. Download a .tifo copy so you do not lose it.',
    ar: 'هذا المتصفح ما راح يحفظ تيفوك. نزّل نسخة .tifo عشان ما يضيع.',
  },

  'offer.lead': {
    en: 'Your tifo is kept in this browser. Create a free account to keep it anywhere, on any device.',
    ar: 'تيفوك محفوظ في هذا المتصفح. سوّ حساب مجاني عشان يبقى معك في أي جهاز.',
  },
  'offer.cta': { en: 'Create a free account', ar: 'سوّ حساب مجاني' },
  'offer.later': { en: 'Not now', ar: 'مو الحين' },

  'publish.aria': { en: 'Publish your tifo', ar: 'انشر تيفوك' },
  'publish.h': { en: 'Publish to the community', ar: 'انشره في المجتمع' },
  'publish.updateH': { en: 'Update your published tifo', ar: 'حدّث تيفوك المنشور' },
  'publish.lead': {
    en: 'This goes in the community feed for others to see and remix.',
    ar: 'بيظهر في مجتمع التصاميم عشان يشوفونه ويعيدون تصميمه.',
  },
  'publish.title': { en: 'Name', ar: 'الاسم' },
  'publish.titlePh': { en: 'e.g. Riyadh derby, north stand', ar: 'مثلاً: ديربي الرياض، المدرج الشمالي' },
  'publish.titleHint': {
    en: 'This is the page title people see when your tifo is shared or found in search.',
    ar: 'هذا هو العنوان اللي يشوفونه الناس لما ينشرون تيفوك أو يلقونه في البحث.',
  },
  'publish.tags': { en: 'Tags', ar: 'وسوم' },
  'publish.tagsPh': { en: 'e.g. serie-a, derby, black-gold', ar: 'مثلاً: دوري-روشن، ديربي، أسود-ذهبي' },
  'publish.tagsHint': { en: 'Comma separated. Helps people find your tifo.', ar: 'افصلها بفواصل. تساعد الناس يلقون تيفوك.' },
  'publish.desc': { en: "The story behind it", ar: 'القصة وراه' },
  'publish.descPh': { en: 'The match, the moment, what the display means…', ar: 'المباراة، اللحظة، وش يعني الاستعراض…' },
  'publish.allowRemix': { en: 'Let others remix this tifo', ar: 'اسمح للآخرين يعيدون تصميمه' },
  'publish.asTemplate': { en: 'Offer it as a starting template', ar: 'قدّمه كقالب للبداية' },
  'publish.cta': { en: 'Publish', ar: 'انشر' },
  'publish.updateCta': { en: 'Update', ar: 'حدّث' },
  'publish.done': { en: 'Published to the community feed', ar: 'اننشر في مجتمع التصاميم' },
  'publish.failed': { en: 'Publish failed', ar: 'فشل النشر' },

  // ---- the solo-dev credit on the landing page ----
  'maker.badge': { en: 'SOLO DEV', ar: 'مطوّر واحد' },
  'maker.title': { en: 'One person builds all of this.', ar: 'شخص واحد يبني هذا كله.' },
  'maker.body': {
    en: 'Every stadium, every seat, every line of code. TifoMaker is made and run by a single developer, not a company. There is no team behind the curtain and no support desk.',
    ar: 'كل ستاد، وكل مقعد، وكل سطر كود. تيفو ميكر يصنعه ويشغّله مطوّر واحد، مو شركة. ما فيه فريق خلف الكواليس ولا مركز دعم.',
  },
  'maker.invite': {
    en: 'So if something is broken, your stadium is missing, or you made a tifo you are proud of, come and say it. It reaches me directly.',
    ar: 'فإذا صار فيه خلل، أو ستادك ناقص، أو سويت تيفو تفتخر فيه، قل لي. توصلني مباشرة.',
  },
  'foot.contact': { en: 'Contact the dev', ar: 'تواصل مع المطوّر' },
  'foot.ai': { en: 'An independent project by one developer, built with the help of AI.', ar: 'مشروع مستقل من تطوير شخص واحد، بُني بمساعدة الذكاء الاصطناعي.' },
  'community.title': { en: 'The tifo community', ar: 'مجتمع التيفو' },
  'community.sub': {
    en: 'Discover displays from supporters worldwide. Like, comment, follow creators, and remix any tifo into your own.',
    ar: 'شوف استعراضات من مشجعين من كل العالم. سوِّ لايك، علّق، تابِع المصممين، وريمكس أي تيفو وخلّه لك.',
  },
  'community.recent': { en: 'Recent', ar: 'الأحدث' },
  'community.popular': { en: 'Most liked', ar: 'الأكثر إعجابًا' },
  'cm.remix': { en: 'Remix', ar: 'ريمكس' },
  'cm.share': { en: 'Share', ar: 'مشاركة' },
  'cm.filters': { en: 'Filters', ar: 'الفلاتر' },
  'cm.byTag': { en: 'Tag', ar: 'الوسم' },
  'cm.apply': { en: 'Apply', ar: 'تطبيق' },
  'cm.showN': { en: 'Show {n} tifos', ar: 'اعرض {n} تيفو' },
  'cm.noMatches': { en: 'Nothing matches that', ar: 'ما فيه شي يطابق هذا' },
  'cm.clearAll': { en: 'Clear all', ar: 'مسح الكل' },
  'cm.noneHere': { en: 'Nothing to filter by here yet.', ar: 'ما فيه شي تفلتر فيه هنا للحين.' },
  'cm.remove': { en: 'Remove', ar: 'إزالة' },
  'cm.close': { en: 'Close', ar: 'إغلاق' },
  'cm.byPeople': { en: 'By people', ar: 'من المصممين' },
  'cm.byColour': { en: 'Colour', ar: 'اللون' },
  'cm.byClub': { en: 'Club', ar: 'النادي' },
  'cm.allClubs': { en: 'All clubs', ar: 'كل الأندية' },
  'cm.colour.red': { en: 'Red', ar: 'أحمر' },
  'cm.colour.orange': { en: 'Orange', ar: 'برتقالي' },
  'cm.colour.yellow': { en: 'Yellow', ar: 'أصفر' },
  'cm.colour.green': { en: 'Green', ar: 'أخضر' },
  'cm.colour.cyan': { en: 'Cyan', ar: 'سماوي' },
  'cm.colour.blue': { en: 'Blue', ar: 'أزرق' },
  'cm.colour.purple': { en: 'Purple', ar: 'بنفسجي' },
  'cm.colour.pink': { en: 'Pink', ar: 'وردي' },
  'cm.colour.white': { en: 'White', ar: 'أبيض' },
  'cm.colour.black': { en: 'Black', ar: 'أسود' },
  'cm.colour.grey': { en: 'Grey', ar: 'رمادي' },
  'community.templates': { en: 'Templates', ar: 'قوالب' },
  // ---- For Clubs (B2B) ----
  'clubs.navCta': { en: 'Talk to us', ar: 'كلّمنا' },
  'clubs.eyebrow2': { en: 'For clubs · agencies · ultras syndicates', ar: 'للأندية · الوكالات · روابط الألتراس' },
  'clubs.h1': { en: 'Run the whole stand like a production.', ar: 'سيّر المدرج كله كأنه إنتاج محترف.' },
  'clubs.lead': {
    en: 'TifoMaker for Clubs gives official organizers the tools to design, simulate, and execute professional-grade tifo displays at scale: with your team, your branding, and your exact stadium.',
    ar: 'تيفو ميكر للأندية يعطي المنظّمين الرسميين أدوات لتصميم ومحاكاة وتنفيذ استعراضات تيفو بمستوى احترافي وبحجم كبير: مع فريقك، وهويتك، وملعبك بالضبط.',
  },
  'clubs.cta1': { en: 'Book a walkthrough', ar: 'احجز جولة تعريفية' },
  'clubs.cta2': { en: 'Try the editor free', ar: 'جرّب المحرر ببلاش' },
  'clubs.trust': { en: 'Built for 40k–100k seat venues · seat-accurate execution · RTL & multi-language', ar: 'مصمّم لملاعب من ٤٠ إلى ١٠٠ ألف مقعد · تنفيذ دقيق لكل مقعد · يدعم RTL وعدة لغات' },
  'clubs.f1.title': { en: 'Team collaboration', ar: 'تعاون الفريق' },
  'clubs.f1.body': { en: 'Bring designers, capos, and club staff into one shared workspace. Co-author displays, manage revisions, and align the whole section before a single card is printed.', ar: 'اجمع المصممين والكابوهات وموظفي النادي في مساحة عمل واحدة. صمّموا سوا، أداروا النسخ، ووحّدوا المدرج كامل قبل ما يُطبع ولا كرت.' },
  'clubs.f2.title': { en: 'White-labeling', ar: 'علامتك الخاصة' },
  'clubs.f2.body': { en: 'Put your club’s identity front and center. Branded editor, branded fan pages, and branded match-day instructions: your crest, your colors, your domain.', ar: 'خلّ هوية ناديك في الواجهة. محرر بعلامتك، صفحات مشجعين بعلامتك، وتعليمات يوم المباراة بعلامتك: شعارك، ألوانك، نطاقك.' },
  'clubs.f3.title': { en: 'Custom 3D stadium modeling', ar: 'نمذجة ملعبك ثلاثي الأبعاد' },
  'clubs.f3.body': { en: 'We model your actual venue (exact tiers, sections, and seat counts) so what you design in 3D is precisely what 60,000 fans will hold up on the day.', ar: 'نمذجة ملعبك الحقيقي (المدرجات والقطاعات وأعداد المقاعد بالضبط) عشان اللي تصممه ثلاثي الأبعاد هو بالضبط اللي بيرفعه ٦٠ ألف مشجع يوم المباراة.' },
  'clubs.s1': { en: 'seats per venue', ar: 'مقعد لكل ملعب' },
  'clubs.s2': { en: 'simulation before print', ar: 'محاكاة قبل الطباعة' },
  'clubs.s3': { en: 'per-seat fan instructions', ar: 'تعليمات لكل مقعد' },
  'clubs.s4': { en: 'native multi-language', ar: 'دعم لغات أصلي' },
  'clubs.contactTitle': { en: 'Let’s plan your next display.', ar: 'يلا نخطّط لاستعراضك الجاي.' },
  'clubs.contactBody': { en: 'Tell us about your club and what you’re planning. We’ll set up a walkthrough and a venue model tailored to your stadium.', ar: 'احكِ لنا عن ناديك وش تخطّط له. بنرتّب لك جولة ونموذج ملعب مفصّل على ملعبك.' },
  'clubs.check1': { en: 'Dedicated onboarding for your team', ar: 'تهيئة مخصّصة لفريقك' },
  'clubs.check2': { en: 'Your stadium modeled to seat-level accuracy', ar: 'ملعبك بدقة على مستوى المقعد' },
  'clubs.check3': { en: 'White-label fan pages & match-day exports', ar: 'صفحات مشجعين وتصدير يوم المباراة بعلامتك' },
  'clubs.fName': { en: 'Your name', ar: 'اسمك' },
  'clubs.fEmail': { en: 'Work email', ar: 'إيميل العمل' },
  'clubs.fOrg': { en: 'Club / organization', ar: 'النادي / الجهة' },
  'clubs.fType': { en: 'You are a…', ar: 'أنت…' },
  'clubs.typeClub': { en: 'Official club', ar: 'نادٍ رسمي' },
  'clubs.typeAgency': { en: 'Marketing agency', ar: 'وكالة تسويق' },
  'clubs.typeUltras': { en: 'Ultras / supporters group', ar: 'ألتراس / رابطة مشجعين' },
  'clubs.typeOther': { en: 'Other', ar: 'غير ذلك' },
  'clubs.fMsg': { en: 'What are you planning?', ar: 'وش تخطّط له؟' },
  'clubs.submit': { en: 'Request a walkthrough', ar: 'اطلب جولة تعريفية' },
  'clubs.footHome': { en: 'Home', ar: 'الرئيسية' },
  'nav.developers': { en: 'Developers', ar: 'المطورين' },

  // ---- hero ----
  'hero.eyebrow': { en: 'The global platform for stadium choreography', ar: 'منصة تصميم استعراضات المدرجات للعالم كله' },
  'hero.title1': { en: 'Design the display', ar: 'صمّم الاستعراض' },
  'hero.title2': { en: '60,000 fans', ar: '٦٠٬٠٠٠ مشجع' },
  'hero.title3': { en: 'will never forget.', ar: 'ما راح ينسونه' },
  'hero.sub': {
    en: 'TifoMaker is the all-in-one platform to design your stadium tifo, watch it light up the stands in 3D, and export the seat-by-seat instructions that make it real on match day.',
    ar: 'تيفو ميكر منصة متكاملة تصمّم فيها التيفو حق مدرجك، وتشوفه يضوّي المدرجات بتقنية ثلاثية الأبعاد، وتطلّع تعليمات مقعد بمقعد تخليه حقيقة يوم المباراة.',
  },
  'hero.ctaPrimary': { en: 'Start designing free', ar: 'ابدأ التصميم ببلاش' },
  'hero.ctaSecondary': { en: 'See how it works', ar: 'شوف كيف يشتغل' },
  'hero.noDownload': { en: 'No download. No account needed to start.', ar: 'بدون تحميل، وبدون حساب عشان تبدأ.' },
  'hero.mockLabel': { en: 'Live 3D preview · TV gantry view', ar: 'معاينة حية ثلاثية الأبعاد · من زاوية كاميرا الملعب' },

  // ---- value trio ----
  'value.paint.title': { en: 'Paint across the whole stadium', ar: 'ارسم على الملعب كله' },
  'value.paint.body': {
    en: 'A canvas built for 60,000 seats. Brushes, patterns, text in any language, logos, and full color control.',
    ar: 'لوحة مصمّمة لـ٦٠٬٠٠٠ مقعد. فرَش، وأنماط، ونصوص بأي لغة، وشعارات، وتحكّم كامل بالألوان.',
  },
  'value.3d.title': { en: 'See it in 3D before you print', ar: 'شوفه ثلاثي الأبعاد قبل لا تطبع' },
  'value.3d.body': {
    en: 'Rotate the stadium, play the card-reveal wave, and know exactly how it looks from the TV gantry.',
    ar: 'لِف الملعب، وشغّل موجة كشف الكروت، واعرف بالضبط كيف بيطلع من كاميرا الملعب.',
  },
  'value.logistics.title': { en: 'Turn it into match-day logistics', ar: 'حوّله لخطة جاهزة ليوم المباراة' },
  'value.logistics.body': {
    en: 'Export seat-by-seat sheets, volunteer guides, and exact card and bag counts. Every supporter knows their part.',
    ar: 'طلّع جداول مقعد بمقعد، وأدلّة للمتطوعين، وأعداد دقيقة للكروت والأكياس. كل مشجع يعرف دوره.',
  },

  // ---- how it works ----
  'how.title': { en: 'Three steps from idea to 60,000-card display', ar: 'ثلاث خطوات من الفكرة لاستعراض بـ٦٠٬٠٠٠ كرت' },
  'showcase.title': { en: 'Made with TifoMaker', ar: 'صُنع بتيفو ميكر' },
  'showcase.sub': { en: 'Real displays designed by supporters around the world. Tap any to explore it in 3D.', ar: 'استعراضات حقيقية صمّمها مشجعين من كل العالم. اضغط أي وحدة تشوفها ثلاثي الأبعاد.' },
  'showcase.browseAll': { en: 'Browse the community →', ar: 'تصفّح المجتمع ←' },
  // ---- tifo of the day (home page) ----
  'daily.badge': { en: 'Tifo of the day', ar: 'تيفو اليوم' },
  'daily.sub': {
    en: 'Picked from what the community published. A different one every day.',
    ar: 'مختار من اللي نشره المجتمع. كل يوم واحد جديد.',
  },
  'daily.view': { en: 'See it in 3D →', ar: 'شوفه ثلاثي الأبعاد ←' },
  'hero.previewBadge': { en: '✦ Preview Tifos', ar: '✦ استعرض التيفوهات' },
  // ---- match-day seat page (/s/:id) ----
  'seat.loading': { en: 'Loading the display…', ar: 'جاري تحميل الاستعراض…' },
  'seat.findTitle': { en: 'Find your seat to see which card to hold up.', ar: 'لقّ مقعدك عشان تعرف أي كرت ترفع.' },
  'seat.intro': { en: 'Find your seat to see which card to hold up.', ar: 'لقّ مقعدك عشان تعرف أي كرت ترفع.' },
  'seat.section': { en: 'Section', ar: 'القطاع' },
  'seat.sectionPick': { en: 'Choose your section…', ar: 'اختر قطاعك…' },
  'seat.row': { en: 'Row', ar: 'الصف' },
  'seat.rowPick': { en: 'Choose your row…', ar: 'اختر صفك…' },
  'seat.seat': { en: 'Seat number', ar: 'رقم المقعد' },
  'seat.seatPick': { en: 'Choose your seat…', ar: 'اختر مقعدك…' },
  'seat.seatN': { en: 'Seat', ar: 'مقعد' },
  'seat.showCard': { en: 'Show my card', ar: 'عرض كرتي' },
  'seat.madeWith': { en: 'Made with TifoMaker', ar: 'صُنع بتيفو ميكر' },
  'seat.holdUp': { en: 'HOLD UP', ar: 'ارفع' },
  'seat.raiseWhen': { en: 'Raise your card when your section is called.', ar: 'ارفع كرتك لمّا يجي دور قطاعك.' },
  'seat.noCardTitle': { en: 'No card here', ar: 'ما فيه كرت هنا' },
  'seat.noCardSub': { en: 'Your seat isn’t part of this display, just enjoy the show!', ar: 'مقعدك مو جزء من الاستعراض، استمتع بالعرض!' },
  'seat.changeSeat': { en: '‹ Change seat', ar: 'تغيير المقعد ›' },
  'seat.errNoCodeTitle': { en: 'No display code found', ar: 'ما فيه رمز للاستعراض' },
  'seat.errNoCodeBody': { en: 'This link looks incomplete. Ask your organiser for the correct QR or link.', ar: 'الرابط ناقص. اطلب من المنظّم رمز QR أو الرابط الصحيح.' },
  'seat.errLoadTitle': { en: 'Couldn’t load the display', ar: 'تعذّر تحميل الاستعراض' },
  'seat.errLoadBody': { en: 'It may be private or removed. Ask your organiser to publish it, then scan again.', ar: 'يمكن يكون خاص أو محذوف. اطلب من المنظّم ينشره، وبعدها امسح الرمز مرة ثانية.' },
  'seat.goHome': { en: 'Go to TifoMaker', ar: 'روح لتيفو ميكر' },
  'seat.rowLabel': { en: 'Row', ar: 'صف' },
  'hero.previewHint': { en: 'Drag to rotate · this is a live, interactive 3D preview', ar: 'اسحب عشان تدوّر · هذا عرض ثلاثي الأبعاد حي وتفاعلي' },
  'clubs.bodyLong': {
    en: 'Production-ready exports, volunteer logistics, and reusable templates for every match. Turn a design into a flawless 60,000-person execution: material counts, bag estimates, color specs, and per-section instruction sheets, all generated automatically.',
    ar: 'تصديرات جاهزة للإنتاج، وتنظيم للمتطوعين، وقوالب قابلة لإعادة الاستخدام لكل مباراة. حوّل التصميم إلى تنفيذ متقن لـ٦٠٬٠٠٠ شخص: أعداد المواد، تقديرات الأكياس، مواصفات الألوان، وأوراق تعليمات لكل قطاع، تتولّد كلها تلقائيًا.',
  },
  'supporters.lead': {
    en: 'Bring your group’s vision to life. Free to design, easy to share, built for the terrace. Publish to the community, remix others’ tifos, and rally your section around one image.',
    ar: 'حقّق رؤية مجموعتك. التصميم ببلاش، والمشاركة سهلة، ومبني للمدرجات. انشر للمجتمع، اعمل ريمكس لتيفوهات غيرك، ولمّ مدرجك حول صورة وحدة.',
  },
  'how.step1.title': { en: 'Build or select your stadium', ar: 'ابنِ ملعبك أو اختره' },
  'how.step1.body': {
    en: 'Pick your stadium, or match your real one. 40k, 60k, 76k, and custom geometries.',
    ar: 'اختر ملعبك، أو طابقه مع ملعبك الحقيقي. ٤٠ ألف، ٦٠ ألف، ٧٦ ألف، وأشكال مخصّصة.',
  },
  'how.step2.title': { en: 'Design the choreography', ar: 'صمّم الاستعراض' },
  'how.step2.body': {
    en: 'Paint your tifo. See it light up the stadium in 3D before you print a single card.',
    ar: 'ارسم التيفو حقك. وشوفه يضوّي الملعب ثلاثي الأبعاد قبل لا تطبع ولا كرت.',
  },
  'how.step3.title': { en: 'Export & mobilize', ar: 'صدّر وجهّز الفريق' },
  'how.step3.body': {
    en: 'Download seat-by-seat instructions. Every volunteer knows exactly which card to hold.',
    ar: 'نزّل تعليمات مقعد بمقعد. كل متطوع يعرف بالضبط أي كرت يرفع.',
  },

  // ---- clubs ----
  'clubs.eyebrow': { en: 'For clubs & organizers', ar: 'للأندية والمنظّمين' },
  'clubs.title': { en: 'Coordinate professional-grade displays.', ar: 'نسّق استعراضات بمستوى احترافي.' },
  'clubs.cta': { en: 'Try the production export', ar: 'جرّب تصدير الإنتاج' },
  'clubs.stat1': { en: 'seats per display', ar: 'مقعد لكل استعراض' },
  'clubs.stat2sub': { en: 'simulation before print', ar: 'محاكاة قبل الطباعة' },
  'clubs.stat3sub': { en: 'match-day logistics', ar: 'خطة يوم المباراة' },
  'clubs.tagline': { en: 'Built by fans, for the curva.', ar: 'من المشجعين، للمدرج.' },

  // ---- final CTA + footer ----
  'final.title': { en: 'Your next tifo starts now.', ar: 'تيفوك الجاي يبدأ الحين.' },
  'final.sub': {
    en: 'Design free in your browser: no download, no account needed to start.',
    ar: 'صمّم ببلاش من متصفحك: بدون تحميل، وبدون حساب عشان تبدأ.',
  },

  // ---- editor: header / views ----
  'ed.view.design': { en: 'Design', ar: 'تصميم' },
  'ed.view.banner': { en: 'Banner', ar: 'اللافتة' },
  'ed.view.bannerT': {
    en: 'Draw a banner: a printed sheet that hangs, drops or is pulled over the stand',
    ar: 'ارسم لافتة: قماش مطبوع ينسدل أو يُرفع أو ينسحب فوق المدرج',
  },
  'ed.view.stadium': { en: 'Stadium', ar: 'الملعب' },
  'ed.view.split': { en: 'Split', ar: 'مقسوم' },
  'ed.signup': { en: 'Sign up', ar: 'سجّل' },
  'ed.gallery': { en: 'Gallery', ar: 'المعرض' },
  'ed.viewProfile': { en: 'View profile', ar: 'الملف الشخصي' },
  'ed.signOut': { en: 'Sign out', ar: 'تسجيل الخروج' },
  'ed.replayTour': { en: 'Replay tutorial', ar: 'إعادة الجولة التعريفية' },
  'ed.moderate': { en: 'Moderate', ar: 'الإشراف' },
  'ed.docTitlePlaceholder': { en: 'Untitled tifo', ar: 'تيفو بدون اسم' },
  // ---- desktop-only gate (the editor below 900px) ----
  // Replaces the old 'you are on mobile' note. That note sat under a full
  // editor people could not actually use, which is how both phone bug reports
  // happened; the gate says it once, up front, and offers somewhere to go.
  'dt.title': { en: 'The editor needs a bigger screen', ar: 'المحرر يبي شاشة أكبر' },
  'dt.body': {
    en: 'Designing a tifo means painting tens of thousands of seats at once, so it needs a mouse and a wide screen. Open tifomaker.org on a laptop or a computer to design. A phone version is on the way.',
    ar: 'تصميم التيفو معناه تلوين عشرات الآلاف من الكراسي مرة وحدة، فيبي له ماوس وشاشة عريضة. افتح tifomaker.org على لابتوب أو كمبيوتر عشان تصمم. ونسخة الجوال جاية في الطريق.',
  },
  'dt.browse': { en: 'Browse community tifos', ar: 'تصفّح تيفوهات المجتمع' },
  'dt.home': { en: 'Back to the home page', ar: 'ارجع للصفحة الرئيسية' },
  'dt.copy': { en: 'Copy the link for later', ar: 'انسخ الرابط لبعدين' },
  'dt.copied': { en: 'Link copied', ar: 'اننسخ الرابط' },
  'dt.note': {
    en: 'Shared tifo links still open here — it is only the editor that needs a desktop.',
    ar: 'روابط التيفو المشاركة تفتح عندك عادي، المحرر بس هو اللي يبي كمبيوتر.',
  },
  // ---- cookie consent banner ----
  'consent.msg': { en: 'We use essential cookies to run TifoMaker, and (only with your consent) analytics to improve it.', ar: 'نستخدم ملفات تعريف ارتباط أساسية لتشغيل تيفو ميكر، وبموافقتك فقط نستخدم أدوات تحليل لتحسينه.' },
  'consent.learn': { en: 'Learn more', ar: 'اعرف أكثر' },
  'consent.essential': { en: 'Essential only', ar: 'الأساسية فقط' },
  'consent.all': { en: 'Accept all', ar: 'قبول الكل' },

  // ---- auth modal ----
  'auth.signin': { en: 'Sign in', ar: 'تسجيل الدخول' },
  'auth.signup': { en: 'Create account', ar: 'إنشاء حساب' },
  'auth.email': { en: 'Email', ar: 'البريد الإلكتروني' },
  'auth.emailPh': { en: 'you@example.com', ar: 'you@example.com' },
  'auth.password': { en: 'Password', ar: 'كلمة المرور' },
  'auth.passwordPh': { en: 'at least {min} characters', ar: '{min} خانة على الأقل' },
  'auth.signingIn': { en: 'Signing in…', ar: 'جارٍ تسجيل الدخول…' },
  'auth.creating': { en: 'Creating…', ar: 'جارٍ الإنشاء…' },
  'auth.note': { en: 'Designs are tied to your account. Your session lasts until you sign out or refresh.', ar: 'التصاميم مرتبطة بحسابك، وتبقى جلستك حتى تسجّل الخروج أو تُحدّث الصفحة.' },
  'auth.termsLink': { en: 'Terms', ar: 'الشروط' },
  'auth.and': { en: 'and', ar: 'و' },
  'auth.privacyLink': { en: 'Privacy Policy', ar: 'سياسة الخصوصية' },
  'auth.close': { en: 'Close', ar: 'إغلاق' },
  'auth.errEmail': { en: 'Please enter a valid email address.', ar: 'يرجى إدخال بريد إلكتروني صحيح.' },
  'auth.errPassword': { en: 'Password must be at least {min} characters.', ar: 'كلمة المرور لازم {min} خانة على الأقل.' },
  'auth.errInvalid': { en: 'Wrong username or password. New here? Create an account.', ar: 'اسم المستخدم أو كلمة المرور غير صحيحة. جديد هنا؟ أنشئ حسابًا.' },
  'auth.errTaken': { en: 'That username is taken: try another, or sign in.', ar: 'اسم المستخدم محجوز: جرّب اسمًا آخر أو سجّل الدخول.' },
  'verify.ok': { en: 'Email verified: thank you!', ar: 'تم تأكيد بريدك الإلكتروني: شكرًا!' },
  'verify.fail': { en: 'That verification link is invalid or has expired. You can resend it from your account.', ar: 'رابط التأكيد غير صالح أو منتهي الصلاحية. يمكنك إعادة إرساله من حسابك.' },
  'auth.forgot': { en: 'Forgot password?', ar: 'نسيت كلمة المرور؟' },
  'auth.sendReset': { en: 'Send reset link', ar: 'إرسال رابط إعادة التعيين' },
  'auth.backToSignin': { en: 'Back to sign in', ar: 'العودة لتسجيل الدخول' },
  'auth.forgotSent': { en: 'If that email has an account, a reset link is on its way.', ar: 'إذا كان لهذا البريد حساب، فإن رابط إعادة التعيين في طريقه إليك.' },
  'auth.sending': { en: 'Sending…', ar: 'جارٍ الإرسال…' },
  'ed.changePassword': { en: 'Change password', ar: 'تغيير كلمة المرور' },
  // ---- picking a handle after a provider sign-up ----
  'un.title': { en: "You're in. Now pick your name.", ar: 'تم تسجيلك. باقي تختار اسمك.' },
  'un.note': {
    en: 'This is how you appear on every tifo you publish. 3 to 24 characters: letters, numbers and underscores.',
    ar: 'هذا اللي يظهر على كل تيفو تنشره. من ٣ إلى ٢٤ خانة: حروف وأرقام و_.',
  },
  'un.label': { en: 'Username', ar: 'اسم المستخدم' },
  'un.placeholder': { en: 'curva_north', ar: 'curva_north' },
  'un.save': { en: 'Save and continue', ar: 'احفظ وكمّل' },
  'un.saving': { en: 'Saving…', ar: 'يحفظ…' },
  'un.invalid': { en: '3 to 24 characters: letters, numbers and underscores.', ar: 'من ٣ إلى ٢٤ خانة: حروف وأرقام و_.' },
  'un.taken': { en: 'That name is taken. Try another.', ar: 'الاسم محجوز. جرّب غيره.' },
  'un.signout': { en: 'Sign out instead', ar: 'سجّل الخروج بدال' },
  'err.needsUsername': {
    en: 'Pick a username to finish setting up your account.',
    ar: 'اختر اسم مستخدم عشان تكمّل إعداد حسابك.',
  },
  // ---- signing in with a provider (src/core/../server/src/oauth.ts) ----
  'auth.google': { en: 'Continue with Google', ar: 'المتابعة بحساب Google' },
  'auth.or': { en: 'or', ar: 'أو' },
  'auth.inApp': {
    en: 'Google will not open inside this app. Open tifomaker.org in Chrome or Safari to use it.',
    ar: 'Google ما يفتح جوه هذا التطبيق. افتح tifomaker.org في Chrome أو Safari عشان تستخدمه.',
  },
  'auth.err.state': {
    en: 'That sign-in took too long or was started somewhere else. Try again.',
    ar: 'محاولة الدخول انتهت مدتها أو بدأت من مكان ثاني. جرّب مرة ثانية.',
  },
  'auth.err.cancelled': { en: 'Sign-in cancelled.', ar: 'تم إلغاء تسجيل الدخول.' },
  'auth.err.inapp': {
    en: 'Google will not run sign-in inside this app. Open tifomaker.org in Chrome or Safari and try again.',
    ar: 'Google ما يشغّل تسجيل الدخول جوه هذا التطبيق. افتح tifomaker.org في Chrome أو Safari وجرّب مرة ثانية.',
  },
  'auth.err.provider': {
    en: 'We could not reach Google just then. Try again, or use your email and password.',
    ar: 'ما قدرنا نوصل Google الحين. جرّب مرة ثانية، أو استخدم بريدك وكلمة المرور.',
  },
  'auth.err.verify_first': {
    en: 'An account already uses that email. Sign in with your password first, then connect Google from your account page.',
    ar: 'في حساب مستخدم نفس البريد. سجّل دخولك بكلمة المرور أول، وبعدها اربط Google من صفحة حسابك.',
  },
  'auth.err.linked_elsewhere': {
    en: 'That Google account is already connected to a different TifoMaker account.',
    ar: 'حساب Google هذا مربوط بحساب TifoMaker ثاني.',
  },
  'ac.link.title': { en: 'Connected accounts', ar: 'الحسابات المربوطة' },
  'ac.link.note': {
    en: 'Another way to sign in, alongside your password. Removing the last one is refused, so an account can never be left with no way in.',
    ar: 'طريقة ثانية لتسجيل الدخول مع كلمة المرور. ما نسمح بحذف آخر طريقة، عشان ما يصير حساب بدون أي طريقة دخول.',
  },
  'ac.link.add': { en: 'Connect', ar: 'اربط' },
  'ac.link.remove': { en: 'Disconnect', ar: 'فك الربط' },
  'ac.link.added': { en: 'Connected.', ar: 'تم الربط.' },
  'ac.link.removed': { en: 'Disconnected.', ar: 'تم فك الربط.' },
  'ac.pw.titleSet': { en: 'Set a password', ar: 'عيّن كلمة مرور' },
  'ac.pw.noteSet': {
    en: 'You signed up with Google, so you have no password yet. Setting one gives you a second way in.',
    ar: 'سجّلت بحساب Google، فما عندك كلمة مرور. تعيين وحدة يعطيك طريقة دخول ثانية.',
  },
  'ac.pw.setSave': { en: 'Set password', ar: 'عيّن كلمة المرور' },
  'err.lastMethod': {
    en: 'Set a password first — this is the only way you can sign in.',
    ar: 'عيّن كلمة مرور أول — هذي طريقتك الوحيدة لتسجيل الدخول.',
  },
  // ---- choosing a password (src/ui/passwordField.ts) ----
  // No key here spells the minimum out as a literal: it arrives as {min} from
  // src/core/password.ts, so raising the bar is one constant and not a hunt
  // through two languages' worth of copy.
  'pw.tip': {
    en: 'At least {min} characters. Four unrelated words beat one clever word.',
    ar: '{min} خانة على الأقل. أربع كلمات ما لها علاقة ببعض أقوى من كلمة وحدة "ذكية".',
  },
  'pw.hint.short': { en: '{n} more to go', ar: 'باقي {n}' },
  'pw.ph': { en: 'at least {min} characters', ar: '{min} خانة على الأقل' },
  'pw.confirm': { en: 'Confirm password', ar: 'أكّد كلمة المرور' },
  'pw.show': { en: 'Show password', ar: 'إظهار كلمة المرور' },
  'pw.hide': { en: 'Hide password', ar: 'إخفاء كلمة المرور' },
  'pw.suggest': { en: 'Suggest one', ar: 'اقترح لي وحدة' },
  'pw.level1': { en: 'Weak', ar: 'ضعيفة' },
  'pw.level2': { en: 'Fair', ar: 'مقبولة' },
  'pw.level3': { en: 'Good', ar: 'جيدة' },
  'pw.level4': { en: 'Strong', ar: 'قوية' },
  'pw.err.blank': { en: 'Enter a password.', ar: 'اكتب كلمة المرور.' },
  'pw.err.short': { en: 'Password must be at least {min} characters.', ar: 'كلمة المرور لازم {min} خانة على الأقل.' },
  'pw.err.long': { en: 'Password must be at most {max} characters.', ar: 'كلمة المرور {max} خانة كحد أقصى.' },
  'pw.err.digits': { en: 'Numbers alone are easy to guess — add some words.', ar: 'أرقام بس سهلة التخمين — زِد كلمات.' },
  'pw.err.repeated': { en: 'That is the same thing over and over.', ar: 'هذي نفس الشي متكرر.' },
  'pw.err.sequence': { en: 'That is a straight run of letters or keys.', ar: 'هذي مجرد تسلسل حروف أو أزرار.' },
  'pw.err.context': { en: 'Leave your email and username out of it.', ar: 'لا تحط فيها بريدك ولا اسم المستخدم.' },
  'pw.err.common': { en: 'Too easy to guess — try a few unrelated words.', ar: 'سهلة التخمين — جرّب كم كلمة ما لها علاقة ببعض.' },
  'pw.err.mismatch': { en: 'The two passwords do not match.', ar: 'كلمتا المرور ما تطابقن.' },
  'cp.current': { en: 'Current password', ar: 'كلمة المرور الحالية' },
  'cp.new': { en: 'New password', ar: 'كلمة المرور الجديدة' },
  'cp.submit': { en: 'Update password', ar: 'تحديث كلمة المرور' },
  'cp.done': { en: 'Password updated.', ar: 'تم تحديث كلمة المرور.' },
  'cp.err': { en: 'Could not update password.', ar: 'تعذّر تحديث كلمة المرور.' },
  'addemail.title': { en: 'Add your email', ar: 'أضف بريدك الإلكتروني' },
  'addemail.body': { en: 'The AI Designer needs a verified email. Add yours and I will send a verification link.', ar: 'يحتاج مصمم الذكاء الاصطناعي إلى بريد إلكتروني مُؤكَّد. أضف بريدك وسأرسل لك رابط التأكيد.' },
  'addemail.submit': { en: 'Add email', ar: 'إضافة البريد' },
  'addemail.sent': { en: 'Check your inbox for the verification link.', ar: 'تحقق من بريدك للعثور على رابط التأكيد.' },
  'addemail.err': { en: 'Could not save email.', ar: 'تعذّر حفظ البريد.' },
  'ed.exportData': { en: 'Export my data', ar: 'تصدير بياناتي' },
  'ed.deleteAccount': { en: 'Delete account', ar: 'حذف الحساب' },
  'ed.deleteConfirm': { en: 'Permanently delete your account and all your designs? This cannot be undone.', ar: 'حذف حسابك وجميع تصاميمك نهائيًا؟ لا يمكن التراجع عن هذا الإجراء.' },

  // ---- editor: tool bars / panels ----
  'ed.props': { en: 'Properties', ar: 'الخصائص' },
  // Deliberately says "the canvas", not "the canvas at left": the panel is on
  // the left in English and on the right in Arabic, so a direction word here is
  // wrong half the time.
  'ed.props.hint': {
    en: 'Paint on the canvas. These panels set how you paint and the look. Switch Design / Banner / Stadium / Split above to paint seats, draw a banner, or see either in 3D.',
    ar: 'ارسم على اللوحة. هذي اللوحات تتحكم بطريقة الرسم والشكل. بدّل بين تصميم / اللافتة / الملعب / مقسوم فوق عشان ترسم على المقاعد أو ترسم لافتة أو تشوفهم ثلاثي الأبعاد.',
  },
  'ed.brush': { en: 'Brush', ar: 'الفرشاة' },
  'ed.brush.activeTool': { en: 'active tool', ar: 'الأداة الحالية' },
  'ed.brush.mirror': { en: 'Mirror', ar: 'انعكاس' },
  'ed.brush.fillScope': { en: 'Fill scope', ar: 'نطاق التعبئة' },
  'ed.colors': { en: 'Colors', ar: 'الألوان' },
  'ed.colors.yourSwatches': { en: 'your swatches', ar: 'ألوانك' },
  'ed.colors.painting': { en: 'painting color', ar: 'لون الرسم' },
  'ed.colors.addColor': { en: '+ Color', ar: '+ لون' },
  'ed.colors.hint': {
    en: 'Tap the colour square to try any colour, then “+ Color” to keep it · tap a swatch to paint with it · press and hold a swatch to edit or remove it.',
    ar: 'اضغط المربّع عشان تجرّب أي لون، وبعدين «+ لون» عشان تحتفظ فيه · اضغط لون عشان ترسم فيه · استمر بالضغط على اللون عشان تعدّله أو تشيله.',
  },
  'ed.colors.edit': { en: 'Edit swatch', ar: 'تعديل اللون' },
  'ed.colors.notAdded': { en: 'not added yet — press + Color', ar: 'ما أُضيف بعد — اضغط + لون' },
  'ed.colors.remove': { en: 'Remove', ar: 'إزالة' },
  'ed.colors.inUse': {
    en: 'That colour is painted on {n} seats — recolour them before removing it.',
    ar: 'هذا اللون مرسوم على {n} مقعد — غيّر لونها قبل ما تشيله.',
  },
  'ed.colors.lastTwo': {
    en: 'A design needs at least one colour besides the empty seat.',
    ar: 'التصميم يحتاج لون واحد على الأقل غير المقعد الفاضي.',
  },
  'ed.colors.presets': { en: 'Presets', ar: 'جاهزة' },
  'ed.colors.choosePreset': { en: 'Choose a preset…', ar: 'اختر مجموعة جاهزة…' },
  'ed.colors.import': { en: 'Import palette', ar: 'استورد لوحة ألوان' },
  'ed.colors.save': { en: 'Save palette', ar: 'احفظ لوحة الألوان' },
  'ed.colors.noSaved': { en: 'No saved palettes yet', ar: 'ما عندك لوحات ألوان محفوظة' },
  'ed.colors.savedPlaceholder': { en: 'Your saved palettes…', ar: 'لوحات الألوان حقتك…' },
  'ed.stadium': { en: 'Stadium', ar: 'الملعب' },
  'ed.stadium.tag': { en: 'shape & whole-bowl fills', ar: 'الشكل وتعبئة المدرج كامل' },
  'ed.stadium.guides': { en: 'Section guides', ar: 'حدود القطاعات' },
  // In-product feedback. Deliberately conversational: this is a person telling
  // one developer that something broke, not filing a ticket.
  'fb.entry': { en: 'Feedback', ar: 'ملاحظات' },
  'fb.aria': { en: 'Send feedback', ar: 'أرسل ملاحظة' },
  'fb.h': { en: 'Tell me what happened', ar: 'قل لي وش صار' },
  'fb.lead': {
    en: 'This goes straight to me, the only person who works on TifoMaker. I read everything.',
    ar: 'يوصلني أنا مباشرة، وأنا الوحيد اللي يشتغل على تيفو ميكر. أقرأ كل شي يوصلني.',
  },
  'fb.kindAria': { en: 'What kind of feedback', ar: 'نوع الملاحظة' },
  'fb.bug': { en: 'Something broke', ar: 'شي خربان' },
  'fb.idea': { en: 'I want a feature', ar: 'أبغى ميزة' },
  'fb.other': { en: 'Something else', ar: 'شي ثاني' },
  'fb.what': { en: 'What happened?', ar: 'وش صار؟' },
  'fb.whatPh': { en: 'The save button does nothing on my phone...', ar: 'زر الحفظ ما يشتغل في جوالي...' },
  'fb.ideaPh': { en: 'It would help if I could...', ar: 'بيساعدني لو أقدر...' },
  'fb.otherPh': { en: 'Anything at all.', ar: 'أي شي تبي تقوله.' },
  'fb.steps': { en: 'What were you doing?', ar: 'وش كنت تسوي؟' },
  'fb.stepsPh': { en: 'I painted the north stand, then pressed Save', ar: 'لونت المدرج الشمالي، وبعدين ضغطت حفظ' },
  'fb.email': { en: 'Your email', ar: 'إيميلك' },
  'fb.emailPh': { en: 'you@example.com', ar: 'you@example.com' },
  'fb.emailHint': {
    en: 'Only so I can reply or ask a follow-up question. Leave it blank and I still get the report.',
    ar: 'بس عشان أرد عليك أو أسألك سؤال. اتركه فاضي وبيوصلني التقرير عادي.',
  },
  'fb.attach': { en: 'Attach what I need to reproduce it: ', ar: 'أرفق اللي أحتاجه عشان أجرب المشكلة: ' },
  'fb.send': { en: 'Send', ar: 'أرسل' },
  'fb.sending': { en: 'Sending...', ar: 'يرسل...' },
  'fb.errEmpty': { en: 'Tell me a little more than that.', ar: 'قل لي شوي أكثر من كذا.' },
  'fb.errSend': { en: 'That did not send:', ar: 'ما انرسل:' },
  'fb.thanksH': { en: 'Got it', ar: 'وصلني' },
  'fb.thanks': { en: 'Thank you. This genuinely helps.', ar: 'شكراً لك. هذا يساعدني فعلاً.' },
  'fb.thanksReply': { en: 'Thank you. I will reply if I need more detail.', ar: 'شكراً لك. بأرد عليك لو احتجت تفاصيل أكثر.' },
  'fb.done': { en: 'Close', ar: 'إغلاق' },
  'ed.save': { en: 'Save', ar: 'احفظ' },
  'ed.saveTitle': { en: 'Save your tifo', ar: 'احفظ تيفوك' },
  'ed.openFile': { en: 'Open file', ar: 'افتح ملف' },
  'ed.publicList': { en: 'List in public gallery', ar: 'انشره في المعرض العام' },
  'ed.addPhoto': { en: 'Add match-day photo', ar: 'أضف صورة يوم المباراة' },
  'ed.addPhoto.hint': { en: 'Show the real stand beside your design, proof it came to life.', ar: 'اعرض المدرج الحقيقي جنب تصميمك، إثبات إنه صار حقيقة.' },
  'ed.share': { en: 'Share', ar: 'شارك' },
  'ed.save.tag': { en: '& share', ar: 'والمشاركة' },

  // ---- editor: stadium config / area / orientation ----
  'ed.cfg.tag': { en: 'choose & configure the bowl', ar: 'اختر وجهّز المدرج' },
  'ed.cfg.hint': { en: 'Pick the stadium your tifo is designed for. Switching remaps your current design onto the new bowl.', ar: 'اختر الملعب اللي تصمّم له تيفوك. لما تبدّل، ينتقل تصميمك الحالي على المدرج الجديد.' },
  'ed.area': { en: 'Active tifo area', ar: 'منطقة التيفو' },
  'ed.area.hint': { en: 'Which part of the bowl the design targets, the AI focuses here.', ar: 'أي جزء من المدرج يستهدفه التصميم، الذكاء يركّز هنا.' },
  'ed.orient': { en: 'Orientation', ar: 'الاتجاه' },
  'ed.orient.hint': { en: 'Re-orient your design around the bowl (undoable).', ar: 'لِف تصميمك حول المدرج (يمكن التراجع).' },
  'ed.review': { en: 'Admin · review queue', ar: 'الإدارة · قائمة المراجعة' },
  'ed.review.hint': { en: 'Pending community submissions. Approve to publish, reject to discard.', ar: 'مشاركات المجتمع المعلّقة. وافق للنشر، أو ارفض للحذف.' },

  // ---- editor: AI panel ----
  'ed.ai.title': { en: 'AI Designer', ar: 'مصمّم الذكاء' },
  'ed.ai.tag': { en: 'describe it, get a tifo', ar: 'صِفه، وخذ تيفو' },
  'ed.ai.hint': { en: 'Describe a display in plain words: a stand, colours, text, a symbol. The AI composes a fully editable tifo on the seats.', ar: 'صِف الاستعراض بكلامك: مدرج، ألوان، نص، شعار. الذكاء يركّب لك تيفو كامل وقابل للتعديل على المقاعد.' },
  'ed.ai.placeholder': { en: 'e.g. Giant eagle covering the south stand in black and gold', ar: 'مثال: نسر ضخم يغطّي المدرج الجنوبي بالأسود والذهبي' },
  'ed.ai.generate': { en: 'Generate tifo', ar: 'صمّم تيفو' },
  'ed.ai.yourClub': { en: 'Your club: one tap', ar: 'ناديك: بضغطة واحدة' },
  'ed.drawHint': { en: 'Draw here: watch it fill the stadium →', ar: 'ارسم هنا: وشوفه يملأ الملعب ←' },
  'ed.matchDayHint': { en: 'Now watch it come alive ▲', ar: 'الحين شوفه يصير حقيقي ▲' },
  'ed.ai.super': { en: 'Super AI: design full stadium', ar: 'الذكاء الخارق: صمّم الملعب كامل' },
  'ed.ai.superHint': { en: 'Plans every stand together: portraits, text and colour blocking across the whole bowl.', ar: 'يخطّط لكل المدرجات سوا: وجوه ونصوص وتقسيم ألوان على المدرج كامل.' },
  'ed.ai.shuffle': { en: 'Shuffle: free offline variation', ar: 'تشكيل: نسخة ببلاش بدون نت' },
  'ed.ai.regen': { en: 'Regenerate', ar: 'أعد التوليد' },
  'ed.ai.revert': { en: 'Revert', ar: 'رجّع' },
  'ed.ai.polish': { en: 'Polish with AI critique', ar: 'حسّن بمراجعة الذكاء' },

  // ---- editor: object panel ----
  'ed.obj': { en: 'Object', ar: 'عنصر' },
  'ed.obj.recolor': { en: 'Recolor', ar: 'لوّن من جديد' },
  'ed.obj.deselect': { en: 'Deselect', ar: 'إلغاء التحديد' },
  'ed.obj.empty': { en: 'No object selected. Click a painted area to select it, or use Text/Image.', ar: 'ما في عنصر محدّد. اضغط منطقة ملوّنة عشان تحدّدها، أو استخدم نص/صورة.' },
  'ed.height': { en: 'Height', ar: 'الارتفاع' },
  'ed.tier': { en: 'Tier', ar: 'الطابق' },
  'ed.tier.both': { en: 'Both', ar: 'الكل' },
  'ed.tier.lower': { en: 'Lower', ar: 'السفلي' },
  'ed.tier.upper': { en: 'Upper', ar: 'العلوي' },
  'ed.obj.sendBack': { en: 'Send back', ar: 'للخلف' },
  'ed.obj.bringFront': { en: 'Bring front', ar: 'للأمام' },
  'ed.obj.bake': { en: 'Bake to seats', ar: 'ثبّت على المقاعد' },
  'ed.obj.bakeAll': { en: 'Bake all', ar: 'ثبّت الكل' },

  // ---- editor: stadium (shape) panel ----
  'ed.stadium.pattern': { en: 'Pattern…', ar: 'نمط…' },
  'ed.stadium.fillBase': { en: 'Fill base', ar: 'عبّي الأساس' },
  'ed.stadium.check': { en: 'Check', ar: 'افحص' },

  // ---- editor: reveal panel ----
  'ed.reveal': { en: 'Animate reveal', ar: 'حركة الكشف' },
  'ed.reveal.play': { en: 'Play', ar: 'شغّل' },
  'ed.reveal.length': { en: 'Length', ar: 'المدة' },
  'ed.reveal.gif': { en: 'Export GIF (flat)', ar: 'صدّر GIF (مسطّح)' },

  // ---- editor: stadium animation export ----
  'ed.sx': { en: 'Stadium animation', ar: 'حركة الملعب' },
  'ed.sx.tag': { en: 'video / GIF (3D)', ar: 'فيديو / GIF (ثلاثي الأبعاد)' },
  'ed.sx.hint': { en: 'Renders the 3D bowl lighting up with your chosen reveal. Style & length come from the Animation panel.', ar: 'يصوّر المدرج ثلاثي الأبعاد وهو يضيء بحركة الكشف اللي اخترتها. الستايل والمدة من لوحة الحركة.' },
  'ed.sx.format': { en: 'Format', ar: 'الصيغة' },
  'ed.sx.video': { en: 'Video (WebM)', ar: 'فيديو (WebM)' },
  'ed.sx.gif': { en: 'GIF', ar: 'GIF' },
  'ed.sx.gifWidth': { en: 'GIF width', ar: 'عرض الـGIF' },
  'ed.sx.noshow': { en: 'Export with 10% no-shows', ar: 'صدّر مع ١٠٪ مقاعد فاضية' },
  'ed.sx.preview': { en: 'Preview', ar: 'معاينة' },
  'ed.sx.export': { en: 'Export', ar: 'صدّر' },

  // ---- editor: history / production ----
  'ed.history': { en: 'History', ar: 'السجل' },
  'ed.undo': { en: 'Undo', ar: 'تراجع' },
  'ed.redo': { en: 'Redo', ar: 'إعادة' },
  'ed.prod': { en: 'Production export', ar: 'تصدير التنفيذ' },
  'ed.prod.tag': { en: 'match-day logistics', ar: 'تجهيزات يوم المباراة' },
  'ed.prod.bag': { en: 'Cards / bag', ar: 'كروت / كيس' },
  'ed.prod.pdf': { en: 'Distribution PDF', ar: 'ملف التوزيع PDF' },
  'ed.prod.csv': { en: 'Seat manifest (CSV)', ar: 'كشف المقاعد (CSV)' },
  'ed.prod.qr': { en: 'Fan QR code', ar: 'رمز QR للمشجّع' },
  'ed.prod.note': { en: 'Seat-by-seat instructions, material & bag counts, and a QR fans scan to find their card.', ar: 'تعليمات لكل مقعد، أعداد المواد والأكياس، ورمز QR يمسحه المشجّع عشان يلقى كرته.' },

  // ---- editor: camera + tool bars ----
  'ed.camera': { en: 'Camera', ar: 'الكاميرا' },
  'ed.noshow': { en: 'No-shows 10%', ar: '١٠٪ مقاعد فاضية' },
  'ed.matchDay': { en: 'Match Day', ar: 'يوم المباراة' },
  'ed.import.width': { en: 'Width', ar: 'العرض' },
  'ed.import.place': { en: 'Place', ar: 'المكان' },
  'ed.import.placeClick': { en: 'Click on canvas', ar: 'اضغط على اللوحة' },
  'ed.import.north': { en: 'North stand', ar: 'المدرج الشمالي' },
  'ed.import.east': { en: 'East end', ar: 'الجهة الشرقية' },
  'ed.import.south': { en: 'South stand', ar: 'المدرج الجنوبي' },
  'ed.import.west': { en: 'West stand', ar: 'المدرج الغربي' },
  'ed.import.realColors': { en: 'Real colours', ar: 'الألوان الأصلية' },
  'ed.import.dither': { en: 'Dither', ar: 'تنعيم' },
  'ed.import.cutout': { en: 'Remove background', ar: 'إزالة الخلفية' },

  // Status-line sentences for the add-a-picture flow. Whole sentences, not
  // fragments: Arabic puts the file name and the count in different places than
  // English does, and the old code built these by concatenation, which is how
  // an Arabic editor ended up reading `"images.png" added: drag to position`.
  'ed.import.size': { en: '{w} × {n} seats', ar: '{w} × {n} مقعد' },
  'ed.import.reading': { en: 'reading the picture…', ar: 'جارٍ قراءة الصورة…' },
  'ed.import.armed': { en: 'set the size and stand, then press Place — or click straight onto a stand', ar: 'حدّد المقاس والمدرج ثم اضغط «ضع» — أو اضغط على المدرج مباشرة' },
  'ed.import.failed': { en: 'couldn’t read that picture: {err}', ar: 'ما قدرنا نقرأ الصورة: {err}' },
  'ed.import.thePicture': { en: 'the picture', ar: 'الصورة' },
  'ed.import.placed': { en: '“{name}” is on the bowl — drag it, resize from the corner, then Bake', ar: '«{name}» صارت على المدرج — اسحبها، غيّر مقاسها من الزاوية، ثم ثبّتها' },
  'ed.obj.added': { en: '“{name}” added — drag it, resize from the corner, then Bake', ar: 'أُضيف «{name}» — اسحبه، غيّر مقاسه من الزاوية، ثم ثبّته' },
  'ed.obj.shapeAdded': { en: '{name} added — click to drop more, then “Bake all”. Switch to Select to move or resize.', ar: 'أُضيف {name} — اضغط عشان تضيف غيره، ثم «ثبّت الكل». بدّل إلى «تحديد» عشان تحرّكه أو تغيّر مقاسه.' },
  'ed.obj.baked': { en: 'baked onto {n} seats', ar: 'ثُبّت على {n} مقعد' },
  'ed.obj.bakedAll': { en: 'baked everything onto {n} seats', ar: 'ثُبّت كل شيء على {n} مقعد' },
  'mb.bake': { en: 'Bake', ar: 'ثبّت' },
  'mb.objOptions': { en: 'Options', ar: 'خيارات' },

  // Every sentence the editor's status line can say. These were hard-coded
  // English, so an Arabic editor answered in English the moment anything
  // happened — check legibility, apply a pattern, open a file. Whole sentences
  // with named placeholders, never fragments: Arabic puts the name and the
  // number in different places than English does.
  'ed.msg.paletteNoColors': { en: 'couldn’t pull colours from that image', ar: 'ما قدرنا نطلع ألوان من هذي الصورة' },
  'ed.msg.paletteNoFile': { en: 'no colours found in that file (.gpl / .hex / .json supported)', ar: 'ما لقينا ألوان في هذا الملف (ندعم ‎.gpl و‎.hex و‎.json)' },
  'ed.msg.paletteFailed': { en: 'palette import failed: {err}', ar: 'فشل استيراد لوحة الألوان: {err}' },
  'ed.msg.addColorsFirst': { en: 'add some colours first', ar: 'أضف ألوان أول' },
  'ed.msg.paletteSaved': { en: 'saved “{name}” — it’s under your saved palettes', ar: 'حفظنا «{name}» — بتلقاها ضمن لوحاتك المحفوظة' },
  'ed.msg.patternApplied': { en: 'pattern “{name}” applied (palette slots 1-3)', ar: 'طبّقنا نقشة «{name}» (خانات الألوان ١-٣)' },
  'ed.msg.typeTextFirst': { en: 'type some text first', ar: 'اكتب نص أول' },
  'ed.msg.fontLoaded': { en: 'font “{name}” loaded', ar: 'حمّلنا الخط «{name}»' },
  'ed.msg.fontFailed': { en: 'font load failed: {err}', ar: 'فشل تحميل الخط: {err}' },
  'ed.msg.legibleOk': { en: 'legibility ok: every stroke is {n}+ seats thick', ar: 'الوضوح تمام: كل خط سماكته {n} مقاعد أو أكثر' },
  'ed.msg.legibleThin': { en: '{n} seats sit in strokes thinner than {min} — they may vanish with no-shows', ar: '{n} مقعد داخل خطوط أرفع من {min} — وقد تختفي مع المقاعد الفاضية' },
  'ed.msg.photoAdded': { en: 'match-day photo added: it shows as Before/After in the feed', ar: 'أضفنا صورة يوم المباراة: بتظهر «قبل/بعد» في المجتمع' },
  'ed.msg.photoFailed': { en: 'photo upload failed: {err}', ar: 'فشل رفع الصورة: {err}' },
  'ed.msg.signedInAs': { en: 'signed in as {name}', ar: 'سجّلت الدخول باسم {name}' },
  'ed.msg.signedOut': { en: 'signed out', ar: 'سجّلت الخروج' },
  'ed.msg.saveBeforeShare': { en: 'save your design (and tick “List in public gallery”) first, then share', ar: 'احفظ تصميمك (وفعّل «اعرضه في المعرض العام») قبل المشاركة' },
  'ed.msg.downloaded': { en: 'downloaded “{name}.tifo”', ar: 'نزّلنا «{name}.tifo»' },
  'ed.msg.notJson': { en: 'that file isn’t valid JSON', ar: 'هذا الملف ليس JSON صالح' },
  'ed.msg.openingStadium': { en: 'opening in the matching stadium…', ar: 'نفتحه في الملعب المطابق…' },
  'ed.msg.opened': { en: 'opened “{name}”', ar: 'فتحنا «{name}»' },
  'ed.msg.openFailed': { en: 'couldn’t open that file: {err}', ar: 'ما قدرنا نفتح الملف: {err}' },
  'ed.msg.loadFailed': { en: 'load failed: {err}', ar: 'فشل التحميل: {err}' },
  'ed.msg.gifExported': { en: 'GIF exported ({kb} KB)', ar: 'صدّرنا GIF ({kb} كيلوبايت)' },
  'ed.msg.gifFailed': { en: 'GIF export failed: {err}', ar: 'فشل تصدير GIF: {err}' },
  'ed.msg.pdfFailed': { en: 'PDF export failed: {err}', ar: 'فشل تصدير PDF: {err}' },
  'ed.msg.manifestExported': { en: 'seat manifest exported ({n} seats)', ar: 'صدّرنا كشف المقاعد ({n} مقعد)' },
  'ed.msg.saveBeforeQr': { en: 'save or publish your tifo first — the QR points fans to it', ar: 'احفظ أو انشر التيفو أول — رمز QR يوصّل المشجّعين له' },
  'ed.msg.qrFailed': { en: 'couldn’t generate the QR code', ar: 'ما قدرنا ننشئ رمز QR' },

  // The dialogs a painting session actually opens. Hard-coded English here
  // meant an Arabic editor put up an entirely English modal the moment someone
  // picked a palette preset — the most ordinary thing in the panel.
  'ed.dlg.applyPalette': { en: 'Apply “{name}”', ar: 'تطبيق «{name}»' },
  'ed.dlg.applyHow': { en: 'How should these colours be applied to your design?', ar: 'كيف تبي نطبّق هذي الألوان على تصميمك؟' },
  'ed.dlg.remap': { en: 'Remap my design', ar: 'أعد تلوين تصميمي' },
  'ed.dlg.remapHint': { en: 'Recolour every seat to the nearest new colour.', ar: 'يلوّن كل مقعد بأقرب لون من الجديدة.' },
  'ed.dlg.justAdd': { en: 'Just add the colours', ar: 'أضف الألوان فقط' },
  'ed.dlg.justAddHint': { en: 'Add them to your swatches; the design stays as-is.', ar: 'تُضاف إلى ألوانك، والتصميم يبقى كما هو.' },
  'ed.dlg.namePalette': { en: 'Name this palette', ar: 'سمِّ لوحة الألوان' },
  'ed.dlg.namePaletteHint': { en: 'e.g. Derby black & gold', ar: 'مثال: أسود وذهبي للديربي' },
  'ed.dlg.myPalette': { en: 'My palette', ar: 'لوحتي' },
  'ed.dlg.savePalette': { en: 'Save palette', ar: 'احفظ اللوحة' },
  'ed.dlg.addCaption': { en: 'Add a caption', ar: 'أضف وصفًا' },
  'ed.dlg.captionHint': { en: 'Optional: describe the match or moment.', ar: 'اختياري: صف المباراة أو اللحظة.' },
  'ed.dlg.captionPlaceholder': { en: 'e.g. Liverpool vs Madrid, May 2026', ar: 'مثال: الهلال والنصر، مايو ٢٠٢٦' },
  'ed.dlg.continue': { en: 'Continue', ar: 'تابع' },
  'ed.dlg.uploading': { en: 'Uploading…', ar: 'جارٍ الرفع…' },
  'ed.ai.cancel': { en: 'Stop', ar: 'إيقاف' },
  // ---- account settings page ----
  'ed.account': { en: 'Account settings', ar: 'إعدادات الحساب' },
  'ac.title': { en: 'Account', ar: 'الحساب' },
  'ac.sub': { en: 'Your sign-in details, your data, and how to leave.', ar: 'بيانات دخولك، وبياناتك، وكيف تغادر.' },
  'ac.backToEditor': { en: 'Back to the editor', ar: 'رجوع للمحرر' },
  'ac.save': { en: 'Save', ar: 'حفظ' },
  'ac.cancel': { en: 'Cancel', ar: 'إلغاء' },
  'ac.saving': { en: 'Saving…', ar: '…جارٍ الحفظ' },
  'ac.signOut': { en: 'Sign out', ar: 'تسجيل الخروج' },
  'ac.signedOut': { en: 'Sign in to manage your account.', ar: 'سجّل الدخول لإدارة حسابك.' },
  'ac.sessionOver': { en: 'Your session has expired. Sign in again to manage your account.', ar: 'انتهت جلستك. سجّل الدخول من جديد لإدارة حسابك.' },
  'ac.email.title': { en: 'Email', ar: 'البريد الإلكتروني' },
  'ac.email.note': { en: 'Used to sign in, to reset your password, and to unlock the AI Designer.', ar: 'يُستخدم لتسجيل الدخول، ولإعادة تعيين كلمة المرور، ولفتح مصمّم الذكاء.' },
  'ac.email.change': { en: 'Change email', ar: 'تغيير البريد' },
  'ac.email.none': { en: 'No email on this account', ar: 'لا يوجد بريد على هذا الحساب' },
  'ac.email.verified': { en: 'Verified', ar: 'موثّق' },
  'ac.email.unverified': { en: 'Not verified yet', ar: 'غير موثّق بعد' },
  'ac.email.missing': { en: 'Missing', ar: 'غير موجود' },
  'ac.email.invalid': { en: 'That does not look like an email address.', ar: 'هذا لا يبدو بريدًا إلكترونيًا صحيحًا.' },
  'ac.email.saved': { en: 'Saved. We sent a code to the new address.', ar: 'تم الحفظ. أرسلنا رمزًا إلى البريد الجديد.' },
  'ac.email.taken': { en: 'That email is already on another account.', ar: 'هذا البريد مستخدم في حساب آخر.' },
  'ac.verify.codeLabel': { en: '6-digit code', ar: 'رمز من 6 أرقام' },
  'ac.verify.submit': { en: 'Verify', ar: 'تحقّق' },
  'ac.verify.resend': { en: 'Send a new code', ar: 'أرسل رمزًا جديدًا' },
  'ac.verify.sentTo': { en: 'We sent a 6-digit code to {email}. It is good for 10 minutes — type it here, or click the link in the same message.', ar: 'أرسلنا رمزًا من 6 أرقام إلى {email}. صالح لعشر دقائق — اكتبه هنا، أو افتح الرابط في نفس الرسالة.' },
  'ac.verify.sixDigits': { en: 'Enter all six digits.', ar: 'اكتب الأرقام الستة كاملة.' },
  'ac.verify.checking': { en: 'Checking…', ar: '…جارٍ التحقق' },
  'ac.verify.done': { en: 'Email verified. The AI Designer is unlocked.', ar: 'تم توثيق البريد. مصمّم الذكاء صار متاحًا.' },
  'ac.verify.wrong': { en: 'That code is not right, or it has expired.', ar: 'الرمز غير صحيح أو انتهت صلاحيته.' },
  'ac.verify.wrongLeft': { en: 'That code is not right. {n} tries left before you need a new one.', ar: 'الرمز غير صحيح. بقيت {n} محاولات قبل أن تحتاج رمزًا جديدًا.' },
  'ac.verify.exhausted': { en: 'Too many tries. Send a new code and start again.', ar: 'محاولات كثيرة. أرسل رمزًا جديدًا وابدأ من جديد.' },
  'ac.verify.resent': { en: 'A new code is on its way to {email}.', ar: 'رمز جديد في طريقه إلى {email}.' },
  'ac.verify.resendFailed': { en: 'Could not send the code. Try again shortly.', ar: 'تعذّر إرسال الرمز. جرّب بعد قليل.' },
  'ac.verify.cooldown': { en: 'A message is already on its way — give it {n}s. Sending a new one would stop the code in it working.', ar: 'في رسالة بطريقها — انتظر {n} ثانية. إرسال رسالة جديدة يلغي الرمز اللي فيها.' },
  'ac.verify.sendRefused': { en: 'Our email provider refused that message. This is on us, not you — try again in a few minutes.', ar: 'مزوّد البريد رفض الرسالة. المشكلة عندنا مو عندك — جرّب بعد دقائق.' },
  'ac.verify.noEmailSent': { en: 'Your account is ready, but we could not send the verification email. Press Resend in a moment.', ar: 'حسابك جاهز، لكن ما قدرنا نرسل بريد التوثيق. اضغط «أعد الإرسال» بعد شوي.' },
  'ac.name.title': { en: 'Display name', ar: 'الاسم الظاهر' },
  'ac.name.note': { en: 'This is the @name on every tifo you publish. Changing it updates your name everywhere, including on designs you have already shared.', ar: 'هذا هو الاسم الذي يظهر على كل تيفو تنشره. تغييره يحدّث اسمك في كل مكان، حتى على تصاميمك المنشورة سابقًا.' },
  'ac.name.label': { en: 'Name', ar: 'الاسم' },
  'ac.name.rules': { en: '3 to 24 characters: letters, numbers or underscore.', ar: 'من 3 إلى 24 حرفًا: حروف أو أرقام أو شرطة سفلية.' },
  'ac.name.saved': { en: 'You are now @{name}.', ar: 'صرت الآن @{name}.' },
  'ac.name.taken': { en: 'That name is taken.', ar: 'هذا الاسم مستخدم.' },
  'ac.pw.title': { en: 'Password', ar: 'كلمة المرور' },
  'ac.pw.note': { en: 'Changing your password signs you out on every other device. This one stays signed in.', ar: 'تغيير كلمة المرور يسجّل خروجك من كل الأجهزة الأخرى. هذا الجهاز يبقى مسجّلًا.' },
  'ac.pw.current': { en: 'Current password', ar: 'كلمة المرور الحالية' },
  'ac.pw.new': { en: 'New password', ar: 'كلمة المرور الجديدة' },
  'ac.pw.save': { en: 'Change password', ar: 'غيّر كلمة المرور' },
  'ac.pw.short': { en: 'Use at least 8 characters.', ar: 'استخدم 8 أحرف على الأقل.' },
  'ac.pw.done': { en: 'Password changed. Every other device has been signed out.', ar: 'تم تغيير كلمة المرور. وسُجّل الخروج من كل الأجهزة الأخرى.' },
  'ac.pw.wrong': { en: 'That current password is not right.', ar: 'كلمة المرور الحالية غير صحيحة.' },
  'ac.data.title': { en: 'Your data', ar: 'بياناتك' },
  'ac.data.note': { en: 'Download everything on your account: your details and every tifo you have made.', ar: 'نزّل كل ما في حسابك: بياناتك وكل تيفو صمّمته.' },
  'ac.data.export': { en: 'Download my data', ar: 'نزّل بياناتي' },
  'ac.data.done': { en: 'Downloaded.', ar: 'تم التنزيل.' },
  'ac.data.failed': { en: 'Could not prepare the download. Try again shortly.', ar: 'تعذّر تجهيز الملف. جرّب بعد قليل.' },
  'ac.danger.title': { en: 'Delete account', ar: 'حذف الحساب' },
  'ac.danger.note': { en: 'This erases your account and every tifo you have made. It cannot be undone.', ar: 'هذا يمحو حسابك وكل تيفو صمّمته. ولا يمكن التراجع.' },
  'ac.danger.start': { en: 'Delete my account', ar: 'احذف حسابي' },
  'ac.danger.confirm': { en: 'Delete for good', ar: 'احذف نهائيًا' },
  'ac.danger.typeName': { en: 'Type {name} to confirm.', ar: 'اكتب {name} للتأكيد.' },
  'ac.danger.mismatch': { en: 'That does not match your name.', ar: 'هذا لا يطابق اسمك.' },
  'ac.danger.failed': { en: 'Could not delete the account. Try again shortly.', ar: 'تعذّر حذف الحساب. جرّب بعد قليل.' },
  // ---- AI state card: every outcome the panel can report ----
  'ai.verify.sent': { en: 'Verify your email to use the AI Designer. A new code is on its way to your inbox.', ar: 'وثّق بريدك عشان تستخدم مصمّم الذكاء الاصطناعي. رمز جديد في طريقه لبريدك.' },
  'ai.verify.onItsWay': { en: 'Verify your email to use the AI Designer. The code is in the email we sent you.', ar: 'وثّق بريدك عشان تستخدم مصمّم الذكاء الاصطناعي. الرمز موجود في الرسالة اللي أرسلناها لك.' },
  'ai.verify.notSent': { en: 'Verify your email to use the AI Designer. We could not send a new code just now — try again from your account page.', ar: 'وثّق بريدك عشان تستخدم مصمّم الذكاء الاصطناعي. ما قدرنا نرسل رمزًا جديدًا الحين — جرّب من صفحة حسابك.' },
  'ai.verify.nowVerified': { en: 'Your email is verified. Try again.', ar: 'بريدك موثّق. جرّب مرة ثانية.' },
  'ai.verify.addedCheckInbox': { en: 'Check your inbox for the code, then try again.', ar: 'شوف بريدك وخذ الرمز، وبعدها جرّب مرة ثانية.' },
  'ai.verify.addEmail': { en: 'Add a verified email to use the AI Designer.', ar: 'أضف بريدًا موثّقًا عشان تستخدم مصمّم الذكاء الاصطناعي.' },
  'ai.verify.enterCode': { en: 'Enter the code', ar: 'اكتب الرمز' },
  'ai.card.doneSuper': { en: 'Designed with Super AI', ar: 'تم التصميم بالذكاء الخارق' },
  'ai.card.donePremium': { en: 'Designed with Premium AI', ar: 'تم التصميم بالذكاء المتقدم' },
  'ai.card.doneQuick': { en: 'Designed with the Quick Designer', ar: 'تم التصميم بالمصمّم السريع' },
  'ai.card.degraded': { en: 'Designed — but {what} could not be generated', ar: 'تم التصميم — لكن تعذّر توليد {what}' },
  'ai.card.aPicture': { en: 'the picture', ar: 'الصورة' },
  'ai.card.nPictures': { en: '{n} pictures', ar: '{n} صور' },
  'ai.card.degradedFree': {
    en: 'The stand it was meant to fill is bare, so this one was free — your design count has not changed.',
    ar: 'المدرج المخصص لها ظهر فارغًا، ولهذا لم نحتسب هذا التصميم — رصيدك لم يتغيّر.',
  },
  'ai.card.degradedPaid': { en: 'The stand it was meant to fill is bare.', ar: 'المدرج المخصص لها ظهر فارغًا.' },
  'ai.card.degradedWhy': { en: 'The image service turned the request down.', ar: 'رفضت خدمة الصور الطلب.' },
  'ai.card.reason': { en: 'Reason: {detail}', ar: 'السبب: {detail}' },
  'ai.card.tryAgain': { en: 'Try again', ar: 'حاول مرة أخرى' },
  'ai.card.keep': { en: 'Keep this design', ar: 'احتفظ بالتصميم' },
  'ai.card.useQuick': { en: 'Use the Quick Designer', ar: 'استخدم المصمّم السريع' },
  'ai.card.retryPremium': { en: 'Try Premium again', ar: 'جرّب الذكاء المتقدم مجددًا' },
  'ai.card.premiumFreeIn': { en: 'Premium free in {left}', ar: 'يتاح خلال {left}' },
  'ai.card.quotaTitle': {
    en: "You've used all {limit} premium designs this hour",
    ar: 'استهلكت كل تصاميمك المتقدمة ({limit}) هذه الساعة',
  },
  'ai.card.quotaBody': {
    en: 'Your allowance resets in about {mins} min. The Quick Designer is free and instant, and its designs are fully editable too.',
    ar: 'يتجدّد رصيدك خلال {mins} دقيقة تقريبًا. المصمّم السريع مجاني وفوري، وتصاميمه قابلة للتعديل بالكامل.',
  },
  'ai.card.busyTitle': { en: 'Premium AI could not deliver just now', ar: 'تعذّر على الذكاء المتقدم التنفيذ الآن' },
  'ai.card.busyBody': {
    en: 'It is busy or briefly unavailable. Your design allowance was not touched.',
    ar: 'إما مشغول أو غير متاح مؤقتًا. ولم يُخصم من رصيدك شيء.',
  },
  'ai.card.stopped': { en: 'Stopped', ar: 'تم الإيقاف' },
  'ai.card.stoppedBody': { en: 'Nothing was generated and no design was used.', ar: 'لم يتم توليد أي شيء ولم يُستهلك أي تصميم.' },
  'ai.card.startAgain': { en: 'Start again', ar: 'ابدأ من جديد' },
  'ai.card.quotaOut': { en: 'You have used all your premium designs for now', ar: 'استهلكت كل تصاميمك المتقدمة حاليًا' },
  'ai.card.quotaOutBody': {
    en: 'The Quick Designer is free, instant, and its designs are just as editable.',
    ar: 'المصمّم السريع مجاني وفوري، وتصاميمه قابلة للتعديل تمامًا.',
  },
  'ai.card.signIn': { en: 'Sign in to generate', ar: 'سجّل الدخول للتوليد' },
  'ai.card.signInBody': { en: 'Your brief is saved — it will still be here afterwards.', ar: 'وصفك محفوظ — سيبقى موجودًا بعد تسجيل الدخول.' },
  'ai.card.offline': { en: 'You are offline', ar: 'أنت غير متصل بالإنترنت' },
  'ai.card.offlineBody': {
    en: 'The Quick Designer works without a connection and needs no quota.',
    ar: 'المصمّم السريع يعمل دون اتصال ولا يحتاج رصيدًا.',
  },
  'ai.card.failed': { en: 'The design could not be generated', ar: 'تعذّر توليد التصميم' },
  'ai.card.failedBody': {
    en: 'Something went wrong on the way to the model. Nothing was used.',
    ar: 'حدث خطأ في الطريق إلى النموذج. ولم يُستهلك شيء.',
  },
  'ai.card.polished': { en: 'Polished by AI critique', ar: 'تم التحسين بمراجعة الذكاء' },
  'ai.card.polishKept': { en: 'Kept your design — the critique suggested no change', ar: 'أبقينا تصميمك — المراجعة لم تقترح أي تغيير' },
  'ai.card.polishFailed': { en: 'Polish could not run', ar: 'تعذّر تشغيل التحسين' },
  'ai.card.polishFailedBody': { en: 'Your design is untouched. Try again in a moment.', ar: 'تصميمك لم يتغيّر. جرّب بعد قليل.' },
  'ai.card.describeFirst': { en: 'Describe the tifo you want first', ar: 'اكتب وصف التيفو أولًا' },
  'ed.import.cutoutT': { en: 'Flood the flat backdrop away so the design underneath shows through', ar: 'يزيل الخلفية المسطحة ليظهر التصميم خلف الصورة' },
  'ed.import.alpha': { en: 'Alpha', ar: 'الشفافية' },
  'ed.import.cancel': { en: 'Cancel', ar: 'إلغاء' },
  'ed.import.apply': { en: 'Place', ar: 'ضع' },
  'ed.text.placeholder': { en: 'YOUR TEXT', ar: 'نصّك' },
  'ed.text.arc': { en: 'Arc', ar: 'القوس' },
  'ed.text.fontFile': { en: 'Font file…', ar: 'ملف خط…' },
  'ed.text.hint': { en: 'pick a color, then click a stand to place', ar: 'اختر لون، ثم اضغط مدرج عشان تضعه' },
  'ed.shape': { en: 'Shape', ar: 'الشكل' },
  'ed.shape.hint': { en: 'pick a colour, then click a stand to place', ar: 'اختر لون، ثم اضغط مدرج عشان تضعه' },
  'ed.seats': { en: 'seats', ar: 'مقعد' },

  // ---- common ----
  'ed.stat.generating': { en: 'generating seat map…', ar: 'يجهّز خريطة المقاعد…' },


  // ---- editor shell: tools, options and tooltips (index.html) ----
  // ---- community gallery ----
  'gal.title': { en: 'Community feed', ar: 'منشورات المجتمع' },
  'gal.sub': { en: 'Open any tifo to remix it, your changes start a fresh copy.', ar: 'افتح أي تيفو عشان تعدّل عليه، وتعديلاتك تصير نسخة جديدة.' },
  'gal.search': { en: 'Search by name…', ar: 'ابحث بالاسم…' },
  'gal.recent': { en: 'Recent', ar: 'الأحدث' },
  'gal.liked': { en: 'Most liked', ar: 'الأكثر إعجابًا' },
  'gal.templates': { en: 'Templates', ar: 'قوالب' },
  'gal.loading': { en: 'Loading published tifos…', ar: 'نجيب التيفوهات المنشورة…' },
  'gal.noMatch': { en: 'No tifos match those filters.', ar: 'ما فيه تيفو يطابق هذي الفلاتر.' },
  'gal.ba': { en: 'Before / After', ar: 'قبل / بعد' },
  'gal.baT': { en: 'See it built in real life', ar: 'شوفه منفّذ على أرض الواقع' },
  'gal.like': { en: 'Like', ar: 'إعجاب' },
  'gal.dislike': { en: 'Dislike', ar: 'عدم إعجاب' },
  'gal.report': { en: 'Report this tifo', ar: 'بلّغ عن هذا التيفو' },
  'gal.reportMsg': { en: 'What is the problem? This goes to the moderators.', ar: 'وش المشكلة؟ هذا يوصل للمشرفين.' },
  'gal.reportSend': { en: 'Submit report', ar: 'أرسل البلاغ' },
  'gal.reported': { en: 'Reported: thank you', ar: 'تم التبليغ، شكرًا لك' },
  'gal.open': { en: 'Open & remix', ar: 'افتح وعدّل' },
  'gal.popular': { en: 'Popular:', ar: 'الرائج:' },

  // ---- banner studio ----
  'bs.fillBg': { en: 'Fill bg', ar: 'عبّي الخلفية' },
  'bs.clear': { en: 'Clear', ar: 'مسح' },
  'bs.placeAs': { en: 'Place as', ar: 'حطّها كـ' },
  'bs.surface': { en: 'Drape whole stand (surface tifo)', ar: 'غطّي المدرج كامل (تيفو سطحي)' },
  'bs.big': { en: 'Hang over the seats (big banner)', ar: 'علّقها فوق المقاعد (لافتة كبيرة)' },
  'bs.small': { en: 'Cover the front fence (Zaunfahne)', ar: 'غطّي السياج الأمامي (Zaunfahne)' },
  'bs.gap': { en: 'Fill the walkway gap (rail banner)', ar: 'عبّي فراغ الممشى (لافتة السور)' },
  'bs.stairs': { en: 'Cover the stairs (vertical strip)', ar: 'غطّي الدرج (شريط عمودي)' },
  'bs.floor': { en: 'Pitch-side floor banner', ar: 'لافتة أرضية جنب الملعب' },
  'bs.stand': { en: 'Stand', ar: 'المدرج' },
  'bs.add': { en: 'Add to stadium', ar: 'أضفها للملعب' },
  'dir.north': { en: 'North', ar: 'الشمالي' },
  'dir.east': { en: 'East', ar: 'الشرقي' },
  'dir.south': { en: 'South', ar: 'الجنوبي' },
  'dir.west': { en: 'West', ar: 'الغربي' },

  // ---- banner studio eraser ----


  // ---- guided tour ----
  'tour.tools': { en: 'Your tools', ar: 'أدواتك' },
  'tour.tools.b': { en: 'Brush, Fill and Eraser paint the seats; Text and Image add words or a logo. Shapes drops crests, stars and more: add as many as you like, then "Bake all". Select lets you drag a box around any area to recolour or clear it. Hover any tool for its shortcut.', ar: 'الفرشاة والتعبئة والممحاة تلوّن المقاعد؛ النص والصورة يضيفون كلمات أو شعار. الأشكال تنزّل شعارات ونجوم وغيرها: أضف اللي تبي، وبعدين «ثبّت الكل». والتحديد يخليك تسحب مربع حول أي منطقة تلوّنها أو تمسحها. حط المؤشر على أي أداة عشان تشوف اختصارها.' },
  'tour.colors': { en: 'Your colors', ar: 'ألوانك' },
  'tour.colors.b': { en: 'This is your active paint color. Click it to change it, hit "+ Color" to add any color to your palette, then click a swatch to paint with it.', ar: 'هذا لون الرسم الحالي. اضغط عليه عشان تغيّره، واضغط «+ لون» عشان تضيف أي لون للوحتك، وبعدين اضغط على أي لون ترسم فيه.' },
  'tour.ai': { en: 'AI Designer', ar: 'مصمّم الذكاء الاصطناعي' },
  'tour.ai.b': { en: 'Describe a display in plain words and the AI paints a fully editable tifo on the seats. "Super AI" designs the whole bowl at once; "Shuffle" gives instant free variations, no tokens needed.', ar: 'اوصف التيفو بكلامك العادي والذكاء الاصطناعي يرسمه على المقاعد وتقدر تعدّله كامل. «سوبر AI» يصمّم المدرج كله مرة وحدة، و«خلط» يعطيك تنويعات فورية ببلاش وبدون رصيد.' },
  'tour.stadium': { en: 'Choose your stadium', ar: 'اختر ملعبك' },
  'tour.stadium.b': { en: 'Pick the stadium your tifo is for and set the active area. Switching stadiums remaps your design onto the new bowl, so a display can be reused anywhere.', ar: 'اختر الملعب اللي تيفوك له وحدّد المنطقة الفعّالة. لما تبدّل الملعب ينتقل تصميمك على المدرج الجديد، فتقدر تعيد استخدام أي عرض في أي مكان.' },
  'tour.design': { en: 'Design view', ar: 'عرض التصميم' },
  'tour.design.b': { en: 'This flat view is where you paint the choreography across all 60,000 seats. It is where you will spend most of your time.', ar: 'هذا العرض المسطّح هو اللي ترسم فيه العرض على الستين ألف مقعد كلها، وهو اللي بتقضي فيه أغلب وقتك.' },
  'tour.stadiumView': { en: 'Stadium view', ar: 'عرض الملعب' },
  'tour.stadiumView.b': { en: 'See your design wrap around the real 3D bowl, and open the Match Day Simulator for a packed, cinematic night-match view with crowds, flags, smoke and choreography.', ar: 'شوف تصميمك ملتف حول المدرج ثلاثي الأبعاد، وافتح محاكي يوم المباراة عشان تشوف مباراة ليلية كاملة بالجمهور والأعلام والدخان والعرض.' },
  'tour.split': { en: 'Split view: both at once', ar: 'العرض المقسوم: الاثنين مرة وحدة' },
  'tour.split.b': { en: 'Paint on one side and watch the 3D stadium update live on the other. The best of both while you fine-tune.', ar: 'ارسم في جهة وشوف الملعب ثلاثي الأبعاد يتحدّث مباشرة في الجهة الثانية. أفضل الاثنين وأنت تظبّط التفاصيل.' },
  'tour.save': { en: 'Save, share & produce', ar: 'احفظ وشارك ونفّذ' },
  'tour.save.b': { en: 'Save to your account, publish to the community, or export match-day logistics (a distribution PDF, seat manifest and a fan QR code) from here.', ar: 'احفظ في حسابك، أو انشر في المجتمع، أو صدّر تجهيزات يوم المباراة (ملف توزيع PDF وكشف المقاعد ورمز QR للمشجّع) من هنا.' },
  'tour.inspire': { en: 'Get inspired', ar: 'خذ إلهام' },
  'tour.inspire.b': { en: 'Browse tifos from supporters worldwide: like, comment, and remix any of them into your own starting point.', ar: 'تصفّح تيفوهات مشجّعين من كل مكان: أعجب بها، وعلّق، وخذ أي وحدة كنقطة بداية لتصميمك.' },
  'tour.mtools': { en: 'Your toolbar', ar: 'شريط أدواتك' },
  'tour.mtools.b': { en: 'Every tool lives down here. Tap one to use it, tap it again for its options.', ar: 'كل الأدوات هنا تحت. اضغط على وحدة عشان تستخدمها، واضغط عليها مرة ثانية عشان تطلع خياراتها.' },
  'tour.m3d': { en: 'See it in 3D', ar: 'شوفه ثلاثي الأبعاد' },
  'tour.m3d.b': { en: 'Tap Stadium to see your tifo on the real bowl, then Match Day for the full night-match show.', ar: 'اضغط «الملعب» عشان تشوف تيفوك على المدرج الحقيقي، وبعدين «يوم المباراة» للعرض الليلي الكامل.' },
  'tour.mai': { en: 'Start with AI', ar: 'ابدأ بالذكاء الاصطناعي' },
  'tour.mai.b': { en: 'Fastest way to a tifo: tap AI, describe it (or just your club), and watch it appear.', ar: 'أسرع طريق للتيفو: اضغط AI، واوصفه (أو بس اكتب ناديك)، وشوفه يطلع قدامك.' },
  'tour.skip': { en: 'Skip tour', ar: 'تخطَّ الجولة' },
  'tour.back': { en: 'Back', ar: 'رجوع' },
  'tour.next': { en: 'Next', ar: 'التالي' },
  'tour.done': { en: 'Got it', ar: 'تمام' },
  'tour.step': { en: 'Step {n} of {total}', ar: 'الخطوة {n} من {total}' },

  // ---- moderation ----
  'common.confirm': { en: 'Confirm', ar: 'تأكيد' },
  'common.ok': { en: 'OK', ar: 'تمام' },
  'common.loading': { en: 'Loading…', ar: 'جاري التحميل…' },
  'mod.title': { en: 'Moderation', ar: 'الإشراف' },
  'mod.sub': { en: 'Review reports and verify match-day photos.', ar: 'راجع البلاغات ووثّق صور يوم المباراة.' },
  'mod.reports': { en: 'Reports', ar: 'البلاغات' },
  'mod.photos': { en: 'Photo verification', ar: 'توثيق الصور' },
  'mod.noReports': { en: 'No open reports. The queue is clear.', ar: 'ما فيه بلاغات مفتوحة. القائمة نظيفة.' },
  'mod.takedown': { en: 'Take down', ar: 'إزالة' },
  'mod.dismiss': { en: 'Dismiss', ar: 'تجاهل' },
  'mod.takedownQ': { en: 'Take down this design?', ar: 'تبي تزيل هذا التصميم؟' },
  'mod.takedownYes': { en: 'Take it down', ar: 'أزله' },
  'mod.noPhotos': { en: 'No photos awaiting verification.', ar: 'ما فيه صور تنتظر التوثيق.' },
  'mod.verify': { en: 'Verify', ar: 'وثّق' },
  'mod.remove': { en: 'Remove', ar: 'احذف' },
  'mod.removeQ': { en: 'Remove this photo?', ar: 'تبي تحذف هذي الصورة؟' },
  'mod.removeMsg': { en: 'This permanently deletes the photo. This cannot be undone.', ar: 'هذا يحذف الصورة نهائيًا وما يمكن التراجع.' },
  'mod.removeYes': { en: 'Remove photo', ar: 'احذف الصورة' },

  // ---- moderation load ----
  'mod.loadFail': { en: 'Could not load', ar: 'ما قدرنا نحمّل' },

  // ---- profile, before/after, share ----
  'pf.title': { en: 'Profile', ar: 'الملف الشخصي' },
  'pf.created': { en: 'Created', ar: 'أنشأها' },
  'pf.liked': { en: 'Liked', ar: 'أعجبته' },
  'pf.noCreated': { en: 'No public tifos yet. Publish one to show it here!', ar: 'ما فيه تيفوهات منشورة. انشر وحدة عشان تظهر هنا!' },
  'pf.noLiked': { en: 'No liked tifos yet. Like designs in the feed to collect them here.', ar: 'ما أعجبتك أي تيفو بعد. أعجب بتصاميم من المنشورات عشان تتجمّع هنا.' },
  'ba.title': { en: 'Before and after', ar: 'قبل وبعد' },
  'ba.sub': { en: 'Drag the divider: the design on one side, the real stand on the other.', ar: 'اسحب الفاصل: التصميم في جهة والمدرج الحقيقي في الجهة الثانية.' },
  'ba.photo': { en: 'Real match-day photo', ar: 'صورة حقيقية من يوم المباراة' },
  'ba.design': { en: 'Digital design', ar: 'التصميم الرقمي' },
  'ba.designTag': { en: 'Design', ar: 'التصميم' },
  'ba.realTag': { en: 'Real stand', ar: 'المدرج الحقيقي' },
  'ba.verified': { en: 'Verified match', ar: 'مطابقة موثّقة' },
  'ba.verifiedT': { en: 'Verified by a moderator as a genuine match', ar: 'مشرف وثّق إنها مطابقة حقيقية' },
  'sm.title': { en: 'Share tifo', ar: 'شارك التيفو' },
  'sm.head': { en: 'Share this tifo', ar: 'شارك هذا التيفو' },
  'sm.openPublic': { en: 'Open public page', ar: 'افتح الصفحة العامة' },
  'sm.copied': { en: 'Link copied to clipboard', ar: 'اننسخ الرابط' },
  'sm.copiedFor': { en: 'Link copied: paste it into', ar: 'اننسخ الرابط: الصقه في' },
  'sm.qrAlt': { en: 'QR code to open this tifo', ar: 'رمز QR يفتح هذا التيفو' },
  'sm.qrFail': { en: 'Could not generate QR code.', ar: 'ما قدرنا ننشئ رمز QR.' },

  // ---- stadium filters and areas ----
  'area.all': { en: 'Entire stadium', ar: 'الملعب كامل' },
  'area.north': { en: 'North stand', ar: 'المدرج الشمالي' },
  'area.south': { en: 'South stand', ar: 'المدرج الجنوبي' },
  'area.east': { en: 'East stand', ar: 'المدرج الشرقي' },
  'area.west': { en: 'West stand', ar: 'المدرج الغربي' },
  'area.upper': { en: 'Upper tier', ar: 'الطابق العلوي' },
  'area.lower': { en: 'Lower tier', ar: 'الطابق السفلي' },
  'stype.bowl': { en: 'Bowl', ar: 'مدرج دائري' },
  'stype.single': { en: 'Single-tier', ar: 'طابق واحد' },
  'stype.two': { en: 'Two-tier', ar: 'طابقين' },
  'stype.oval': { en: 'Oval', ar: 'بيضاوي' },
  'stype.arena': { en: 'Arena', ar: 'صالة' },
  'country.europe': { en: 'Europe', ar: 'أوروبا' },
  'country.intl': { en: 'International', ar: 'دولي' },
  'country.me': { en: 'Middle East', ar: 'الشرق الأوسط' },
  'country.sa': { en: 'South America', ar: 'أمريكا الجنوبية' },
  'sp.search': { en: 'Search stadiums…', ar: 'ابحث عن ملعب…' },
  'sp.anyType': { en: 'Any type', ar: 'أي نوع' },
  'sp.anyTiers': { en: 'Any tiers', ar: 'أي عدد طوابق' },
  'sp.tier': { en: 'tier', ar: 'طابق' },
  'sp.tiers': { en: 'tiers', ar: 'طوابق' },
  'sp.anyCountry': { en: 'Any country', ar: 'أي دولة' },
  'sp.anySize': { en: 'Any size', ar: 'أي حجم' },

  // ---- stadium panel ----
  'sp.builtin': { en: 'Built-in', ar: 'جاهزة' },
  'sp.community': { en: 'Community', ar: 'المجتمع' },
  'sp.custom': { en: 'Custom', ar: 'مخصّصة' },
  'sp.favorites': { en: 'Favourites', ar: 'المفضّلة' },
  'sp.fav': { en: 'Add to favourites', ar: 'أضفه للمفضّلة' },
  'sp.unfav': { en: 'Remove from favourites', ar: 'شيله من المفضّلة' },
  'sp.noFav': { en: 'No favourites yet: tap the star on a stadium to add it.', ar: 'ما فيه مفضّلة: اضغط النجمة على أي ملعب عشان تضيفه.' },
  'sp.noCustom': { en: 'No custom stadiums yet: create one above.', ar: 'ما فيه ملاعب مخصّصة: سوِّ واحد فوق.' },
  'sp.noMatch': { en: 'No stadiums match your filters.', ar: 'ما فيه ملاعب تطابق فلاترك.' },
  'sp.current': { en: 'Current', ar: 'الحالي' },
  'sp.load': { en: 'Load', ar: 'حمّل' },
  'sp.country': { en: 'Country', ar: 'الدولة' },
  'sp.capacity': { en: 'Capacity', ar: 'السعة' },
  'sp.seats': { en: 'Seats', ar: 'المقاعد' },
  'sp.sections': { en: 'Sections', ar: 'القطاعات' },
  'sp.tiersLabel': { en: 'Tiers', ar: 'الطوابق' },
  'sp.type': { en: 'Type', ar: 'النوع' },
  'sp.rotate': { en: 'Rotate', ar: 'تدوير' },
  'sp.flipNS': { en: 'Flip N/S', ar: 'قلب شمال/جنوب' },
  'sp.flipEW': { en: 'Flip E/W', ar: 'قلب شرق/غرب' },
  'sp.approve': { en: 'Approve', ar: 'موافقة' },
  'sp.reject': { en: 'Reject', ar: 'رفض' },
  'sp.retry': { en: 'Retry', ar: 'أعد المحاولة' },
  'sp.submitT': { en: 'Submit to the community for review', ar: 'أرسله للمجتمع للمراجعة' },
  'sp.submitted': { en: 'Submitted for community review', ar: 'انرسل لمراجعة المجتمع' },
  'sp.submitFail': { en: 'Submission failed, try again', ar: 'ما نجح الإرسال، جرّب مرة ثانية' },
  'sp.exportT': { en: 'Export this stadium as JSON (share it)', ar: 'صدّر هذا الملعب كـ JSON (عشان تشاركه)' },
  'sp.deleteT': { en: 'Delete this custom stadium', ar: 'احذف هذا الملعب المخصّص' },
  'sp.namePh': { en: 'Custom stadium name', ar: 'اسم الملعب المخصّص' },
  'sp.standard': { en: 'Standard', ar: 'قياسي' },
  'sp.compact': { en: 'Compact', ar: 'صغير' },
  'sp.large': { en: 'Large', ar: 'كبير' },
  'sp.create': { en: 'Create custom stadium', ar: 'أنشئ ملعب مخصّص' },
  'sp.importPh': { en: 'Paste a stadium JSON to import…', ar: 'الصق JSON ملعب عشان تستورده…' },

  // stadium import (ui/stadiumImport.ts) — building a bowl from a real ground
  'si.title': { en: 'Build one from a real ground', ar: 'سوِّ ملعب من أرض حقيقية' },
  'si.blurb': { en: 'Finds the ground in OpenStreetMap and estimates its bowl. It will tell you which numbers it measured and which it guessed.', ar: 'يلقى الملعب في OpenStreetMap ويقدّر شكل مدرجاته. وبيقول لك أي أرقام قاسها وأيها خمّنها.' },
  'si.searchPh': { en: 'Stadium name…', ar: 'اسم الملعب…' },
  'si.find': { en: 'Find', ar: 'دوّر' },
  'si.searching': { en: 'Searching OpenStreetMap…', ar: 'يدوّر في OpenStreetMap…' },
  'si.tooShort': { en: 'Type at least three letters.', ar: 'اكتب ٣ حروف على الأقل.' },
  'si.none': { en: 'No ground of that name in OpenStreetMap. Try the local-language name.', ar: 'ما فيه ملعب بهذا الاسم في OpenStreetMap. جرّب الاسم باللغة المحلية.' },
  'si.found1': { en: 'Found it.', ar: 'لقيته.' },
  'si.foundN': { en: 'matches — pick one.', ar: 'نتيجة — اختر وحدة.' },
  'si.osmDown': { en: 'OpenStreetMap is not answering right now. Try again in a moment.', ar: 'OpenStreetMap ما يرد حالياً. جرّب بعد شوي.' },
  'si.capacityPh': { en: 'Capacity', ar: 'السعة' },
  'si.aislesPh': { en: 'Aisles', ar: 'الممرات' },
  'si.tiersAuto': { en: 'Tiers: estimate', ar: 'الطوابق: تقدير' },
  'si.tiers1': { en: 'Tiers: 1', ar: 'الطوابق: ١' },
  'si.tiers2': { en: 'Tiers: 2', ar: 'الطوابق: ٢' },
  'si.tiers3': { en: 'Tiers: 3', ar: 'الطوابق: ٣' },
  'si.roofAuto': { en: 'Roof: estimate', ar: 'السقف: تقدير' },
  'si.roofRing': { en: 'Roof: all round', ar: 'السقف: كامل الملعب' },
  'si.roofSides': { en: 'Roof: two sides', ar: 'السقف: الجهتين الطويلتين' },
  'si.roofOne': { en: 'Roof: main stand only', ar: 'السقف: المدرج الرئيسي فقط' },
  'si.roofNone': { en: 'Roof: none', ar: 'السقف: بدون' },
  'si.trackAuto': { en: 'Running track: estimate', ar: 'مضمار الجري: تقدير' },
  'si.trackYes': { en: 'Running track: yes', ar: 'مضمار الجري: فيه' },
  'si.trackNo': { en: 'Running track: no', ar: 'مضمار الجري: ما فيه' },
  'si.lightAuto': { en: 'Lights: estimate', ar: 'الإنارة: تقدير' },
  'si.lightMasts': { en: 'Lights: corner pylons', ar: 'الإنارة: أبراج في الأركان' },
  'si.lightRim': { en: 'Lights: along the roof', ar: 'الإنارة: على حافة السقف' },
  'si.lightSides': { en: 'Lights: the two long sides', ar: 'الإنارة: على الجهتين الطويلتين' },
  'si.lightNone': { en: 'Lights: none', ar: 'الإنارة: بدون' },
  'si.faceAuto': { en: 'Outside: estimate', ar: 'الواجهة: تقدير' },
  'si.faceBerm': { en: 'Outside: earth bank', ar: 'الواجهة: تلة ترابية' },
  'si.faceTruss': { en: 'Outside: open steel', ar: 'الواجهة: هيكل حديد مكشوف' },
  'si.faceConcrete': { en: 'Outside: bare concrete', ar: 'الواجهة: خرسانة مكشوفة' },
  'si.faceBrick': { en: 'Outside: brick', ar: 'الواجهة: طوب' },
  'si.faceCladding': { en: 'Outside: metal panels', ar: 'الواجهة: ألواح معدنية' },
  'si.faceMembrane': { en: 'Outside: translucent fabric', ar: 'الواجهة: قماش شفّاف' },
  'si.faceLattice': { en: 'Outside: open lattice', ar: 'الواجهة: شبك معماري' },
  'si.facePlain': { en: 'Outside: plain wall', ar: 'الواجهة: جدار سادة' },
  'si.photo': { en: 'Read a photo of the ground', ar: 'اقرأ صورة للملعب' },
  'si.photo.reading': { en: 'Looking at your photo…', ar: 'يطالع صورتك…' },
  'si.photo.agree': { en: '({n} of {of} readings)', ar: '({n} من {of} قراءات)' },
  'si.photo.unsure': { en: 'could not tell:', ar: 'ما قدر يحدد:' },
  'si.photo.nothing': { en: 'Nothing in that photo was clear enough to use.', ar: 'ما في شي واضح كفاية في الصورة.' },
  'si.photo.failed': { en: 'Could not read that photo. Try a wider shot of the ground.', ar: 'ما قدر يقرأ الصورة. جرّب لقطة أوسع للملعب.' },
  'si.build': { en: 'Estimate the bowl', ar: 'قدّر المدرجات' },
  'si.buildFailed': { en: 'Not enough to go on — that footprint is too small or malformed.', ar: 'المعطيات ما تكفي — حدود هذا الملعب صغيرة أو غير سليمة.' },
  'si.whereFrom': { en: 'Where each number came from', ar: 'من وين جا كل رقم' },
  'si.conf.measured': { en: 'measured', ar: 'مقيس' },
  'si.conf.derived': { en: 'derived', ar: 'محسوب' },
  'si.conf.suggested': { en: 'guessed', ar: 'مخمّن' },
  'si.conf.given': { en: 'you said', ar: 'أنت قلته' },
  'si.confirm': { en: 'Worth checking:', ar: 'يستاهل تتأكد منه:' },
  'si.add': { en: 'Add to my stadiums', ar: 'أضفه لملاعبي' },
  'si.added': { en: 'Added', ar: 'انضاف' },
  'si.seats': { en: 'seats', ar: 'مقعد' },
  // human names for the template's fields, so the table does not read as a
  // debug dump to someone who has never seen a StadiumTemplate
  'si.f.plan.a': { en: 'Bowl length', ar: 'طول المدرج' },
  'si.f.plan.b': { en: 'Bowl width', ar: 'عرض المدرج' },
  'si.f.plan.exponent': { en: 'Corner shape', ar: 'شكل الأركان' },
  'si.f.aisles.count': { en: 'Aisles', ar: 'الممرات' },
  'si.f.seatPitch': { en: 'Seat spacing', ar: 'تباعد المقاعد' },
  'si.f.tiers.length': { en: 'Number of tiers', ar: 'عدد الطوابق' },
  'si.f.tiers.rows': { en: 'Rows of seats', ar: 'صفوف المقاعد' },
  'si.f.cornerCut': { en: 'Open corners', ar: 'أركان مفتوحة' },
  'si.f.track': { en: 'Running track', ar: 'مضمار الجري' },
  'si.f.lighting.style': { en: 'Floodlights', ar: 'الإنارة' },
  'si.f.facade.style': { en: 'Outside of the bowl', ar: 'واجهة المدرجات' },
  'si.f.roof.coverage': { en: 'Roof', ar: 'السقف' },
  'si.note.ring': { en: '{n} points off the imagery, {rms}% rms radial', ar: '{n} نقطة من صور جوية، انحراف قطري {rms}%' },
  'si.note.inset': { en: 'outer {a}x{b} m pulled in {inset} m — the plan is row 0, not the outer wall', ar: 'الحدود الخارجية {a}×{b} م مسحوبة {inset} م — الخطة هي الصف صفر مو الجدار الخارجي' },
  'si.note.band': { en: 'a {m} m band of seating, at about 0.8 m per row', ar: 'شريط مدرجات {m} م، بمعدل ٠٫٨ م للصف' },
  'si.note.capacity': { en: '{built} built against {stated} stated — {pct}% out', ar: '{built} مقعد مبني مقابل {stated} معلنة — فرق {pct}%' },
  'si.note.aisles': { en: 'a stadium-sized default; the imagery could count the real ones', ar: 'رقم افتراضي لملعب بهذا الحجم؛ الصور الجوية تقدر تعدّ الحقيقية' },
  'si.note.pitch': { en: '~0.5 m is the regulated working figure', ar: '~٠٫٥ م هو الرقم المعتمد نظاماً' },
  'si.note.tiers': { en: 'right on 10 of our 13 stadiums; a photo settles it', ar: 'صح في ١٠ من ١٣ ملعب عندنا؛ صورة وحدة تحسمها' },
  'si.note.lighting': { en: 'guessed from the roof shape; right on 8 of our 13 stadiums, and a photo settles it', ar: 'مخمّن من شكل السقف؛ صح في ٨ من ١٣ ملعب عندنا، وصورة وحدة تحسمها' },
  'si.note.facade': { en: 'nothing public records what a stadium is clad in — one photo settles this', ar: 'ما فيه مصدر عام يسجّل مواد واجهة الملعب — صورة وحدة تحسمها' },
  'si.warn.noRing': { en: 'No seating ring measured, so the plan curve is the building outline pulled in by a guess. Measuring the imagery replaces that guess.', ar: 'ما انقاس شريط المدرجات، فخط الخطة هو حدود المبنى مسحوبة بتخمين. قياس الصور الجوية يشيل هذا التخمين.' },
  'si.warn.capOff': { en: 'Capacity is {pct}% out after solving — either the plan curve or the stated capacity is wrong.', ar: 'السعة طالعة بفرق {pct}% بعد الحل — يا خط الخطة غلط يا السعة المعلنة.' },
  'si.warn.noCapacity': { en: 'No capacity given, so the row count is a guess with nothing checking it.', ar: 'ما فيه سعة، فعدد الصفوف تخمين وما فيه شي يتحقق منه.' },
  'sp.import': { en: 'Import from JSON', ar: 'استورد من JSON' },
  'sp.importBad': { en: 'That JSON is not a valid stadium template.', ar: 'هذا الـ JSON مو قالب ملعب صالح.' },

  // ---- stadium import ----
  'sp.imported': { en: 'Imported', ar: 'انستورد' },

  // ---- toolbar selects ----
  'rev.lr': { en: 'Sweep left → right', ar: 'كنس من اليسار لليمين' },
  'rev.rl': { en: 'Sweep right → left', ar: 'كنس من اليمين لليسار' },
  'rev.up': { en: 'Rise from pitch', ar: 'يطلع من الملعب' },
  'rev.center': { en: 'Open from center', ar: 'يفتح من النص' },
  'rev.sections': { en: 'Section by section', ar: 'قطاع ورا قطاع' },
  'rev.rows': { en: 'Row by row', ar: 'صف ورا صف' },
  'rev.random': { en: 'Sparkle (random)', ar: 'تلألؤ (عشوائي)' },
  'rev.instant': { en: 'Instant', ar: 'فوري' },
  'ed.colors.editT': { en: 'hold to edit or remove', ar: 'استمر بالضغط عشان تعدّله أو تشيله' },
  'ed.colors.swatch': { en: 'Swatch', ar: 'لون' },

  // ---- section nav and status bar ----
  'ed.section': { en: 'section', ar: 'قطاع' },
  'ed.stat.made': { en: 'map generated in', ar: 'خريطة المقاعد جهّزت في' },

  // ---- stadium switch ----
  'sp.changeQ': { en: 'Change stadium to', ar: 'تبي تبدّل الملعب إلى' },
  'sp.changeMsg': { en: 'Changing stadiums may reposition, resize, crop, or remove parts of your current design because stadium layouts differ. Are you sure you want to continue?', ar: 'تبديل الملعب ممكن ينقل أجزاء من تصميمك أو يغيّر حجمها أو يقصّها أو يشيلها، لأن تخطيطات الملاعب تختلف. متأكد تبي تكمل؟' },
  'sp.continue': { en: 'Continue', ar: 'كمّل' },

  // ---- reset, community and seat pages ----
  'rs.title': { en: 'Reset your password', ar: 'أعد تعيين كلمة المرور' },
  'rs.new': { en: 'New password', ar: 'كلمة مرور جديدة' },
  'rs.ph': { en: 'at least {min} characters', ar: '{min} خانة على الأقل' },
  'rs.confirm': { en: 'Confirm new password', ar: 'أكّد كلمة المرور الجديدة' },
  'rs.submit': { en: 'Update password', ar: 'حدّث كلمة المرور' },
  'rs.updating': { en: 'Updating…', ar: 'يحدّث…' },
  'rs.done': { en: 'Your password has been updated.', ar: 'تم تحديث كلمة المرور.' },
  'rs.goSignIn': { en: 'Go to sign in', ar: 'روح لتسجيل الدخول' },
  'rs.noToken': { en: 'This reset link is missing its token. Request a new one from the sign-in screen.', ar: 'رابط إعادة التعيين ناقص الرمز. اطلب رابط جديد من شاشة تسجيل الدخول.' },
  'rs.tooShort': { en: 'Password must be at least {min} characters.', ar: 'كلمة المرور لازم {min} خانة على الأقل.' },
  'rs.mismatch': { en: 'Passwords do not match.', ar: 'كلمتا المرور ما تطابقن.' },
  'rs.badLink': { en: 'That reset link is invalid or has expired.', ar: 'رابط إعادة التعيين غير صالح أو منتهي.' },
  'cm.notif': { en: 'Notifications', ar: 'الإشعارات' },
  'cm.searchUsers': { en: 'Search creators by @username…', ar: 'ابحث عن مصمّمين بـ @اسم المستخدم…' },
  'cm.loading': { en: 'Loading the community feed…', ar: 'نجيب منشورات المجتمع…' },

  // ---- community page ----
  'cm.empty': { en: 'No tifos here yet. Be the first to publish one!', ar: 'ما فيه تيفوهات هنا. كن أول واحد ينشر!' },
  'cm.errDelete': { en: 'Could not delete', ar: 'ما قدرنا نحذف' },
  'cm.errComment': { en: 'Could not post comment', ar: 'ما قدرنا ننشر التعليق' },
  'cm.errVote': { en: 'Could not register your vote', ar: 'ما قدرنا نسجّل تصويتك' },
  'cm.errReply': { en: 'Could not reply', ar: 'ما قدرنا نرد' },
  'cm.errFollow': { en: 'Could not update follow', ar: 'ما قدرنا نحدّث المتابعة' },
  'cm.remixed': { en: 'Remixed! Opening in the editor…', ar: 'انسخت! نفتحها في المحرر…' },
  'cm.reportThanks': { en: 'Thanks: your report has been sent.', ar: 'شكرًا، انرسل بلاغك.' },
  'cm.errFeed': { en: 'Could not load the feed. Please try again.', ar: 'ما قدرنا نحمّل المنشورات. جرّب مرة ثانية.' },
  'cm.loadMore': { en: 'Load more', ar: 'حمّل المزيد' },
  'cm.badgeTemplate': { en: 'Template', ar: 'قالب' },
  'cm.badgePhoto': { en: 'Real photo', ar: 'صورة حقيقية' },
  'theme.dark': { en: 'Dark mode', ar: 'الوضع الليلي' },
  'theme.light': { en: 'Light mode', ar: 'الوضع النهاري' },
  'cm.by': { en: 'by', ar: 'بواسطة' },

  // ---- comments + views (the community modal) ----
  'cm.comments': { en: 'Comments', ar: 'التعليقات' },
  'cm.commentsN': { en: '{n} comments', ar: '{n} تعليق' },
  'cm.noComments': { en: 'No comments yet, be the first.', ar: 'ما فيه تعليقات، كن أول واحد.' },
  'cm.addComment': { en: 'Add a comment…', ar: 'اكتب تعليق…' },
  'cm.post': { en: 'Post', ar: 'انشر' },
  'cm.reply': { en: 'Reply', ar: 'رد' },
  'cm.replyTo': { en: 'Reply to @{name}…', ar: 'رد على @{name}…' },
  // Shown on a reply that is deeper than the indent goes, so the thread is
  // still followable once the offset stops growing.
  'cm.replyingTo': { en: 'replying to @{name}', ar: 'رد على @{name}' },
  'cm.delete': { en: 'Delete', ar: 'احذف' },
  'cm.signIn': { en: 'Sign in', ar: 'سجّل دخول' },
  'cm.joinConvo': { en: 'to join the conversation.', ar: 'عشان تشارك في النقاش.' },
  'cm.explanation': { en: "Creator's explanation", ar: 'كلام المصمم' },
  'cm.viewsWord': { en: 'views', ar: 'مشاهدة' },
  'cm.viewsTitle': { en: 'Times this tifo has been opened', ar: 'كم مرة انفتح هذا التيفو' },

  // ---- the notifications bell ----
  'nt.title': { en: 'Notifications', ar: 'الإشعارات' },
  'nt.markAll': { en: 'Mark all read', ar: 'علّم الكل مقروء' },
  'nt.empty': { en: 'No notifications yet.', ar: 'ما فيه إشعارات بعد.' },
  'nt.someone': { en: 'Someone', ar: 'أحدهم' },
  'nt.aTifo': { en: 'a tifo', ar: 'تيفو' },
  'nt.followPost': { en: '{actor} published {title}', ar: '{actor} نشر {title}' },
  'nt.newFollower': { en: '{actor} started following you', ar: '{actor} صار يتابعك' },
  'nt.comment': { en: '{actor} commented on {title}', ar: '{actor} علّق على {title}' },
  'nt.reply': { en: '{actor} replied to you', ar: '{actor} رد عليك' },
  'nt.remix': { en: '{actor} remixed {title}', ar: '{actor} سوّى ريمكس لـ {title}' },
  'nt.featured': { en: '{title} is the Tifo of the Day on the home page', ar: '{title} هو تيفو اليوم في الصفحة الرئيسية' },
  'nt.generic': { en: '{actor} did something', ar: '{actor} سوّى شي' },
  'nt.gone': { en: 'That tifo is not available any more.', ar: 'هذا التيفو ما عاد موجود.' },
  'cm.shareThis': { en: 'Share this tifo', ar: 'شارك هذا التيفو' },
  'cm.cardBy': { en: '{title} by {name}', ar: '{title} بواسطة {name}' },

  // Gallery tag chips. The starter library seeds these, so in Arabic they were
  // the one place the feed still read as English. A tag somebody types
  // themselves has no entry here and shows exactly as they wrote it.
  'tag.club': { en: 'club', ar: 'نادي' },
  'tag.arabic': { en: 'Arabic', ar: 'عربي' },
  'tag.palette': { en: 'palette', ar: 'لوحة ألوان' },
  'tag.pattern': { en: 'pattern', ar: 'نقشة' },
  'tag.split': { en: 'split', ar: 'تقسيم' },
  'tag.block': { en: 'block', ar: 'كتلة' },
  'tag.banner': { en: 'banner', ar: 'لافتة' },
  'tag.crest': { en: 'crest', ar: 'شعار' },
  'tag.checker': { en: 'checker', ar: 'رقعة شطرنج' },
  'tag.chevron': { en: 'chevron', ar: 'أسهم' },
  'tag.hoops': { en: 'hoops', ar: 'حلقات' },
  'tag.scarf': { en: 'scarf', ar: 'شال' },
  'tag.sash': { en: 'sash', ar: 'وشاح' },
  'tag.halves': { en: 'halves', ar: 'نصفان' },
  'tag.flag': { en: 'flag', ar: 'علم' },
  'tag.gradient-wall': { en: 'gradient wall', ar: 'جدار متدرّج' },
  'tag.ends-and-sides': { en: 'ends and sides', ar: 'الأطراف والجوانب' },
  'tag.tier-split': { en: 'tier split', ar: 'تقسيم الطوابق' },
  'tag.banner-framed': { en: 'framed banner', ar: 'لافتة بإطار' },
  'tag.crest-on-stripes': { en: 'crest on stripes', ar: 'شعار على خطوط' },
  'tag.crest-and-word': { en: 'crest and word', ar: 'شعار وكلمة' },
  'tag.mosaic-word': { en: 'mosaic word', ar: 'فسيفساء بكلمة' },
  'tag.goalline-band': { en: 'goal-line band', ar: 'شريط أمامي' },
  'cm.shown': { en: '{n} shown', ar: 'ظهر {n}' },
  'cm.errProfile': { en: 'Could not load this profile.', ar: 'ما قدرنا نحمّل هذا الملف.' },
  'cm.errRender': { en: 'Could not render this tifo.', ar: 'ما قدرنا نعرض هذا التيفو.' },
  'cm.report': { en: 'Report this design', ar: 'بلّغ عن هذا التصميم' },
  'cm.reportWhy': { en: 'Report this design: why? (e.g. offensive, infringes my rights, spam)', ar: 'بلّغ عن هذا التصميم: ليش؟ (مثلاً مسيء، ينتهك حقوقي، مزعج)' },
  'cm.follow': { en: 'Follow', ar: 'متابعة' },
  'cm.following': { en: 'Following', ar: 'متابَع' },

  // ---- landing tagline ----
  'ld.tagline': { en: 'The global standard platform for stadium choreography.', ar: 'المنصة العالمية المعتمدة لتصميم عروض المدرجات.' },

  // ---- skip links and menu ----
  'nav.menu': { en: 'Menu', ar: 'القائمة' },

  // ---- public tifo page ----
  'sh.unavailable': { en: 'Tifo unavailable', ar: 'التيفو غير متاح' },
  'sh.browse': { en: 'Browse the community', ar: 'تصفّح المجتمع' },
  'sh.noId': { en: 'No tifo was specified in the link.', ar: 'الرابط ما يحدّد أي تيفو.' },
  'sh.private': { en: 'This tifo is private.', ar: 'هذا التيفو خاص.' },
  'sh.open': { en: 'Open in TifoMaker', ar: 'افتحه في تيفو ميكر' },
  'sh.remix': { en: 'Remix', ar: 'عدّل نسخة' },
  'sh.views': { en: 'views', ar: 'مشاهدة' },
  'sh.madeWith': { en: 'Made with', ar: 'مصنوع بـ' },
  'sh.madeWith2': { en: 'design your own 60,000-seat tifo.', ar: 'صمّم تيفوك على 60 ألف مقعد.' },
  'sh.loading': { en: 'Loading the tifo…', ar: 'نجيب التيفو…' },

  // ---- share gone ----
  'sh.gone': { en: 'This tifo is private or no longer available.', ar: 'هذا التيفو خاص أو ما عاد متاح.' },

  // ---- legal page ----
  'lg.title': { en: 'Legal · TifoMaker', ar: 'الشروط والخصوصية · تيفو ميكر' },
  'lg.home': { en: '← Home', ar: '← الرئيسية' },
  'lg.homeLink': { en: 'Home', ar: 'الرئيسية' },
  'lg.terms': { en: 'Terms', ar: 'الشروط' },
  'lg.privacy': { en: 'Privacy', ar: 'الخصوصية' },
  'lg.au': { en: 'Acceptable Use', ar: 'الاستخدام المقبول' },
  'lg.cookies': { en: 'Cookies', ar: 'الكوكيز' },
  'lg.footer': { en: 'TifoMaker: an independent project by one developer, built with the help of AI. Not affiliated with any club, league, or stadium.', ar: 'تيفو ميكر: مشروع مستقل من مطوّر واحد، مبني بمساعدة الذكاء الاصطناعي. ما له ارتباط بأي نادي أو دوري أو ملعب.' },

  // ---- server errors, mapped from the API's English message ----
  'err.badCreds': { en: 'Wrong email or password.', ar: 'البريد أو كلمة المرور غلط.' },
  'err.badPassword': { en: 'Incorrect password.', ar: 'كلمة المرور غلط.' },
  'err.badCurrentPassword': { en: 'Your current password is incorrect.', ar: 'كلمة المرور الحالية غلط.' },
  'err.emailTaken': { en: 'That email is already in use.', ar: 'هذا البريد مستخدم من قبل.' },
  'err.addressMailCap': { en: 'We sent that address a message a moment ago. Give it a few minutes before trying again.', ar: 'أرسلنا لهذا البريد رسالة قبل شوي. انتظر كم دقيقة قبل ما تجرّب مرة ثانية.' },
  'err.verifyDailyCap': { en: 'That is the most verification emails one account can get in a day. Use the code from your last message, or try again tomorrow.', ar: 'وصلت للحد اليومي لرسائل التوثيق. استخدم الرمز من آخر رسالة، أو جرّب بكرة.' },
  'err.photoType': { en: 'Photos must be JPEG, PNG or WebP images.', ar: 'الصورة لازم تكون بصيغة JPEG أو PNG أو WebP.' },
  'err.aiResting': { en: 'The AI has done all it can for today. Try again tomorrow.', ar: 'الذكاء الاصطناعي خلّص حصته لليوم. جرّب بكرة.' },
  'err.authRequired': { en: 'Please sign in first.', ar: 'سجّل دخولك أول.' },
  'err.adminRequired': { en: 'Admin access is required.', ar: 'هذا يحتاج صلاحية مدير.' },
  'err.modRequired': { en: 'Moderator access is required.', ar: 'هذا يحتاج صلاحية مشرف.' },
  'err.designNotFound': { en: 'That design was not found.', ar: 'ما لقينا هذا التصميم.' },
  'err.notFound': { en: 'Not found.', ar: 'ما لقيناه.' },
  'err.notAllowed': { en: 'Not found, or you do not have access.', ar: 'ما لقيناه، أو ما عندك صلاحية.' },
  'err.notYours': { en: 'That is not yours to change.', ar: 'هذا مو حقك عشان تغيّره.' },
  'err.notPublic': { en: 'That design is not public.', ar: 'هذا التصميم مو عام.' },
  'err.saveFailed': { en: 'Could not save that, please try again.', ar: 'ما قدرنا نحفظ، جرّب مرة ثانية.' },
  'err.pwTooShort': { en: 'The new password must be at least 8 characters.', ar: 'كلمة المرور الجديدة لازم 8 خانات على الأقل.' },
  'err.badReset': { en: 'That reset link is invalid or has expired.', ar: 'رابط إعادة التعيين غير صالح أو منتهي.' },
  'err.needEmail': { en: 'A valid email is required.', ar: 'لازم بريد إلكتروني صحيح.' },
  'err.noEmail': { en: 'There is no email on file for this account.', ar: 'ما فيه بريد مسجّل على هذا الحساب.' },
  'err.needPrompt': { en: 'Write what you want first.', ar: 'اكتب وش تبي أول.' },
  'err.aiFailed': { en: 'The AI could not produce a valid design. Try rewording it.', ar: 'الذكاء الاصطناعي ما قدر يطلع تصميم صالح. جرّب تعيد صياغة الوصف.' },
  'err.aiOff': { en: 'The AI Designer is not available right now.', ar: 'مصمّم الذكاء الاصطناعي مو متاح حاليًا.' },
  'err.badStadium': { en: 'That stadium template is not valid.', ar: 'قالب الملعب هذا غير صالح.' },
  'err.photoNotFound': { en: 'That photo was not found.', ar: 'ما لقينا هذي الصورة.' },
  'err.imageSize': { en: 'The image must be between 1 and 2 MB.', ar: 'الصورة لازم تكون بين 1 و 2 ميجابايت.' },
  'err.needComment': { en: 'Write a comment first.', ar: 'اكتب تعليق أول.' },
  'err.commentFailed': { en: 'Could not add that comment.', ar: 'ما قدرنا نضيف التعليق.' },
  'err.aiSignIn': { en: 'Sign in to use the AI Designer.', ar: 'سجّل دخولك عشان تستخدم مصمّم الذكاء الاصطناعي.' },
  'err.aiVerify': { en: 'Verify your email to use the AI Designer.', ar: 'وثّق بريدك عشان تستخدم مصمّم الذكاء الاصطناعي.' },

  // ---- final gaps ----
  'consent.aria': { en: 'Cookie choices', ar: 'خيارات الكوكيز' },

  // ---- last gaps ----
  'gal.emptyAll': { en: 'No public tifos yet, be the first! Design something, then tick "List in public gallery" and Save.', ar: 'ما فيه تيفوهات عامة بعد، كن أول واحد! صمّم شي، وبعدين علّم على «انشره في المعرض العام» واحفظ.' },

  // ---- phone editor shell (ui/mobileShell.ts) ----
  'mb.paint': { en: 'Paint', ar: 'الرسم' },
  'mb.add': { en: 'Add', ar: 'إضافة' },
  'mb.ai': { en: 'AI', ar: 'الذكاء' },
  'mb.more': { en: 'More', ar: 'المزيد' },
  'mb.jump': { en: 'Jump to a stand', ar: 'انتقل لمدرج' },
  'mb.all': { en: 'All', ar: 'الكل' },
  'mb.mdLoading': { en: 'Loading…', ar: 'جاري التحميل…' },
  'mb.mdFailed': { en: 'Could not load', ar: 'ما قدر يحمّل' },
  'mb.undoTap': { en: 'Undone', ar: 'تم التراجع' },
  'mb.fitTap': { en: 'Whole stadium', ar: 'الملعب كامل' },

  // ---- phone viewer (shared /d/:id links) ----
  'v.open': { en: 'Edit on desktop', ar: 'عدّل على الكمبيوتر' },
  'v.openT': { en: 'Open the full editor on desktop', ar: 'افتح المحرر الكامل على الكمبيوتر' },
  'v.share': { en: 'Share', ar: 'مشاركة' },
  'v.forkT': { en: 'Open as a working copy', ar: 'افتحه كنسخة للعمل عليها' },
  'v.gallery': { en: 'From the gallery', ar: 'من المعرض' },
  'v.empty': { en: 'Nothing published yet.', ar: 'ما فيه شي منشور لين الحين.' },
  'v.unavailable': { en: 'Gallery unavailable.', ar: 'المعرض غير متاح.' },
  'v.by': { en: 'by', ar: 'بواسطة' },

  // ---- first-run onboarding ----
  'ob.aria': { en: 'Welcome to Tifo Maker', ar: 'أهلاً بك في تيفو ميكر' },
  'ob.title': { en: 'Start your tifo', ar: 'ابدأ تيفوك' },
  'ob.lead': { en: 'A blank 60,000-seat bowl is a lot. Name your project and pick a starting point, you can change everything later.', ar: 'مدرج فاضي فيه 60 ألف مقعد شيء كبير. سمِّ مشروعك واختر نقطة بداية، وكل شي تقدر تغيّره بعدين.' },
  'ob.name': { en: 'Project name', ar: 'اسم المشروع' },
  'ob.namePh': { en: 'e.g. Derby Day Wall', ar: 'مثلاً: جدار الديربي' },
  'ob.nameDefault': { en: 'My first tifo', ar: 'أول تيفو لي' },
  'ob.start': { en: 'Choose a starting point', ar: 'اختر نقطة البداية' },
  'ob.blank': { en: 'Start blank', ar: 'ابدأ من فاضي' },
  'ob.blank.b': { en: 'An empty bowl. Paint freely from scratch.', ar: 'مدرج فاضي. ارسم على راحتك من الصفر.' },
  'ob.patterns': { en: 'Stripes & patterns', ar: 'خطوط ونقشات' },
  'ob.patterns.b': { en: 'Begin with hoops, halves, or a sash.', ar: 'ابدأ بحلقات أو نصفين أو وشاح.' },
  'ob.crest': { en: 'Club crest setup', ar: 'تجهيز شعار النادي' },
  'ob.crest.b': { en: 'A centered canvas, ready for your logo.', ar: 'لوحة موسّطة وجاهزة لشعارك.' },
  'ob.text': { en: 'Typography / text', ar: 'خطوط ونصوص' },
  'ob.text.b': { en: 'Start with a banner of big text.', ar: 'ابدأ بلافتة فيها نص كبير.' },
  'ob.which': { en: 'Which pattern?', ar: 'أي نقشة؟' },
  'ob.colors': { en: 'Pick your colors', ar: 'اختر ألوانك' },
  'ob.go': { en: 'Start designing', ar: 'ابدأ التصميم' },
  'ob.tour': { en: 'Start with a tour', ar: 'ابدأ بجولة تعريفية' },
  'ob.skip': { en: 'Skip', ar: 'تخطّي' },

  // ---- names that are also ids (palettes, patterns, stadiums, cameras) ----
  'pat.split': { en: 'Split stands', ar: 'مدرجات مقسومة' },
  'stad.generic60k': { en: 'Generic 60k bowl', ar: 'مدرج عام 60 ألف' },
  'stad.kop40k': { en: 'Single-tier kop 40k', ar: 'مدرج بطابق واحد 40 ألف' },
  'stad.oval76k': { en: 'Grand oval 76k', ar: 'بيضاوي كبير 76 ألف' },
  'cam.tv': { en: 'TV gantry', ar: 'كاميرا النقل' },
  'cam.goal': { en: 'Behind goal', ar: 'خلف المرمى' },
  'cam.pitch': { en: 'Pitch level', ar: 'مستوى الملعب' },
  'cam.aerial': { en: 'Aerial', ar: 'من فوق' },
  'cam.full': { en: 'Full view', ar: 'العرض الكامل' },
  'ed.region.hint': { en: 'seats selected. Recolor with the active swatch, or clear them.', ar: 'مقعد محدّد. لوّنها باللون الحالي، أو امسحها.' },
  'ed.a11y.tools': { en: 'Tools', ar: 'الأدوات' },
  'ed.tool.brushT': { en: 'Brush (B)', ar: 'الفرشاة (B)' },
  'ed.tool.eraserT': { en: 'Eraser (E)', ar: 'الممحاة (E)' },
  'ed.tool.eraser': { en: 'Eraser', ar: 'الممحاة' },
  'ed.tool.fillT': { en: 'Fill (F)', ar: 'التعبئة (F)' },
  'ed.tool.fill': { en: 'Fill', ar: 'التعبئة' },
  'ed.tool.eyedropT': { en: 'Eyedropper: pick a colour (I)', ar: 'القطّارة: التقط لون (I)' },
  'ed.tool.eyedrop': { en: 'Eyedropper', ar: 'القطّارة' },
  'ed.tool.textT': { en: 'Text (T)', ar: 'النص (T)' },
  'ed.tool.text': { en: 'Text', ar: 'النص' },
  'ed.tool.importT': { en: 'Import image', ar: 'استورد صورة' },
  'ed.tool.import': { en: 'Import image', ar: 'استيراد صورة' },
  'ed.tool.shapesT': { en: 'Shapes (S)', ar: 'الأشكال (S)' },
  'ed.tool.shapes': { en: 'Shapes', ar: 'الأشكال' },
  'ed.tool.panT': { en: 'Pan (Space)', ar: 'تحريك العرض (مسافة)' },
  'ed.tool.pan': { en: 'Pan', ar: 'تحريك العرض' },
  'ed.tool.selectT': { en: 'Select: drag a box to grab an area, or click a region · move objects (V)', ar: 'التحديد: اسحب مربع عشان تاخذ منطقة، أو اضغط قطاع · وحرّك العناصر (V)' },
  'ed.tool.select': { en: 'Select', ar: 'التحديد' },
  'ed.tool.bannerT': { en: 'Banners: draw a sheet and hang it on the stands', ar: 'اللافتات: ارسم قماشة وعلّقها على المدرجات' },
  'ed.bannerStudio': { en: 'Banners', ar: 'اللافتات' },

  // ---- banners ----
  // Every sentence here is whole. Arabic puts the number and the name in
  // different places from English, so a message assembled from fragments is
  // wrong in one of the two languages however carefully the fragments are
  // translated — the finding from the September editor audit.
  'bn.banner': { en: 'Banner', ar: 'لافتة' },
  'bn.defaultName': { en: 'Banner 1', ar: 'لافتة ١' },
  'bn.nameN': { en: 'Banner {n}', ar: 'لافتة {n}' },
  'bn.newT': { en: 'New banner', ar: 'لافتة جديدة' },
  'bn.delT': { en: 'Delete this banner', ar: 'احذف هذي اللافتة' },
  'bn.type': { en: 'Type', ar: 'النوع' },
  'bn.size': { en: 'Size', ar: 'المقاس' },
  'bn.shape': { en: 'Shape', ar: 'الشكل' },
  // Named in blocks, because that is how a crew describes a banner.
  'bn.preset': { en: 'Size', ar: 'المقاس' },
  'bn.preset.custom': { en: 'Custom', ar: 'مخصّص' },
  'bn.preset.one': { en: 'One block', ar: 'قطاع واحد' },
  'bn.preset.oneTall': { en: 'One block, tall', ar: 'قطاع واحد، طولي' },
  'bn.preset.two': { en: 'Two blocks', ar: 'قطاعان' },
  'bn.preset.twoTall': { en: 'Two blocks, tall', ar: 'قطاعان، طولي' },
  'bn.preset.four': { en: 'Four blocks', ar: 'أربعة قطاعات' },
  'bn.msg.preset': { en: 'Sized to {name}.', ar: 'انضبط المقاس على {name}.' },
  // The size is a READOUT, not a field: a banner is as wide as the blocks it
  // covers, so what the panel can say is what those blocks come to here.
  'bn.size.is': { en: '{w} x {h} m on this ground', ar: '{w} × {h} م في هذا الملعب' },
  'bn.size.about': { en: 'about {w} x {h} m', ar: 'حوالي {w} × {h} م' },
  'bn.m': { en: 'm', ar: 'م' },
  'bn.cm': { en: '{n} cm', ar: '{n} سم' },
  'bn.material': { en: 'Fabric', ar: 'القماش' },
  'bn.solid': { en: 'Solid', ar: 'صلب' },
  'bn.mesh': { en: 'Mesh (perforated)', ar: 'شبك (مثقّب)' },
  'bn.seams': { en: 'Seams', ar: 'الخياطات' },
  'bn.seamsT': { en: 'Show where the 3 m fabric panels are joined', ar: 'ورّني وين تنخاط ألواح القماش كل ٣ أمتار' },
  'bn.guides': { en: 'Guides', ar: 'الأدلة' },
  'bn.guidesT': { en: 'Centre lines, thirds, and the smallest type that reads across the pitch', ar: 'خطوط المنتصف والأثلاث، وأصغر خط يُقرأ من الطرف الثاني' },
  'bn.snap': { en: 'Snap', ar: 'المحاذاة' },
  'bn.snapT': { en: 'Snap what you place to the centre, the thirds and the seams', ar: 'حاذِ اللي تحطّه على المنتصف والأثلاث والخياطات' },
  'bn.bg': { en: 'Fabric colour', ar: 'لون القماش' },
  'bn.clear': { en: 'None', ar: 'بدون' },
  'bn.clearT': { en: 'No fabric behind the art — the stand shows through', ar: 'بدون قماش خلف الرسم — المدرج يبيّن من وراه' },
  'bn.a11y.shape': { en: 'Shape of the banner, wide to tall', ar: 'شكل اللافتة، من العريض إلى الطويل' },
  'bn.a11y.gsm': { en: 'Fabric weight', ar: 'وزن القماش' },
  'bn.a11y.brush': { en: 'Brush width in centimetres', ar: 'عرض الفرشاة بالسنتيمترات' },

  'bn.kind.stand': { en: 'Stand banner', ar: 'لافتة المدرج' },
  'bn.kind.hanging': { en: 'Hanging banner', ar: 'لافتة معلّقة' },

  'bn.place': { en: 'Placement', ar: 'الموضع' },
  'bn.place.tag': { en: 'where it hangs', ar: 'وين تتعلّق' },
  'bn.stand': { en: 'Stand', ar: 'المدرج' },
  'bn.across': { en: 'Across', ar: 'الامتداد' },
  'bn.across.one': { en: 'This stand', ar: 'هذا المدرج' },
  'bn.across.two': { en: 'Two stands, round the corner', ar: 'مدرجان، حول الزاوية' },
  'bn.block': { en: 'Blocks', ar: 'القطاعات' },
  'bn.block.centred': { en: 'Centred', ar: 'في المنتصف' },
  'bn.block.n': { en: 'From block {n}', ar: 'من القطاع {n}' },
  'bn.span.one': { en: 'one block', ar: 'قطاع واحد' },
  'bn.span.n': { en: '{n} blocks', ar: '{n} قطاعات' },
  'bn.tier': { en: 'Tier', ar: 'الطابق' },
  'bn.tier.all': { en: 'Whole stand', ar: 'المدرج كامل' },
  'bn.tier.n': { en: 'Tier {n}', ar: 'الطابق {n}' },
  'bn.fit.capped': {
    en: 'This stand takes {n} blocks at this shape — a wider design would use more of it',
    ar: 'هذا المدرج يسع {n} قطاعات بهذا الشكل — تصميم أعرض بيستغل أكثر',
  },
  'bn.fit.short': {
    en: 'The stand runs out of rake first — {fw} x {fh} m',
    ar: 'المدرج ما يكفي عمقًا — {fw} × {fh} م',
  },
  'bn.centre': { en: 'Centre it', ar: 'وسّطها' },
  'bn.centreT': { en: 'Put it dead centre on the stand', ar: 'حطّها بالضبط في منتصف المدرج' },
  'bn.net': { en: 'Rope net', ar: 'شبكة حبال' },
  'bn.bar': { en: 'Weight bar', ar: 'قضيب ثقل' },
  'bn.reveal': { en: 'Reveal', ar: 'الكشف' },
  'bn.reveal.tag': { en: 'match day', ar: 'يوم المباراة' },
  'bn.rev.unroll': { en: 'Unroll down the stand', ar: 'تنفرد على المدرج' },
  'bn.rev.hoist': { en: 'Haul up on ropes', ar: 'تُسحب للأعلى بالحبال' },
  'bn.rev.cut': { en: 'Already up', ar: 'موجودة من قبل' },
  'bn.secs': { en: 'Seconds', ar: 'ثواني' },
  'bn.wind': { en: 'Wind', ar: 'الهواء' },
  'bn.seeIt': { en: 'See it on match day', ar: 'شوفها يوم المباراة' },
  'bn.brush': { en: 'Banner brush', ar: 'فرشاة اللافتة' },
  'bn.clearArt': { en: 'Clear the art', ar: 'امسح الرسم' },

  'bn.facts': {
    en: '{panels} panels · {kg} kg · headline {cap} m to read across the pitch',
    ar: '{panels} لوح · {kg} كجم · العنوان {cap} م عشان يُقرأ من الطرف الثاني',
  },
  'bn.note.seams': {
    en: 'Sewn from {panels} panels — no printer makes fabric wider than {panelM} m, so keep a face off a seam.',
    ar: 'مخيّطة من {panels} ألواح — ما في مطبعة تطبع قماش أعرض من {panelM} م، فخلّ الوجه بعيد عن الخياطة.',
  },
  'bn.note.carry': {
    en: 'About {kg} kg of fabric — roughly {people} people to carry it in.',
    ar: 'تقريباً {kg} كجم قماش — يعني حوالي {people} شخص عشان يدخّلونها.',
  },
  'bn.note.mesh': {
    en: 'Mesh passes air, but the holes eat about a third of the ink: keep strokes thick and the type bold.',
    ar: 'الشبك يمرّر الهواء، بس الثقوب تاكل ثلث الحبر تقريباً: خلّ الخطوط سميكة والكتابة عريضة.',
  },
  'bn.note.wind': {
    en: 'A solid sheet of {area} m² held out from the stand is a sail. Mesh is the usual answer.',
    ar: 'قماش صلب بمساحة {area} م² مفرود بعيد عن المدرج يصير شراع. الشبك هو الحل المعتاد.',
  },
  'bn.note.net': {
    en: '{area} m² of light fabric will tear if it hangs from its own edge. A rope net carries the load.',
    ar: '{area} م² من القماش الخفيف بينقطع إذا تعلّق من حافته. شبكة الحبال هي اللي تشيل الحمل.',
  },
  'bn.note.occludes': {
    en: 'This one ends up on top of the crowd, so it covers the card mosaic underneath it.',
    ar: 'هذي تنتهي فوق الجمهور، يعني تغطّي فسيفساء الكروت اللي تحتها.',
  },
  'bn.note.poles': {
    en: 'Banner poles are capped at 1.5-2 m and 3 cm across, and the limit is the club’s, not the league’s.',
    ar: 'أعمدة اللافتات محدودة بـ ١٫٥-٢ م وقطر ٣ سم، والحد من النادي مو من الدوري.',
  },
  'bn.note.fire': {
    en: 'Printers certify tifo fabric to EN 13501-1 B-s1,d0; the certificate travels with the banner.',
    ar: 'المطابع تعتمد قماش التيفو حسب EN 13501-1 B-s1,d0، والشهادة تروح مع اللافتة.',
  },
  'bn.msg.added': { en: 'New banner added. Draw on it, then hang it on a stand.', ar: 'انضافت لافتة جديدة. ارسم عليها، وبعدين علّقها على مدرج.' },
  'bn.msg.kind': { en: 'Now a {name} — the rig and the reveal changed with it.', ar: 'صارت {name} — والتعليق وطريقة الكشف تغيّروا معها.' },
  'bn.msg.centred': { en: 'Centred on the stand.', ar: 'انوسّطت على المدرج.' },
  'bn.msg.cleared': { en: 'Banner cleared.', ar: 'انمسحت اللافتة.' },
  'bn.msg.placedOnBanner': { en: 'Added to the banner. Drag the handles to size it.', ar: 'انضاف على اللافتة. اسحب المقابض عشان تضبط المقاس.' },
  'save.sceneFailed': {
    en: 'Tifo saved, but the banners did not: {err}',
    ar: 'انحفظ التيفو، بس اللافتات لا: {err}',
  },
  'ed.rail.stadiumT': { en: 'Stadium', ar: 'الملعب' },
  'ed.rail.stadium': { en: 'Stadium configuration', ar: 'إعدادات الملعب' },
  'ed.rail.aiT': { en: 'AI Designer', ar: 'مصمّم الذكاء الاصطناعي' },
  'ed.rail.ai': { en: 'AI tifo designer', ar: 'مصمّم التيفو بالذكاء الاصطناعي' },
  'ed.rail.animT': { en: 'Animation', ar: 'الحركة' },
  'ed.rail.anim': { en: 'Animation preferences', ar: 'إعدادات الحركة' },
  'ed.rail.saveT': { en: 'Save and export', ar: 'الحفظ والتصدير' },
  'ed.rail.save': { en: 'Save and export', ar: 'الحفظ والتصدير' },
  'ed.a11y.docTitle': { en: 'Design title', ar: 'اسم التصميم' },
  'ed.view.splitT': { en: 'Paint while watching the stadium update live', ar: 'ارسم وشوف الملعب يتحدّث مباشرة' },
  'ed.moderationQueue': { en: 'Moderation queue', ar: 'قائمة الإشراف' },
  'ed.import.realColorsT': { en: 'Use the picture\'s own colours as the palette', ar: 'استخدم ألوان الصورة نفسها كلوحة ألوان' },
  'ed.matchDayT': { en: 'Open the Match Day Simulator (high-fidelity view)', ar: 'افتح محاكي يوم المباراة (عرض عالي الدقة)' },
  'ed.a11y.zoomOut': { en: 'Zoom out', ar: 'تصغير' },
  'ed.a11y.zoomIn': { en: 'Zoom in', ar: 'تكبير' },
  'ed.a11y.fit': { en: 'Fit to view', ar: 'ملء الشاشة' },
  'ed.a11y.panel': { en: 'Properties', ar: 'الخصائص' },
  'ed.a11y.panelToggle': { en: 'Collapse panel', ar: 'طيّ اللوحة' },
  'ed.region.deleteT': { en: 'Clear selected seats', ar: 'امسح المقاعد المحدّدة' },
  'ed.a11y.objX': { en: 'Position across the bowl, in seats', ar: 'الموضع أفقيًا حول المدرج، بالمقاعد' },
  'ed.a11y.objY': { en: 'Position up the bowl, in rows', ar: 'الموضع رأسيًا في المدرج، بالصفوف' },
  'ed.obj.deleteT': { en: 'Delete object', ar: 'احذف العنصر' },
  'ed.a11y.brushSize': { en: 'Brush size', ar: 'حجم الفرشاة' },
  'ed.colors.wellT': { en: 'Try any color — it is not saved until you press + Color', ar: 'جرّب أي لون — ما ينحفظ إلا لما تضغط + لون' },
  'ed.colors.addT': { en: 'Keep this color in your swatches', ar: 'احتفظ بهذا اللون في ألوانك' },
  'ed.colors.importT': { en: 'Load a .gpl / .hex / .json palette or an image', ar: 'حمّل لوحة .gpl / .hex / .json أو صورة' },
  'ed.colors.saveT': { en: 'Save your current swatches as a reusable palette', ar: 'احفظ ألوانك الحالية كلوحة تقدر تستخدمها مرة ثانية' },
  'ed.colors.mineT': { en: 'Your saved palettes', ar: 'لوحات الألوان المحفوظة عندك' },
  'ed.a11y.stadium': { en: 'Stadium', ar: 'الملعب' },
  'ed.a11y.pattern': { en: 'Pattern', ar: 'النقشة' },
  'ed.ai.shuffleT': { en: 'Compose a multi-stand design instantly, offline: no tokens, no quota', ar: 'ركّب تصميم على عدة مدرجات فورًا وبدون إنترنت: بلا رصيد ولا حصة' },
  'ed.ai.revertT': { en: 'Restore the canvas from before this design', ar: 'رجّع اللوحة لحالتها قبل هذا التصميم' },
  'ed.ai.polishT': { en: 'Render the design and ask the AI to fix legibility and balance', ar: 'ارسم التصميم واطلب من الذكاء الاصطناعي يحسّن الوضوح والتوازن' },
  'common.reset': { en: 'Reset', ar: 'إعادة تعيين' },
  'ed.loadT': { en: 'Open a .tifo file', ar: 'افتح ملف ‎.tifo' },
  'shape.rect': { en: 'Rectangle', ar: 'مستطيل' },
  'shape.ellipse': { en: 'Ellipse', ar: 'بيضاوي' },
  'shape.circle': { en: 'Circle', ar: 'دائرة' },
  'shape.triangle': { en: 'Triangle', ar: 'مثلث' },
  'shape.diamond': { en: 'Diamond', ar: 'معيّن' },
  'shape.line': { en: 'Line / bar', ar: 'خط / شريط' },
  'shape.star': { en: 'Star', ar: 'نجمة' },
  'shape.star6': { en: 'Star (6)', ar: 'نجمة سداسية' },
  'shape.heart': { en: 'Heart', ar: 'قلب' },
  'shape.crown': { en: 'Crown', ar: 'تاج' },
  'shape.shield': { en: 'Shield', ar: 'درع' },
  'shape.ring': { en: 'Ring', ar: 'حلقة' },
  'shape.cross': { en: 'Cross', ar: 'شكل متقاطع' },
  'shape.chevron': { en: 'Chevron', ar: 'سهم مزدوج' },
  'shape.bolt': { en: 'Bolt', ar: 'صاعقة' },
  'shape.flame': { en: 'Flame', ar: 'لهب' },
  'ed.scope.section': { en: 'Section', ar: 'قطاع' },
  'ed.scope.global': { en: 'Global', ar: 'كامل الملعب' },
  'pat.solid': { en: 'Solid', ar: 'لون واحد' },
  'pat.hoops': { en: 'Hoops (row bands)', ar: 'حلقات (شرائح صفوف)' },
  'pat.columns': { en: 'Columns (section bands)', ar: 'أعمدة (شرائح قطاعات)' },
  'pat.checker': { en: 'Checkerboard', ar: 'رقعة شطرنج' },
  'pat.sash': { en: 'Diagonal sash', ar: 'وشاح مائل' },
  'pat.opposite': { en: 'Opposite stands', ar: 'مدرجات متقابلة' },
  'pat.tier': { en: 'Tier split', ar: 'تقسيم الطوابق' },
  'pat.gradient': { en: 'Vertical gradient (dithered)', ar: 'تدرّج عمودي (مموّه)' },
  'pat.borders': { en: 'Base + accent borders', ar: 'أساس + حواف مميّزة' },
  'pal.royal': { en: 'Royal blue / white', ar: 'أزرق ملكي / أبيض' },
  'pal.blackGold': { en: 'Black / gold', ar: 'أسود / ذهبي' },
  'pal.greenWhite': { en: 'Green / white', ar: 'أخضر / أبيض' },
  'pal.redWhiteBlack': { en: 'Red / white / black', ar: 'أحمر / أبيض / أسود' },
  'ed.gif.360': { en: '360 px (small)', ar: '360 بكسل (صغير)' },
  'ed.gif.480': { en: '480 px', ar: '480 بكسل' },
  'ed.gif.640': { en: '640 px (large)', ar: '640 بكسل (كبير)' },
  'ai.ex.champions': { en: 'CHAMPIONS stunt', ar: 'استعراض CHAMPIONS' },
  'ai.ex.ronaldo': { en: 'Ronaldo · north', ar: 'رونالدو · الشمالي' },
  'ai.ex.eagle': { en: 'Eagle · south', ar: 'نسر · الجنوبي' },
  'club.hilal': { en: 'Al Hilal', ar: 'الهلال' },
  'club.nassr': { en: 'Al Nassr', ar: 'النصر' },
  'club.ittihad': { en: 'Al Ittihad', ar: 'الاتحاد' },
  'club.ahli': { en: 'Al Ahli', ar: 'الأهلي' },
  'club.shabab': { en: 'Al Shabab', ar: 'الشباب' },
  'common.skip': { en: 'Skip to main content', ar: 'تخطَّ إلى المحتوى' },
  'ed.fit': { en: 'Fit', ar: 'ملء' },
  'ed.hint.brush': { en: 'brush', ar: 'فرشاة' },
  'ed.hint.fill': { en: 'fill', ar: 'تعبئة' },
  'ed.hint.text': { en: 'text', ar: 'نص' },
  'ed.hint.image': { en: 'image', ar: 'صورة' },
  'ed.hint.zen': { en: 'zen', ar: 'تركيز' },

  'common.language': { en: 'العربية', ar: 'English' }, // toggle shows the OTHER language
};

const LS_KEY = 'tifo_lang_v1';
let current: Lang = 'en';
const listeners: ((lang: Lang) => void)[] = [];

export function initLang(): Lang {
  try {
    const saved = localStorage.getItem(LS_KEY) as Lang | null;
    if (saved === 'en' || saved === 'ar') current = saved;
  } catch {
    /* ignore */
  }
  applyDir();
  return current;
}

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(LS_KEY, lang);
  } catch {
    /* ignore */
  }
  applyDir();
  applyDom(document);
  for (const fn of listeners) fn(lang);
}

export function toggleLang(): void {
  setLang(current === 'en' ? 'ar' : 'en');
}

export function onLangChange(fn: (lang: Lang) => void): void {
  listeners.push(fn);
}

/** Translate a key. Falls back to the key itself if missing. */
export function t(key: string): string {
  const entry = STRINGS[key];
  if (!entry) return key;
  return entry[current];
}

/**
 * Translate with {placeholders} filled in.
 *
 * Arabic puts numbers and names in different places than English does, so the
 * sentence has to be translated whole and the values dropped into it — never
 * assembled from fragments in code, which is how "designed with" ends up
 * stranded in English inside an Arabic panel.
 */
export function tv(key: string, vars: Record<string, string | number>): string {
  return t(key).replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
}

/**
 * Translate a value that doubles as an identifier and a display label — palette
 * names, pattern ids, stadium ids, camera presets. These live in data tables
 * keyed by their English name, so they cannot simply be replaced; this maps the
 * value to a key and falls back to the value itself when there is no entry.
 */
const LABEL_KEYS: Record<string, string> = {
  // palettes (core/template.ts keys)
  'Royal blue / white': 'pal.royal',
  'Black / gold': 'pal.blackGold',
  'Green / white': 'pal.greenWhite',
  'Red / white / black': 'pal.redWhiteBlack',
  // patterns (core/patterns.ts ids)
  solid: 'pat.solid',
  hoops: 'pat.hoops',
  columns: 'pat.columns',
  checker: 'pat.checker',
  sash: 'pat.sash',
  opposite: 'pat.opposite',
  tiers: 'pat.tier',
  gradient: 'pat.gradient',
  border: 'pat.borders',
  split: 'pat.split',
  // stadium templates (core/stadiumCatalog.ts ids)
  'generic-bowl-60k': 'stad.generic60k',
  'single-kop-40k': 'stad.kop40k',
  'grand-oval-76k': 'stad.oval76k',
  'Generic 60k bowl': 'stad.generic60k',
  'Single-tier kop 40k': 'stad.kop40k',
  'Grand oval 76k': 'stad.oval76k',
  // camera presets (render/preview3d.ts names)
  'TV gantry': 'cam.tv',
  'Behind goal': 'cam.goal',
  'Pitch level': 'cam.pitch',
  Aerial: 'cam.aerial',
  'Full view': 'cam.full',
  // active areas (core/activeArea.ts labels)
  'Entire stadium': 'area.all',
  'North stand': 'area.north',
  'South stand': 'area.south',
  'East stand': 'area.east',
  'West stand': 'area.west',
  'Upper tier': 'area.upper',
  'Lower tier': 'area.lower',
  // stadium filter values (core/stadiumCatalog.ts meta.type)
  Bowl: 'stype.bowl',
  'Single-tier': 'stype.single',
  'Two-tier': 'stype.two',
  Oval: 'stype.oval',
  Arena: 'stype.arena',
  Europe: 'country.europe',
  International: 'country.intl',
  'Middle East': 'country.me',
  'South America': 'country.sa',
  // reveal presets (core/reveal.ts ids)
  'sweep-lr': 'rev.lr',
  'sweep-rl': 'rev.rl',
  'sweep-up': 'rev.up',
  'wipe-center': 'rev.center',
  sections: 'rev.sections',
  rows: 'rev.rows',
  random: 'rev.random',
  instant: 'rev.instant',
  // stands, by the English name the seat map groups on
  North: 'dir.north',
  East: 'dir.east',
  South: 'dir.south',
  West: 'dir.west',
};

export function tl(value: string): string {
  const key = LABEL_KEYS[value];
  return key ? t(key) : value;
}

/**
 * Translate a server error message.
 *
 * The API answers in English because it has no idea which language the person
 * picked — the choice lives in their browser. Rather than plumbing a locale
 * through every endpoint, the client maps the known messages (which are stable
 * strings, not prose) to keys here, and falls back to the server's own text for
 * anything unrecognised, which is exactly what shipped before.
 */
const ERROR_KEYS: Record<string, string> = {
  'invalid credentials': 'err.badCreds',
  'incorrect password': 'err.badPassword',
  'current password is incorrect': 'err.badCurrentPassword',
  'email already in use': 'err.emailTaken',
  'too many emails to that address, try again later': 'err.addressMailCap',
  'too many verification emails today': 'err.verifyDailyCap',
  'photo must be a JPEG, PNG or WebP image': 'err.photoType',
  'premium AI is resting for today, try again tomorrow': 'err.aiResting',
  'authentication required': 'err.authRequired',
  'admin access required': 'err.adminRequired',
  'moderator access required': 'err.modRequired',
  'design not found': 'err.designNotFound',
  'not found': 'err.notFound',
  'not found or not allowed': 'err.notAllowed',
  'not found or not yours': 'err.notYours',
  'not your design': 'err.notYours',
  'not public': 'err.notPublic',
  'could not save that, please try again': 'err.saveFailed',
  // Kept for a tab that loaded the old bundle before the policy changed.
  'new password must be at least 8 characters': 'err.pwTooShort',
  // Every way server-side password grading can answer. The two length strings
  // are built from the same constants the server formats them with, so they
  // match by construction rather than by someone remembering to edit both.
  'choose a username first': 'err.needsUsername',
  'set a password before removing your last sign-in method': 'err.lastMethod',
  'a password is required': 'pw.err.blank',
  [`password must be at least ${PASSWORD_MIN} characters`]: 'pw.err.short',
  [`password must be at most ${PASSWORD_MAX} characters`]: 'pw.err.long',
  'a password of only numbers is too easy to guess': 'pw.err.digits',
  'that password repeats one short pattern': 'pw.err.repeated',
  'that password is a straight run of letters or keys': 'pw.err.sequence',
  'a password must not contain your email or username': 'pw.err.context',
  'that password is too easy to guess': 'pw.err.common',
  'invalid or expired reset link': 'err.badReset',
  'a valid email is required': 'err.needEmail',
  'no email on file': 'err.noEmail',
  'a prompt is required': 'err.needPrompt',
  'could not produce a valid design': 'err.aiFailed',
  'no AI provider configured': 'err.aiOff',
  'invalid stadium template': 'err.badStadium',
  'photo not found': 'err.photoNotFound',
  'image must be 1..2MB': 'err.imageSize',
  'comment body required': 'err.needComment',
  'could not add comment': 'err.commentFailed',
  'Sign in to use the AI Designer.': 'err.aiSignIn',
  'Verify your email to use the AI Designer.': 'err.aiVerify',
};

/**
 * A gallery tag as a label. Library tags have a translation; a tag a person
 * typed is their own word and comes back untouched.
 */
export function tTag(slug: string): string {
  const key = `tag.${slug}`;
  const hit = t(key);
  return hit === key ? slug : hit;
}

/**
 * The title to show for a design. Only the starter library carries a second
 * title — everything else is whatever its author typed, in whatever language
 * they typed it, and translating that would be putting words in their mouth.
 */
export function tTitle(item: { title: string; titleAr?: string | null }): string {
  return getLang() === 'ar' && item.titleAr ? item.titleAr : item.title;
}

export function tErr(message: string): string {
  const key = ERROR_KEYS[message.trim()];
  if (!key) return message;
  // The password-length messages are the only server errors carrying a number,
  // and it is a constant both sides import; `tv` is a no-op on the rest.
  return tv(key, { min: PASSWORD_MIN, max: PASSWORD_MAX });
}

function applyDir(): void {
  const html = document.documentElement;
  html.lang = current;
  html.dir = current === 'ar' ? 'rtl' : 'ltr';
}

/**
 * Apply translations to every [data-i18n] element in a root. Supports:
 *   data-i18n="key"            → sets textContent
 *   data-i18n-attr="placeholder:key,title:key"  → sets attributes
 */
export function applyDom(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-attr]').forEach((el) => {
    const spec = el.getAttribute('data-i18n-attr');
    if (!spec) return;
    for (const pair of spec.split(',')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  });
}
