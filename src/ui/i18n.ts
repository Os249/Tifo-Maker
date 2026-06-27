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

export type Lang = 'en' | 'ar';

const STRINGS: Record<string, { en: string; ar: string }> = {
  // ---- nav / chrome ----
  'nav.how': { en: 'How it works', ar: 'كيف يشتغل' },
  'nav.features': { en: 'Features', ar: 'المميزات' },
  'nav.clubs': { en: 'For clubs', ar: 'للأندية' },
  'nav.openEditor': { en: 'Open the editor', ar: 'افتح المحرر' },
  'nav.community': { en: 'Community', ar: 'المجتمع' },
  'community.title': { en: 'The tifo community', ar: 'مجتمع التيفو' },
  'community.sub': {
    en: 'Discover displays from supporters worldwide. Like, comment, follow creators, and remix any tifo into your own.',
    ar: 'شوف استعراضات من مشجعين من كل العالم. سوِّ لايك، علّق، تابِع المصممين، وريمكس أي تيفو وخلّه لك.',
  },
  'community.recent': { en: 'Recent', ar: 'الأحدث' },
  'community.popular': { en: 'Most liked', ar: 'الأكثر إعجابًا' },
  'community.templates': { en: 'Templates', ar: 'قوالب' },
  // ---- For Clubs (B2B) ----
  'clubs.navCta': { en: 'Talk to us', ar: 'كلّمنا' },
  'clubs.eyebrow2': { en: 'For clubs · agencies · ultras syndicates', ar: 'للأندية · الوكالات · روابط الألتراس' },
  'clubs.h1': { en: 'Run the whole stand like a production.', ar: 'سيّر المدرج كله كأنه إنتاج محترف.' },
  'clubs.lead': {
    en: 'TifoMaker for Clubs gives official organizers the tools to design, simulate, and execute professional-grade tifo displays at scale — with your team, your branding, and your exact stadium.',
    ar: 'تيفو ميكر للأندية يعطي المنظّمين الرسميين أدوات لتصميم ومحاكاة وتنفيذ استعراضات تيفو بمستوى احترافي وبحجم كبير — مع فريقك، وهويتك، وملعبك بالضبط.',
  },
  'clubs.cta1': { en: 'Book a walkthrough', ar: 'احجز جولة تعريفية' },
  'clubs.cta2': { en: 'Try the editor free', ar: 'جرّب المحرر ببلاش' },
  'clubs.trust': { en: 'Built for 40k–100k seat venues · seat-accurate execution · RTL & multi-language', ar: 'مصمّم لملاعب من ٤٠ إلى ١٠٠ ألف مقعد · تنفيذ دقيق لكل مقعد · يدعم RTL وعدة لغات' },
  'clubs.f1.title': { en: 'Team collaboration', ar: 'تعاون الفريق' },
  'clubs.f1.body': { en: 'Bring designers, capos, and club staff into one shared workspace. Co-author displays, manage revisions, and align the whole section before a single card is printed.', ar: 'اجمع المصممين والكابوهات وموظفي النادي في مساحة عمل واحدة. صمّموا سوا، أداروا النسخ، ووحّدوا المدرج كامل قبل ما يُطبع ولا كرت.' },
  'clubs.f2.title': { en: 'White-labeling', ar: 'علامتك الخاصة' },
  'clubs.f2.body': { en: 'Put your club’s identity front and center. Branded editor, branded fan pages, and branded match-day instructions — your crest, your colors, your domain.', ar: 'خلّ هوية ناديك في الواجهة. محرر بعلامتك، صفحات مشجعين بعلامتك، وتعليمات يوم المباراة بعلامتك — شعارك، ألوانك، نطاقك.' },
  'clubs.f3.title': { en: 'Custom 3D stadium modeling', ar: 'نمذجة ملعبك ثلاثي الأبعاد' },
  'clubs.f3.body': { en: 'We model your actual venue — exact tiers, sections, and seat counts — so what you design in 3D is precisely what 60,000 fans will hold up on the day.', ar: 'نمذجة ملعبك الحقيقي — المدرجات والقطاعات وأعداد المقاعد بالضبط — عشان اللي تصممه ثلاثي الأبعاد هو بالضبط اللي بيرفعه ٦٠ ألف مشجع يوم المباراة.' },
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
  'seat.noCardSub': { en: 'Your seat isn’t part of this display — just enjoy the show!', ar: 'مقعدك مو جزء من الاستعراض — استمتع بالعرض!' },
  'seat.changeSeat': { en: '‹ Change seat', ar: 'تغيير المقعد ›' },
  'seat.errNoCodeTitle': { en: 'No display code found', ar: 'ما فيه رمز للاستعراض' },
  'seat.errNoCodeBody': { en: 'This link looks incomplete. Ask your organiser for the correct QR or link.', ar: 'الرابط ناقص. اطلب من المنظّم رمز QR أو الرابط الصحيح.' },
  'seat.errLoadTitle': { en: 'Couldn’t load the display', ar: 'تعذّر تحميل الاستعراض' },
  'seat.errLoadBody': { en: 'It may be private or removed. Ask your organiser to publish it, then scan again.', ar: 'يمكن يكون خاص أو محذوف. اطلب من المنظّم ينشره، وبعدها امسح الرمز مرة ثانية.' },
  'seat.goHome': { en: 'Go to TifoMaker', ar: 'روح لتيفو ميكر' },
  'seat.rowLabel': { en: 'Row', ar: 'صف' },
  'hero.previewHint': { en: 'Drag to rotate · this is a live, interactive 3D preview', ar: 'اسحب عشان تدوّر · هذا عرض ثلاثي الأبعاد حي وتفاعلي' },
  'clubs.bodyLong': {
    en: 'Production-ready exports, volunteer logistics, and reusable templates for every match. Turn a design into a flawless 60,000-person execution — material counts, bag estimates, color specs, and per-section instruction sheets, all generated automatically.',
    ar: 'تصديرات جاهزة للإنتاج، وتنظيم للمتطوعين، وقوالب قابلة لإعادة الاستخدام لكل مباراة. حوّل التصميم إلى تنفيذ متقن لـ٦٠٬٠٠٠ شخص — أعداد المواد، تقديرات الأكياس، مواصفات الألوان، وأوراق تعليمات لكل قطاع، تتولّد كلها تلقائيًا.',
  },
  'supporters.lead': {
    en: 'Bring your group’s vision to life. Free to design, easy to share, built for the terrace. Publish to the community, remix others’ tifos, and rally your section around one image.',
    ar: 'حقّق رؤية مجموعتك. التصميم ببلاش، والمشاركة سهلة، ومبني للمدرجات. انشر للمجتمع، اعمل ريمكس لتيفوهات غيرك، ولمّ مدرجك حول صورة وحدة.',
  },
  'how.step1.title': { en: 'Build or select your stadium', ar: 'ابنِ ملعبك أو اختره' },
  'how.step1.body': {
    en: 'Pick your stadium — or match your real one. 40k, 60k, 76k, and custom geometries.',
    ar: 'اختر ملعبك — أو طابقه مع ملعبك الحقيقي. ٤٠ ألف، ٦٠ ألف، ٧٦ ألف، وأشكال مخصّصة.',
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
    en: 'Design free in your browser — no download, no account needed to start.',
    ar: 'صمّم ببلاش من متصفحك — بدون تحميل، وبدون حساب عشان تبدأ.',
  },

  // ---- editor: header / views ----
  'ed.view.design': { en: 'Design', ar: 'تصميم' },
  'ed.view.stadium': { en: 'Stadium', ar: 'الملعب' },
  'ed.view.split': { en: 'Split', ar: 'مقسوم' },
  'ed.signup': { en: 'Sign up', ar: 'سجّل' },
  'ed.gallery': { en: 'Gallery', ar: 'المعرض' },
  'ed.viewProfile': { en: 'View profile', ar: 'الملف الشخصي' },
  'ed.signOut': { en: 'Sign out', ar: 'تسجيل الخروج' },
  'ed.replayTour': { en: 'Replay tutorial', ar: 'إعادة الجولة التعريفية' },
  'ed.moderate': { en: 'Moderate', ar: 'الإشراف' },
  'ed.docTitlePlaceholder': { en: 'Untitled tifo', ar: 'تيفو بدون اسم' },
  'ed.mobileNote': { en: 'You are creating on mobile — the full editor (more tools) is best on desktop or tablet.', ar: 'أنت تصمم على الجوال — المحرر الكامل بأدوات أكثر أفضل على الكمبيوتر أو التابلت.' },

  // ---- editor: tool bars / panels ----
  'ed.props': { en: 'Properties', ar: 'الخصائص' },
  'ed.props.hint': {
    en: 'Paint on the canvas at left. These panels set how you paint and the look. Switch Design / Stadium / Split above to see it on the seats or in 3D.',
    ar: 'ارسم على اللوحة على اليسار. هذي اللوحات تتحكم بطريقة الرسم والشكل. بدّل بين تصميم / الملعب / مقسوم فوق عشان تشوفه على المقاعد أو ثلاثي الأبعاد.',
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
    en: 'Click a swatch to paint with it · double-click to edit · drag a new color from “+ Color”.',
    ar: 'اضغط لون عشان ترسم فيه · ضغطتين عشان تعدّله · أضف لون جديد من «+ لون».',
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
  'ed.save': { en: 'Save', ar: 'احفظ' },
  'ed.openFile': { en: 'Open file', ar: 'افتح ملف' },
  'ed.publicList': { en: 'List in public gallery', ar: 'انشره في المعرض العام' },
  'ed.addPhoto': { en: 'Add match-day photo', ar: 'أضف صورة يوم المباراة' },
  'ed.addPhoto.hint': { en: 'Show the real stand beside your design — proof it came to life.', ar: 'اعرض المدرج الحقيقي جنب تصميمك — إثبات إنه صار حقيقة.' },
  'ed.share': { en: 'Share', ar: 'شارك' },
  'ed.save.tag': { en: '& share', ar: 'والمشاركة' },

  // ---- editor: stadium config / area / orientation ----
  'ed.cfg.tag': { en: 'choose & configure the bowl', ar: 'اختر وجهّز المدرج' },
  'ed.cfg.hint': { en: 'Pick the stadium your tifo is designed for. Switching remaps your current design onto the new bowl.', ar: 'اختر الملعب اللي تصمّم له تيفوك. لما تبدّل، ينتقل تصميمك الحالي على المدرج الجديد.' },
  'ed.area': { en: 'Active tifo area', ar: 'منطقة التيفو' },
  'ed.area.hint': { en: 'Which part of the bowl the design targets — the AI focuses here.', ar: 'أي جزء من المدرج يستهدفه التصميم — الذكاء يركّز هنا.' },
  'ed.orient': { en: 'Orientation', ar: 'الاتجاه' },
  'ed.orient.hint': { en: 'Re-orient your design around the bowl (undoable).', ar: 'لِف تصميمك حول المدرج (يمكن التراجع).' },
  'ed.review': { en: 'Admin · review queue', ar: 'الإدارة · قائمة المراجعة' },
  'ed.review.hint': { en: 'Pending community submissions. Approve to publish, reject to discard.', ar: 'مشاركات المجتمع المعلّقة. وافق للنشر، أو ارفض للحذف.' },

  // ---- editor: AI panel ----
  'ed.ai.title': { en: 'AI Designer', ar: 'مصمّم الذكاء' },
  'ed.ai.tag': { en: 'describe it, get a tifo', ar: 'صِفه، وخذ تيفو' },
  'ed.ai.hint': { en: 'Describe a display in plain words — a stand, colours, text, a symbol. The AI composes a fully editable tifo on the seats.', ar: 'صِف الاستعراض بكلامك — مدرج، ألوان، نص، شعار. الذكاء يركّب لك تيفو كامل وقابل للتعديل على المقاعد.' },
  'ed.ai.placeholder': { en: 'e.g. Giant eagle covering the south stand in black and gold', ar: 'مثال: نسر ضخم يغطّي المدرج الجنوبي بالأسود والذهبي' },
  'ed.ai.generate': { en: 'Generate tifo', ar: 'صمّم تيفو' },
  'ed.ai.super': { en: 'Super AI — design full stadium', ar: 'الذكاء الخارق — صمّم الملعب كامل' },
  'ed.ai.superHint': { en: 'Plans every stand together — portraits, text and colour blocking across the whole bowl.', ar: 'يخطّط لكل المدرجات سوا — وجوه ونصوص وتقسيم ألوان على المدرج كامل.' },
  'ed.ai.shuffle': { en: 'Shuffle — free offline variation', ar: 'تشكيل — نسخة ببلاش بدون نت' },
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
