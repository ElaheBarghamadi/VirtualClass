# گزارش ممیزی فنی VirtualClass برای NextClass

**تاریخ:** 2026-10-31، UTC  
**مبنای بررسی:** checkout شاخهٔ `arena/5b335e0c-virtualclass` در commit `00baf4aa0cbc4b5825454e4a04e6b5bae4b89013`؛ وضعیت شاخه هنگام بررسی فعال بود.  
**دامنه:** ممیزی ایستا و بررسی تاریخچه و تنظیمات، بدون تغییر کد، نصب dependency، اجرای migration، یا استفاده از سرویس واقعی. این گزارش تنها تغییر مجاز مخزن است.

## روش، شواهد و محدودیت‌ها

- «تأییدشده» در یافته‌ها یعنی مسیر کد یا پیکربندیِ توصیف‌شده با خواندن منبع مشاهده شده، نه اینکه exploit یا جریان کار در محیط عملیاتی اجرا شده است. «مشکوک» یعنی خطر از کد استنباط می‌شود و برای اثبات به آزمایش/شرایط مشخص نیاز دارد. توصیه‌ها طرح پیشنهادی‌اند، نه ویژگی موجود.
- Python 3.11.2 موجود است، اما `import django` با `ModuleNotFoundError` متوقف شد. هیچ dependency نصب نشد. بنابراین Django test runner، database، migrations، Redis، LiveKit، مرورگر، LibreOffice، ASGI deployment و بار واقعی **NOT VERIFIED** هستند. CI در مخزن دلیل موفقیت CI در آخرین commit نیست.
- بررسی بدون نوشتن فایل: `ast.parse` برای **108 فایل Python**، خطا **0**؛ `node --check` برای **13 فایل** `static/js/*.js` با Node 22.22.3، خطا **0**. اینها فقط بررسی syntax هستند؛ تست عملکرد یا امنیت نیستند.
- از طریق GitHub API، branch پیش‌فرض `main` و آخرین commit آن مبنای این گزارش است. clone محلی shallow است، پس `git log` محلی فقط یک commit را نشان می‌دهد؛ تاریخچهٔ اخیر و مقایسهٔ branch از API خوانده شد. وضعیت محیط واقعی، تمام تنظیمات runtime، امنیت زیرساخت و secretهای خارج از فایل‌های قابل مشاهده ارزیابی نشده‌اند.
- تعداد آزمون‌ها شمارش ایستای متدهای `test_` است، نه تعداد تست کشف‌شده/اجراشده یا coverage. هیچ درصد پوشش اندازه‌گیری نشده است.

## A. خلاصهٔ مدیریتی

VirtualClass یک Django modular monolith با Django Templates و JavaScript مستقل است، نه React. ساخت کلاس، عضویت، guest، waiting room، chat، whiteboard، presentation، moderation، session/attendance، quiz و assignment در کد وجود دارند. رسانه در صورت تنظیم LiveKit از SFU و در غیر این صورت از WebRTC mesh استفاده می‌کند. واقعاً کارکردن این جریان‌ها در مرورگر/چند کاربر یا یک استقرار واقعی در این ممیزی تأیید نشده است.

**ادامه دادن ارزش دارد**: `accounts.User`، مدل‌های اولیهٔ کلاس و session، serviceهای مجوز، پروتکل‌های chat/whiteboard و validation آپلود و مجموعه تست، نقطهٔ شروع مفیدی هستند. **بازنویسی کامل موجه نیست**؛ اما نباید وضعیت فعلی را آمادهٔ تولید چندسازمانی تلقی کرد. جدی‌ترین ضعف‌ها: مسیرهای ناهمسان authorization، امکان دور زدن انتظار و افشای فایل با نحوهٔ سرو media، نبود revocation سمت SFU و نبود کنترل سروری در mesh، نبود tenant isolation و capacity، و چند race در lifecycle/realtime است. حفظ ظاهر/قابلیت بدون تکرار منطق، مستلزم تثبیت contract و تست‌های امنیتی پیش از مهاجرت React است.

## B. نقشهٔ واقعی مخزن و تاریخچه

```text
config/       settings.py, urls.py, asgi.py, wsgi.py
accounts/     User, auth/forms/views, profile, templates, migrations, tests
classrooms/   models, permissions, services, views, api, serializers,
              consumers, ws_security, file_validation, office_convert,
              templates, migrations, management/commands/seed_demo.py, tests
chat/         ChatMessage, consumer/routing, migrations, tests
whiteboard/   Whiteboard/Event, consumer/routing, migrations, tests
quizzes/      Quiz/Question/Option/Run/Answer, services, HTML/room views, tests
assignments/  Assignment/Submission, HTML views, templates, tests
core/         public views, api_urls, ratelimit, deploy checks, tests
static/       css/, js/ (room, mesh, media, chat, whiteboard, ...), vendor/
templates/    base, home, error pages
tests_e2e/    run_e2e.py, run_mesh_fail.py
.github/workflows/ci.yml    Dockerfile    docker-compose.yml
deploy/       PythonAnywhere WSGI guide, coturn configuration
requirements.txt, requirements-dev.txt, .env.example, manage.py
```

### فناوری و مسئولیت‌ها

- `requirements.txt` بازهٔ `Django>=5.0,<5.1` و DRF 3.15+، Channels 4، Redis، Daphne، `livekit-api` و Pillow را اعلام می‌کند؛ lockfile Python وجود ندارد و نسخهٔ نصب‌شده ناشناخته است. `config/settings.py` به‌طور پیش‌فرض SQLite و با `DATABASE_URL` گزینه‌های PostgreSQL/MySQL را می‌سازد؛ psycopg در requirements معمولی comment شده، ولی Dockerfile جداگانه نصبش می‌کند. driver MySQL در requirements نیست. DSN ناشناخته silently به SQLite برمی‌گردد.
- `config/urls.py` صفحات HTML و `/api/` را وصل می‌کند؛ `core/api_urls.py` شامل auth، کلاس، participant، session، message، file و attendance است. `classrooms/api.py` و serializers یک API جزئی هستند، نه API کامل product؛ بخشی از عملیات فقط HTML/JSON views و بخشی فقط socket است. Middleware استاندارد Django شامل Session، CSRF، Authentication و Security است؛ middleware سفارشی دیده نشد.
- `config/asgi.py`، Session/Auth middleware و سه مسیر `/ws/classroom/<room_code>/`، `/chat/` و `/whiteboard/` را به Channels وصل می‌کند. `REDIS_URL`، channel layer و cache مشترک Redis را فعال می‌کند؛ در نبود آن هر دو local/in-memory و محدود به process هستند. task queue یا worker واقعی پیدا نشد؛ Office conversion در request همگام انجام می‌شود (`classrooms/office_convert.py`).
- فایل‌ها در `MEDIA_ROOT` با FileField ذخیره می‌شوند. `SharedFile` و نسخهٔ PDF با signal `post_delete` پاک می‌شوند (`classrooms/models.py:347-365`)؛ `Submission` چنین lifecycle مشابهی ندارد. file access به نحوهٔ سرو media وابسته است؛ بخش امنیت را ببینید.
- Docker شامل Daphne/Postgres/Redis است، LiveKit جداگانه است. `Dockerfile` در startup خودکار migrate می‌کند، `collectstatic` در build خطا را با `|| true` پنهان می‌کند و تنظیم production به استقرار وابسته است. CI روی Python 3.11، نصب dependencies/Chromium/LibreOffice، Django tests و یک E2E انجام می‌دهد؛ PostgreSQL/Redis/LiveKit، mesh-fail script و load testing در آن workflow اجرا نمی‌شوند. راهنمای PythonAnywhere صریحاً محدودیت WSGI و نبود WebSocket را بیان می‌کند.

### تاریخچه و کار در جریان

GitHub API commitهای اخیر را نشان می‌دهد: `00baf4a` رفع whiteboard/media، `c8f8e41` سخت‌سازی security و همکاری whiteboard، `9101fb4` پنل permissions، `4444437` backend/security/tests، `f212921` اصلاح media، `01ddcde` افزودن CI، `fc07b49` quiz/assignment/recording و `061958e` password reset و Office conversion. عنوان commit اثبات موفقیت تغییر نیست. branch موجود `arena/7fe77451-virtualclass` در زمان بررسی **۷ commit جلوتر از main، صفر عقب‌تر** است؛ شامل بازنویسی whiteboard، snapshot/migration `whiteboard/0004`، JavaScript tests و بهبود mesh/media است. این تغییرات در checkout ممیزی حاضر نیستند و نباید بدون بازبینی سازگاری، امنیت و migration ادغام شوند. این branch نشانهٔ کار مستقل/در جریان است، نه لزوماً abandoned؛ مدرکی برای اعلام abandoned بودن ویژگی خاص وجود ندارد. E2E دوم `tests_e2e/run_mesh_fail.py` در workflow حاضر فراخوانی نمی‌شود.

## C. ماتریس راستی‌آزمایی ویژگی

وضعیت‌های این جدول فقط از فهرست مجاز استفاده شده‌اند. «متصل» به معنای وجود اتصال در کد است نه موفقیت runtime. «تست: دارد» به معنای وجود تست مرتبط در مخزن است؛ **تمام تست‌های این جدول اجرا نشده‌اند**. امنیت مختصر در ستون آخر آمده است.

| Feature | Implementation Status | Backend Connected | Tests | Main Issues |
|---|---|---|---|---|
| ثبت‌نام، login، reset، profile | Implemented but partially verified | بله؛ Django auth و DRF token | دارد؛ `accounts/tests.py`, `classrooms/tests.py` | throttle و password validators؛ token lifecycle ضعیف، اجرای واقعی نامعلوم |
| ساخت/مدیریت کلاس | Implemented but partially verified | بله؛ `create_classroom`, views/API | دارد | مالک واحد؛ tenant و quota ندارد |
| password کلاس و لینک ورود | Implemented but partially verified | بله؛ hash، lobby | دارد | حداقل ۴ کاراکتر؛ لینک room، invitation قابل revoke/expire نیست |
| guest | Implemented but partially verified | بله؛ session-bound member | دارد | IP ban ناکافی؛ هویت نمایشی اثبات هویت نیست |
| session زمان‌بندی/start/end | Implemented but partially verified | بله؛ `ClassroomSession` | دارد | پایان session الزاماً دسترسی/media را قطع نمی‌کند؛ race |
| join/leave و attendance | Implemented but partially verified | بله؛ services و presence socket | دارد | `is_active` حضور واقعی نیست؛ چند socket و disconnect باعث محاسبهٔ غلط می‌شود |
| participant list/presence | Implemented but partially verified | بله؛ Channels snapshot | دارد | waiting event و اطلاعات حساب؛ stale presence و fan-out |
| waiting room | Partially implemented | بله؛ approval و restricted socket | دارد | در برخی entry pointها enforce نشده و event به همه broadcast می‌شود؛ بخش امنیت |
| audio/video | Implemented but partially verified | بله؛ LiveKit token یا mesh signaling | دارد؛ تست token/signaling | LiveKit و مرورگر واقعی NOT VERIFIED؛ مجوز پویا در SFU/mesh کافی نیست |
| اجازهٔ camera/microphone و device | Implemented but partially verified | بخشی؛ policy/token + browser media | دارد؛ نه تست جامع دستگاه واقعی | اجازهٔ مرورگر و انواع device/OS به اجرا نیاز دارند |
| انتخاب device/speaker | Implemented but partially verified | عمدتاً browser، `lobby.js`, `room.js` | E2E در مخزن؛ پوشش دستگاه واقعی نامعلوم | `setSinkId` وابسته به browser؛ چند دوربین/میکروفون هم‌زمان تضمین نشده |
| screen sharing | Implemented but partially verified | بله؛ grant و client | تست grant موجود | revocation/mesh و browser واقعی NOT VERIFIED |
| active speaker | Implemented but partially verified | media client | تست جامع واقعی مشاهده نشد | `media.js` و `mesh.js` پیاده‌سازی دارند؛ کیفیت/کارایی نامعلوم |
| reconnect | Partially implemented | بله؛ snapshot و history | تست snapshot/history و E2E موجود | قطع واقعی، چند تب و همهٔ raceها NOT VERIFIED |
| chat و حذف پیام | Implemented but partially verified | بله؛ `ChatConsumer`, `ChatMessage` | دارد | check per-message؛ history محدود، ذخیره و fan-out بارزا |
| announcement مستقل | Missing | خیر | مشاهده نشد | chat/notification جایگزین مدل announcement مستقل نیست |
| whiteboard و sync | Implemented but partially verified | بله؛ `WhiteboardConsumer`, events | دارد | replay فقط ۲۰۰۰ event آخر؛ ترتیب/clear هم‌زمان نامطمئن |
| whiteboard permissions | Implemented but partially verified | بله؛ check در consumer | دارد | check نوشتن؛ raceهای تغییر policy/stream نیازمند تست |
| moderation و چند moderator | Implemented but partially verified | بله؛ role/permissions/services | دارد | فقط owner نقش می‌دهد؛ revocation رسانه و سناریوی هم‌زمان چند moderator نامطمئن |
| file/image sharing و presentation | Implemented but partially verified | بله؛ upload/download/PDF | دارد | direct media exposure، انتظار، sync و conversion اختیاری |
| quiz زنده | Implemented but partially verified | بله؛ models/services/views/socket | دارد | race شروع هم‌زمان، score عمومی؛ بدون tenant |
| assignment و grading | Implemented but partially verified | بله؛ models/HTML views | دارد | waiting bypass و لینک مستقیم فایل؛ فقط عضو ثبت‌نامی |
| recording | Partially implemented | خیر؛ `MediaRecorder` محلی در `static/js/room.js:1051` | تست خودکار مشخص مشاهده نشد | فقط microphone و camera یا screen خود میزبان در دستگاه او ضبط می‌شود، نه کل جلسه؛ ضبط سروری/consent/retention وجود ندارد |
| invitation مستقل | Missing | خیر | ندارد | room code لینک مشترک است؛ expiry، استفادهٔ محدود و revoke ندارد |
| organization و گروه دائمی | Missing | خیر | ندارد | breakout room هم مدل مشاهده نشد؛ گروه آموزشی با breakout یکی نیست |
| ظرفیت سلسله‌مراتبی | Missing | خیر | ندارد | هشدار mesh فقط client-side است؛ quota/reservation وجود ندارد |

## D. یافته‌های امنیتی، به ترتیب شدت

### Critical

**C-01 — افشای فایل‌های خصوصی از طریق static media؛ تأییدشده در پیکربندی پیشنهادی، بهره‌برداری محیطی NOT VERIFIED.** `config/urls.py` در DEBUG کل `MEDIA_ROOT` را سرو می‌کند؛ `deploy/PYTHONANYWHERE.md:104-111` نگاشت عمومی `/media/` به کل پوشه را پیشنهاد می‌دهد. `assignments/templates/assignments/assignment_detail.html:34-35,65` مستقیم `Submission.file.url` می‌دهد، و `assignments/models.py:12-13` مسیر قابل حدس بر اساس classroom id و filename می‌سازد. فایل SharedFile نیز زیر همان ریشه است. این مسیرها از `classrooms/views.py:720-737` و membership check عبور نمی‌کنند؛ هر کس URL را به‌دست آورد، در چنین استقراری می‌تواند فایل را بخواند؛ قابل حدس بودن برخی نام‌ها ریسک را بیشتر می‌کند. **اصلاح:** private storage جدا از public logo/static، download endpoint با tenant/session/owner مجاز یا signed URL کوتاه و محدود، جلوگیری از public mapping، و تست عدم دسترسی مستقیم؛ migration و پاک‌سازی URLهای موجود با دقت.

### High

**H-01 — انتظار در همهٔ مرزها enforce نمی‌شود؛ تأییدشده در کد.** `classrooms/views.py:658-665` برای upload، active member و `effective_permissions` را می‌سنجد اما `in_waiting_room` را نه؛ در صورت داشتن grant، عضو منتظر می‌تواند آپلود کند. `assignments/views_manage.py:20-25,73-85` نیز صرف active membership یا owner را می‌پذیرد و انتظار و وضعیت active کلاس را بررسی نمی‌کند؛ بنابراین عضو ثبت‌نامیِ منتظر می‌تواند assignment را ببیند/ارسال کند. `ClassroomDetailAPIView` در `classrooms/api.py:111-122` نیز waiting را حذف نمی‌کند و metadata کلاس را به عضو منتظر می‌دهد. **اثر:** دور زدن gate و دسترسی زودهنگام. **اصلاح:** policy مشترک admitted/active در هر entry point، تست منفی برای HTTP/API/WS و file؛ تعیین صریح داده‌های مجاز lobby.

**H-02 — اطلاعات انتظار به admittedها broadcast می‌شود؛ تأییدشده در کد.** `join_classroom_guest` و `join_classroom` در `classrooms/services.py:267-280,325-336` رویداد `waiting_room_entry` و payload را به گروه عمومی کلاس می‌فرستند؛ `classrooms/consumers.py:230-235` آن را بدون فیلتر به همهٔ اتصالات آن گروه relay می‌کند. مخفی کردن waiting rows در snapshot/API مانع این افشا نیست. **اثر:** افشای نام/identity/وضعیت فرد منتظر به دانش‌آموزان حاضر. **اصلاح:** گروه خصوصی owner/moderator، فیلتر همهٔ رویدادها و تست دریافت واقعی با چند نقش.

**H-03 — revocation و moderation در رسانه تضمین‌شده نیست؛ تأییدشده در طراحی کد، رفتار سرور واقعی NOT VERIFIED.** token تنها پس از عضویت پذیرفته‌شده و با grants محاسبه می‌شود (`classrooms/views.py:389-404`, `classrooms/media.py:42-80`)، اما TTL پیش‌فرض ۳۶۰ دقیقه است (`config/settings.py:197`). `remove_member`, `set_member_muted`, تغییر role/settings و `deactivate_classroom` فقط DB و Channels را تغییر/اعلان می‌دهند؛ فراخوانی LiveKit server برای remove/update participant یا محدود کردن track مشاهده نشد (`classrooms/services.py:501-585,621...`). token صادرشده و اتصال SFU به‌صرف بستن socket Django لزوماً بی‌اعتبار نمی‌شوند. در mesh، سرور signaling را relay می‌کند و media مستقیماً بین peerها می‌رود (`classrooms/consumers.py:178-197,343-365`)؛ client دستکاری‌شده الزاماً mute/stop را رعایت نمی‌کند. **اثر:** ادامهٔ انتشار/اشتراک رسانه پس از حذف یا کاهش مجوز. **اصلاح:** کنترل سمت LiveKit برای update/remove/room termination، TTL و reconnect policy محدود، token refresh مجاز؛ برای نیاز امنیتی strict از mesh به‌عنوان enforcement استفاده نشود. integration test واقعی با client مخرب لازم است.

**H-04 — وابستگی Django در شاخهٔ بدون پشتیبانی و بدون lock؛ تأییدشده برای دامنهٔ مجاز، applicability exploit مشکوک.** `requirements.txt:2` فقط سری 5.0 را اجازه می‌دهد؛ هیچ نسخهٔ نصب‌شده‌ای اینجا موجود نیست. استعلام GitHub Advisory برای مثال `Django 5.0.14` شامل [GHSA-frmv-pr5f-9mcr](https://github.com/advisories/GHSA-frmv-pr5f-9mcr) با severity upstream Critical (SQL injection از `_connector`) و [GHSA-qw25-v68c-qjf3](https://github.com/advisories/GHSA-qw25-v68c-qjf3) است. این به معنی وجود مسیر exploit در این برنامه نیست؛ در جست‌وجوی کد، ورودی کنترل‌شده به `_connector` تأیید نشد. advisoryهای مربوط به GeoDjango نیز به نصب/استفادهٔ آن وابسته‌اند. **اصلاح:** در فاز پیاده‌سازی انتخاب Django پشتیبانی‌شده، lock قابل بازتولید، advisory scan کل dependencyها و تست سازگاری migrations/DB؛ نه ارتقای کورکورانه در این ممیزی.

**H-05 — حذف عضو معادل لغو دائمی دسترسی نیست؛ تأییدشده در کد.** `remove_member` در `classrooms/services.py:621-641` با پیش‌فرض `ban_minutes=0` فقط membership را غیرفعال می‌کند. `join_classroom` در خطوط 297-347 برای عضویت غیرفعال دوباره gateهای قفل/رمز را می‌سنجد و آن را فعال می‌کند؛ برای کلاس باز، عضو حذف‌شده می‌تواند دوباره با همان لینک وارد شود. guest نیز می‌تواند هویت تازه بسازد مگر ban مبتنی بر IP اعمال شده باشد. حذف account یا تغییر مستقیم DB همچنین از مسیر اعلان هدفمند service عبور نمی‌کند؛ بسته‌شدن passive socketهای موجود تا رویداد/بازاعتبارسنجی بعدی تضمین نشده است. **اثر:** removal یا حذف account را نمی‌توان revoke پایدار و فوری فرض کرد. **اصلاح:** وضعیت revoked جدا از leave و ban موقت، سیاست صریح re-admission، رویداد transaction-safe و قطع socket/SFU، همراه تست account deletion و rejoin.

### Medium

**M-01 — session پایان‌یافته الزاماً access را پایان نمی‌دهد؛ تأییدشده.** `classrooms/services.py:852-862` فقط status و attendance را می‌بندد و event می‌فرستد؛ `room_view`، media-token و sockets داشتن `ClassroomSession.LIVE` را شرط نمی‌کنند. **اثر:** انتظار کسب‌وکار برای قطع جلسه ممکن است نقض شود. **اصلاح:** تفکیک سیاست persistent class از session، پایان اتمی و قطع مجوز/socket/SFU در صورت policy مربوط.

**M-02 — auth token طولانی‌عمر و session hijacking؛ تأییدشده در پیکربندی، سوءاستفاده NOT VERIFIED.** `config/settings.py:269-276` از DRF `TokenAuthentication` و `SessionAuthentication` استفاده می‌کند و `LoginAPIView` از `ObtainAuthToken`؛ expiry/rotation/logout token سفارشی دیده نشد. سرقت token تا ابطال/حذف آن خطر دارد. cookieهای production در DEBUG=false به‌طور پیش‌فرض Secure و SameSite=Lax هستند، CSRF middleware فعال است. **اصلاح:** ترجیح session هم‌مبدأ و CSRF برای SPA یا credential کوتاه‌عمر و revoke/rotation امن، تست logout و مدیریت session؛ TLS و عدم ذخیرهٔ token در localStorage.

**M-03 — افشای اطلاعات شخصی و هویت guest؛ تأییدشده.** `MemberSerializer`، `UserSerializer.email` را برای participant list به سایر اعضای مجاز می‌دهد (`classrooms/serializers.py:13-19,37-74`, `classrooms/api.py:125-147`). `ClassroomMember.identity` برای guest شامل guest_uid است (`classrooms/models.py:215-216`) که در roster و media نیز دیده می‌شود. UID به‌تنهایی session cookie نیست و این ممیزی impersonation با آن را ثابت نمی‌کند، اما identifier عمومی و مقدار مورد استفاده در session بهتر است جدا باشند. **اصلاح:** کمینه‌سازی response برحسب نقش، ID عمومی جداگانه، privacy/retention و تست.

**M-04 — rate limiting و guest ban قابل اتکا در همهٔ topologyها نیست؛ تأییدشده/بخشی مشکوک.** `core/ratelimit.py:19-26` در initialization هم‌زمان `incr` سپس `set` دارد و ممکن است increments از دست بروند؛ cache محلی در نبود Redis میان processها مشترک نیست. WS limiter به ازای connection است (`classrooms/ws_security.py:132-149`). guest ban با `REMOTE_ADDR` (`classrooms/services.py:251-255`) هم با تغییر IP قابل دور زدن است و هم پشت proxy/NAT ممکن است افراد مشترک را مسدود کند. **اصلاح:** atomic shared limiter، تنظیم trusted proxy صریح، چندبعدی و آزمون distributed؛ ابزار anti-abuse مکمل، نه اتکا به نام/IP.

**M-05 — فایل‌های پیچیده و تبدیل synchronous؛ خطر مشکوک، مسیر تأییدشده.** `classrooms/file_validation.py:16-70,83-117` اندازه، extension و magic/OOXML marker را کنترل می‌کند، ولی malware/zip bomb/resource complexity را تضمین نمی‌کند. `classrooms/views.py:697-700` LibreOffice را در request و `office_convert.py` با timeout اجرا می‌کند. **اثر:** مصرف منابع، فایل مخرب یا ریسک parser؛ اجراپذیری exploit ثابت نشده. **اصلاح:** sandbox جدا، محدودیت CPU/memory/archive expansion، اسکن، queue و quota و ثبت وضعیت؛ سرو attachment امن.

**M-06 — DEBUG و fallbackهای خطرناک وابسته به استقرار؛ تأییدشده در defaults.** `config/settings.py:41-42,157-172` پیش‌فرض DEBUG=true، host محلی و in-memory channel layer دارد؛ با DEBUG=false secret پیش‌فرض رد می‌شود و secure cookie/redirect فعال است. `core/checks.py:20-27` host `*` را از public warning کنار می‌گذارد. `docker-compose.yml` دارای credentials نمونهٔ ثابت DB است که نباید production تلقی شود. **اثر:** پیکربندی غلط می‌تواند اطلاعات/نشست را در معرض خطر قرار دهد یا realtime را در چند process ناقص کند. **اصلاح:** fail-closed برای production، secrets manager، deploy checks و HTTPS/proxy/Redis صریح؛ هیچ مقدار secret واقعی در گزارش بازتولید نشده است.

**M-07 — عدم انطباق authorize با lifecycle و error؛ تأییدشده.** `_ClassroomScopedMixin.get_classroom()` در `classrooms/api.py:65-83` `is_active` را فیلتر نمی‌کند؛ مسیرهای خاصی همچون `_classroom_for` در assignment بر owner/active member تکیه می‌کنند. حذف از طریق service عموماً membership را غیرفعال می‌کند، اما تغییر مستقیم DB/admin یا race ممکن است حالت ناسازگار ایجاد کند. `_target_member`، `ClassroomAccessError` می‌دهد ولی چند view/API فقط `PermissionDenied`/`ValueError` را catch می‌کنند (`classrooms/services.py:485-489`, `classrooms/views.py:444-473`, `classrooms/api.py:150-173`)، پس ID نامعتبر ممکن است 500 شود. **اصلاح:** policy مرکزی و invariant در همهٔ مسیرها، exception mapping یکپارچه و تست وضعیت ناسازگار.

### Low / Informational

- **L-01، تأییدشده:** رمز کلاس حداقل چهار نویسه دارد (`classrooms/forms.py:19-24`, `serializers.py:124-127`)؛ hash و throttle وجود دارند اما رمز کوتاه در برابر حملهٔ توزیع‌شده ضعیف است. سیاست قوی‌تر و invitation محدود توصیه می‌شود.
- **L-02، تأییدشده:** `ClassroomParticipantsAPIView` دادهٔ `email` را بازمی‌گرداند؛ علاوه بر M-03، حساب‌های shared و نام‌های انتخابی guest امکان وانمود اجتماعی دارند؛ guest یک هویت تأییدشده نیست. نشان guest و سیاست دعوت توصیه می‌شود.
- **I-01، تأییدشده:** ORM برای queryها عمدتاً استفاده می‌شود؛ در بازبینی مسیرهای اصلی SQL injection مشخص مشاهده نشد، نه اثبات عدم وجود آن. CSRF middleware و Origin check سفارشی socket وجود دارد (`classrooms/ws_security.py:57-94`)؛ Origin غایب برای client غیرمرورگری پذیرفته می‌شود ولی session لازم است. پشت reverse proxy تطبیق scheme/host باید تست شود. تنظیم CORS package دیده نشد؛ React cross-origin نباید بدون طراحی CORS/CSRF اضافه شود.
- **I-02، مشکوک:** Django template autoescape و بسیاری از `textContent`ها استفاده می‌شوند، ولی `innerHTML` در `static/js/room.js`, `modal.js`, `presentation.js` وجود دارد؛ کل جریان taint/XSS مرورگر ممیزی پویا نشده و نباید «هیچ XSS وجود ندارد» ادعا کرد. با CSP، safe DOM و تست payload بررسی شود.
- **I-03، تأییدشده:** تنظیمات نمونه و development fallback و credential نمونهٔ Compose وجود دارند؛ scan محدود و خواندن پیکربندی، عدم وجود تمام secretهای واقعی در تاریخچه یا خارج از checkout را ثابت نمی‌کند. logs با formatter متنی و `extra` هستند؛ خطاهای dependency/proxy و logهای زیرساخت از نظر دادهٔ حساس NOT VERIFIED. از ثبت URL/token/PII جلوگیری و logهای عملیاتی audit شوند.

## E. بدهی فنی و درستی داده

1. **مرز مجوز یکپارچه نیست:** `effective_permissions` پایهٔ خوب دارد اما owner-only، membership، waiting، active-class و guest در API، assignments، views و consumers تکرار/ناهمسان‌اند. `classrooms/views.py` حدود ۷۵۵ و `services.py` حدود ۹۰۹ خط دارد؛ assignment و quiz بخشی از business logic را در views دارند. `quizzes/views_room.py` helper خصوصی از `classrooms.views` import می‌کند؛ coupling لایهٔ HTTP است، نه مدرک circular import runtime.
2. **تراکنش و race:** `start_session` (`services.py:832-849`) با `atomic` تنها check-then-create می‌کند؛ row lock/unique live-session ندارد، پس دو درخواست می‌توانند دو LIVE بسازند. `quizzes/services.py:90-102` نیز update-then-create بدون lock مشترک دارد. `file_upload_view:678-688` count-then-create است و سقف ۱۰۰ را هم‌زمانی می‌تواند نقض کند. `unique_display_name` check-then-create است. توصیه: lock/constraint مطابق DB و تست PostgreSQL؛ atomic به‌تنهایی کافی نیست.
3. **رویداد و تراکنش:** چند `broadcast` درون `atomic` اجرا می‌شوند (`services.py:235-285,297-347,832-849`)؛ شنونده ممکن است قبل از commit بخواند یا بعد از rollback event دیده باشد. از `transaction.on_commit` یا outbox با تحویل idempotent استفاده شود. حذف فیزیکی فایل پیش از commit/در signal (`services.py:delete_shared_file`, `models.py:352`) با rollback ناسازگار است.
4. **مدل/constraint:** `ClassroomMember` user و guest و membership و حضور و moderation را در یک row ترکیب می‌کند؛ constraint برای XOR معتبر user/guest و هماهنگی FKهای `AttendanceRecord`, `Submission`, `QuizAnswer` با کلاس/run در DB وجود ندارد. `UniqueConstraint(condition=user__isnull=False)` در `classrooms/models.py:178-185` در MySQL از partial unique index پشتیبانی یکسانی ندارد؛ مستندات/اجرای migration واقعی NOT VERIFIED و الزاماً باید با DB هدف آزمایش شود. unique پاسخ quiz و submission و indexهای owner/active/status/chat/board وجود دارند؛ نبود index باید با query plan واقعی تأیید شود.
5. **حضور:** هر اتصال presence یک attendance باز می‌کند و disconnect همهٔ intervalهای باز عضو را می‌بندد (`consumers.py:91-127`, `services.py:865-879`). دو تب، قطع ناگهانی یا اتصال قبل از شروع session ممکن است آمار را غلط کنند؛ lease/connection identity، reconciliation و تست لازم است.
6. **Query efficiency:** `ClassroomSerializer.get_participant_count` برای هر کلاس count جدا دارد (`serializers.py:109-110`)؛ API list می‌تواند N+1 شود. `AttendanceListAPIView` برای هر session `attendance_summary` جدا اجرا می‌کند (`api.py:248-255`)، `quizzes/views_manage.py:58-61` برای هر run نتایج محاسبه می‌کند، و `results_payload` member.user را prefetch نکرده است. در مقابل dashboard از annotate/select_related و attendance summary از `select_related` استفاده می‌کند. تعداد/latency واقعی اندازه‌گیری نشده.
7. **اعتبارسنجی و رفتار:** `SessionActionAPIView` هر action غیر `start` را end می‌داند (`api.py:200-208`)، نه فقط `end`. `ParticipantUpdateAPIView` چند تغییر را بدون atomic واحد اعمال می‌کند؛ شکست مرحلهٔ بعد می‌تواند تغییر جزئی بگذارد. API و form اعتبارسنجی‌ها را جدا انجام می‌دهند؛ خطاهای متعدد/unknown ID باید یکپارچه شوند.
8. **Migration:** accounts تا `0002`؛ classrooms تا `0007` شامل تغییر guest، permission backfill و PDF؛ chat تا `0003`؛ whiteboard تا `0003`؛ quizzes و assignments هر کدام `0001`. مسیر واقعی upgrade از دادهٔ production، rollback و قابلیت MySQL/PostgreSQL اجرا نشده است. شاخهٔ دیگر `whiteboard/0004` جدا دارد.

## F. معماری real-time و مقیاس‌پذیری

- مسیر LiveKit: browser token را از Django بعد از resolve member و check waiting می‌گیرد؛ room name از room code (`classrooms/media.py`) و grant منابع بر اساس effective permissions ساخته می‌شود. LiveKit به عنوان SFU جداست، در Compose موجود نیست و کنترل فعال revocation در کد یافت نشد. مسیر mesh: تبادل SDP/ICE از presence socket و انتقال مستقیم P2P. `MESH_MAX_PARTICIPANTS` پیش‌فرض ۱۲ تنها هشدار UI است (`static/js/room.js:456-465`)، نه محدودیت یا ظرفیت اثبات‌شده. TURN اختیاری، نبود آن می‌تواند اتصال برخی شبکه‌ها را مختل کند.
- همهٔ سه consumer هنگام اتصال active membership/session را چک و Origin را کنترل می‌کنند؛ waiting فقط اتصال notification محدود حضور دارد. هنگام عملیات مهم membership/permission مجدداً چک می‌شود و service removal اعلان targeted برای بستن sockets می‌فرستد. این تضمین تمام مسیرهای دریافت passive در صورت حذف مستقیم DB، خرابی Redis یا session logout/user deactivation نیست؛ LiveKit جداست. revalidation دوره‌ای و revocation معتبر لازم است.
- Redis برای cross-process broadcast و limiter مشترک در deployment چند process لازم است؛ fallback in-memory برای development تک‌process مناسب است، بدون Redis در چند worker رویدادها تقسیم می‌شوند. هیچ آزمون failover/delivery انجام نشد.
- whiteboard هر operation پایدار را در DB ذخیره و پخش می‌کند؛ laser ephemeral است. replay فقط آخرین ۲۰۰۰ رویداد (`whiteboard/consumers.py:42-47,346-364`) را می‌دهد، پس محتوای قدیمیِ هنوز روی board ممکن است به reconnect نرسد. watermark `last_seq` با broadcastهای هم‌زمان و خارج از ترتیب می‌تواند operation دیررس با seq کمتر را حذف کند؛ clear برای هر member row lock دارد، نه lock مشترک board (`:153-160,367-405`). این raceها استنباط‌اند و نیازمند تست هم‌زمان دارند. snapshot versioned، ترتیب پایدار و catch-up/dedup توصیه می‌شود.
- چند کلاس و participant زیاد: mesh تعداد اتصال‌های جفتی مرتبهٔ O(n²) دارد؛ SFU فشار را به زیرساخت media منتقل می‌کند نه اینکه بی‌نهایت کند. DB queryهای متعدد per-message، fan-out گروهی، chat/board writes، replay و synchronous conversion گلوگاه‌های بالقوه‌اند. چند دوربین/میکروفون و سقف منابع track در policy موجود تعریف نشده‌اند. queue، backpressure، DB/index، observability، SFU capacity planning و graceful degradation باید براساس اندازه‌گیری طراحی شوند. **هیچ load test انجام نشد؛ ظرفیت واقعی نامعلوم است.**

## G. مهاجرت React بدون بازنویسی شتاب‌زده

صفحات فعلی Django Templates: `templates/home.html`, `base.html` و errorها؛ `accounts/templates/accounts/` برای ورود، ثبت‌نام، reset و profile؛ `classrooms/templates/classrooms/` برای dashboard، list/detail/form، lobby، waiting، room، ended و attendance؛ و templateهای quiz/assignment. `static/js/room.js` (حدود ۱۸۰۵ خط)، `mesh.js`، `media.js`، `chat.js`، `whiteboard.js` و `presentation.js` مستقیم به DOM/template و dataset وابسته‌اند. منطق پروتکل، validation و adapterهای media/WS می‌توانند پس از استخراج و تست حفظ شوند؛ فایل‌ها را بی‌تغییر در React embed کردن معماری مطلوب نیست.

API فعلی برای SPA مستقل کامل نیست: join/guest/admission، moderation، upload/download، presentation، settings، quiz و session lifecycle پراکنده بین HTML JSON و WS هستند؛ versioning، error contract، tenant context و auth guest مستقل هم نیاز دارند. فهرست/جزئیات کلاس و session/message/file/attendance DRF نقطهٔ شروع‌اند، اما سطح مجوز و pagination باید اصلاح شوند. WS و LiveKit protocol قابل حفظ‌اند اگر versioned، tenant/session scoped و دارای revocation و reconnect contract شوند.

**راهکار تدریجی:** (۱) contract و تست regression برای صفحات موجود؛ (۲) API پایدار و policy واحد؛ (۳) React+TypeScript+Vite یا ابزار build تأییدشده در پوشهٔ `frontend/` و Django در ساختار موجود یا `backend/` فقط با migration برنامه‌ریزی‌شده؛ (۴) ابتدا dashboard/profile و organization، سپس class/session management، بعد classroom؛ (۵) route-by-route coexistence و feature flag/rollback. React Router برای navigation، TanStack Query برای server state، Zustand فقط برای ephemeral UI، Tailwind/shadcn/ui و Motion با دسترس‌پذیری و RTL؛ استفاده از state client به جای policy server ممنوع. استقرار same-origin/reverse proxy، session HttpOnly/Secure + CSRF برای requestهای unsafe و همان session برای WS پیشنهاد می‌شود؛ guest session باید جدا و صریح بماند. اگر cross-origin واقعاً لازم شد CORS محدود، credentials، CSRF trusted origins و Origin WS جداگانه بررسی شوند.

## H. تکامل پایگاه داده، tenancy و capacity

### وضعیت موجود و مدل پیشنهادی

`accounts.User` قابل حفظ است. `Classroom` در حال حاضر هم محتوای پایدار و هم room code/settings/presentation لحظه‌ای را دارد؛ `ClassroomSession` چند جلسه برای کلاس را مدل می‌کند ولی همهٔ اتصالات و بیشتر state بر room_code کلاس است. `ClassroomMember` نقش دائمی، guest، admission و presence را مخلوط می‌کند. `ChatMessage` و `Whiteboard` به classroom وصل‌اند نه الزاماً session؛ `SharedFile` session اختیاری دارد؛ Quiz/Assignment نیز به classroom متصل‌اند. هیچ Organization، membership چندسازمانی، tenant FK، permanent group یا invitation مستقل وجود ندارد. چند moderator امکان‌پذیر است ولی owner واحد است و مدل رابطهٔ آموزشی چند teacher و authorization سازمانی موجود نیست.

پیشنهاد منطقی، نه پیاده‌سازی:

```text
Organization 1──N OrganizationMembership N──1 User
Organization 1──N EducationalClass
EducationalClass N──M Teacher (از طریق ClassMembership/role)
EducationalClass 1──N PermanentGroup ──N:M GroupMember
EducationalClass 1──N Session 1──N SessionParticipant
Session 1──N Invitation / AccessPolicy / CapacityReservation
Session 1──N ChatMessage / Whiteboard / SharedFile / AttendanceInterval
```

- `EducationalClass` یک موجودیت آموزشی پایدار است؛ `Session` یک meeting موقت و invitation مخصوص خود دارد. `PermanentGroup` گروه یادگیری پایدار است؛ اگر روزی breakout لازم باشد مدل/عضویت موقت جداگانه در سطح session دارد.
- `OrganizationMembership` با unique `(organization,user)` و وضعیت/role، چند سازمان برای یک user و admin سازمانی را ممکن می‌کند. RBAC سازمانی و کلاسی و session-scoped با اصل least privilege و جلوگیری از آخرین admin حذف‌شده؛ چند teacher از طریق relation نه چند owner. tenant isolation در هر query/command، websocket group، token، storage key، cache key، background job و audit log اعمال شود؛ room code به‌تنهایی مرز tenant نیست.
- حفظ و refactor `ClassroomSession` و Attendance/Chat/Whiteboard/Quiz/Assignment برحسب سیاست retention؛ mapping صریح کلاس‌های قدیمی به یک workspace مالک، تعیین owner و ارتباط session برای دادهٔ مبهم، پشتیبان/restore، migrationهای expand/backfill/validate/contract و قابلیت rollback. guest و active membership فعلی را بدون تحلیل به عضویت سازمانی تبدیل نکنید. از composite integrity/constraints و تست cross-tenant IDOR و DB هدف استفاده کنید.

### طراحی capacity سه‌سطحی

امروز `MAX_FILES_PER_CLASSROOM` و `MESH_MAX_PARTICIPANTS` تنها file cap و هشدار mesh هستند، نه capacity سیستم. در کد شمارش/reservation اتمی برای platform users/orgs/concurrent sessions/participants، organization members/classes/admins/teachers/concurrent sessions/participants/guests یا session/creator participant/guest/camera/mic وجود ندارد. `is_active` membership حضور هم‌زمان محسوب نمی‌شود.

برای هر **بُعد هم‌نوع**، `effective_limit = min(defined applicable platform, organization, session/creator limits)`؛ unlimited را جداگانه تعریف کنید، صفر را ناخواسته نامحدود فرض نکنید، platform total concurrent participants را با per-session limit یکی نگیرید. ساخت/تغییر role و شروع session باید سهمیهٔ مناسب را اتمی بررسی کنند. join/admit/track publish به reservation در DB مشترک با transaction، row lock یا counter اتمی، constraints و lock ordering ثابت نیاز دارد؛ waiting در سیاست روشن ظرفیت جدا یا reservation موقت بگیرد. reservation با idempotency key، status، expiry/heartbeat، reconnect grace، fencing و reconciliation برای disconnect/crash؛ remove/end باید دقیقاً یک بار release کنند. enforce تعداد track در SFU/control plane نیز لازم است، نه فقط UI. رفتار cache/DB failure باید fail-closed یا طبق سیاست صریح باشد. آزمون concurrent روی PostgreSQL و multi-worker و failure injection ضروری است؛ هیچ عدد ظرفیت سخت‌افزار پیشنهاد یا تضمین نمی‌شود.

## I. QA و roadmap اولویت‌بندی‌شده

### موجودی تست و نتایج دقیق

Django test runner/TestCase و Channels communicator در فایل‌های تست استفاده می‌شوند؛ Playwright script در `tests_e2e/` قرار دارد. شمارش ایستای ۲۲۵ متد: accounts ۳، assignments ۱۰، chat ۶، classrooms/tests ۳۹، tests_phase2 ۳۸، tests_phase3 ۴۵، tests_regression ۱۳، tests_security ۲۴، core ۶، quizzes ۱۲، whiteboard ۲۹. این شمارش execution/discovery نیست؛ skipهای conditional مانند وابستگی conversion باید در runtime شمرده شوند.

| نتیجه | مقدار |
|---|---|
| Django tests passed / failed / skipped | **نامعلوم**؛ runner اجرا نشد |
| Django tests not executed | تمام suite؛ **blocked** به علت نبود Django/dependencies و منع نصب |
| E2E/browser/mesh-fail | اجرا نشد؛ browser، سرور و سرویس‌ها NOT VERIFIED |
| integration PostgreSQL/MySQL/Redis/LiveKit/TURN/LibreOffice | اجرا نشد؛ configuration/infrastructure NOT VERIFIED |
| load/concurrency/security penetration | اجرا نشد؛ ظرفیت و exploit عملی NOT VERIFIED |
| Python syntax | ۱۰۸ فایل parse، ۰ خطا؛ نه unit test |
| JS syntax | ۱۳ فایل `static/js/*.js`، ۰ خطا؛ نه browser test |
| coverage | اندازه‌گیری نشده |

تست‌های موجود registration/login/reset، مدل/role، API و media grants، guest، waiting، websocket origin/malformed frames، removal، chat، whiteboard و quiz/assignment را تا حدی پوشش می‌دهند؛ نام تست‌ها proof اجرای موفق یا پوشش کامل نیست. موارد مهم افزوده‌شدنی: concurrent joins/ظرفیت و atomic release، invitation expiry/revoke (هنوز موجود نیست)، revoke عضویت در HTTP/WS/SFU و logout/delete خارج از service، guest impersonation و proxy IP، waiting upload/assignment و event leakage، چند moderator هم‌زمان، whiteboard permission revoke و ترتیب/out-of-order/بیش از ۲۰۰۰ event، reconnect/چند تب/تب crash، session termination، direct media bypass، cross-tenant IDOR و load/failover. CI را در مرحلهٔ مناسب با DB واقعی، تست مرورگر و سرویس‌های ایزوله توسعه دهید؛ اجرای CI در این audit انجام نشده است.

### Phase 1 — Technical audit — CURRENT TASK
- **هدف:** مستندسازی واقعیت و ریسک بدون تغییر رفتار. **بازاستفاده:** کد، تست‌ها و تاریخچهٔ فعلی به‌عنوان شواهد. **تغییر:** فقط همین گزارش. **وابستگی:** دسترسی خواندنی به repository. **ریسک:** محدودیت محیط و branch shallow. **پذیرش:** ارجاعات، تمایز verified/NOT VERIFIED و عدم تغییر فایل دیگر.

### Phase 2 — Critical security and architectural corrections
- **هدف:** رفع C-01 و H-01 تا H-05، اعمال policy واحد و سازگاری lifecycle. **بازاستفاده:** `effective_permissions`, serviceها، origin/frame validation و security tests. **تغییر:** private media، تمام entry pointها، LiveKit control/revocation، DB locks، dependencyهای پشتیبانی‌شده و contract error. **وابستگی:** Phase 1؛ محیط تست ایزوله. **ریسک:** قطع دسترسی فایل/کلاینت قدیمی و تغییر پروتکل. **پذیرش:** تست منفی waiting/direct media/revoke در HTTP/WS/SFU و migration/rollback آزمایش‌شده؛ هیچ رفع عملی ادعایی قبل از تست واقعی پذیرفته نیست.

### Phase 3 — Organization, membership, advanced RBAC
- **هدف:** tenancy و عضویت چندسازمانی و admin/teacher با scope روشن. **بازاستفاده:** `accounts.User`, role/capability concepts و tests. **تغییر:** organization/membership، policy موتور و tenant scope کامل، audit trail و backfill مالک. **وابستگی:** Phase 2 و تصمیم مالکیت داده‌های قدیمی. **ریسک:** نشت cross-tenant و مهاجرت حساب‌های چندمالک. **پذیرش:** دو سازمان با user مشترک، isolation برای API/WS/storage و تست last-admin/revocation.

### Phase 4 — Educational classes and permanent groups
- **هدف:** کلاس آموزشی پایدار، چند teacher و گروه دائمی مجزا از breakout. **بازاستفاده:** metadata کلاس، quiz/assignment و role model به‌عنوان ورودی migration. **تغییر:** class/group membership و foreign keys و backfill امن. **وابستگی:** Phase 3. **ریسک:** معانی مبهم membership فعلی و پاک‌شدن داده. **پذیرش:** چند teacher/group و دانش‌آموز مشترک با جداسازی tenant و حفظ دادهٔ قدیمی.

### Phase 5 — Sessions, invitations, access policies
- **هدف:** lifecycle جلسه و invitation مستقل با expiry/revocation و guest policy. **بازاستفاده:** `ClassroomSession`, attendance، waiting و guest session. **تغییر:** session-scoped room/resources، token دعوت hash‌شده، expiry/usage، admission و termination؛ مجوز مجدد WS/SFU. **وابستگی:** Phases 2–4. **ریسک:** سازگاری لینک‌های قدیمی و قطع جلسهٔ فعال. **پذیرش:** تست invalid/expired/revoked/replay، guest و پایان جلسه در همهٔ مسیرها.

### Phase 6 — Hierarchical capacity management
- **هدف:** enforce محدودیت‌های سه سطحی در همهٔ ابعاد با reservation. **بازاستفاده:** session/participant lifecycle فاز ۵. **تغییر:** limits، effective policy، counters/reservation/lease/reconciliation و SFU track gates. **وابستگی:** Phases 3–5، PostgreSQL و Redis/config عملیاتی. **ریسک:** deadlock، quota leak و overbooking. **پذیرش:** stress test هم‌زمان با limit دقیق، expiry/reconnect/duplicate release و failure recovery؛ بدون ادعای ظرفیت عددی.

### Phase 7 — React + TypeScript frontend
- **هدف:** مهاجرت افزایشی بدون حذف زودهنگام templateها. **بازاستفاده:** API و protocol پایدار، design tokens و منطق قابل استخراج JS. **تغییر:** `frontend/` با React Router، TanStack Query، Zustand، Tailwind، shadcn/ui و Motion؛ auth/CSRF هم‌مبدأ و RTL. **وابستگی:** API/policy Phase 2 و domain Phases 3–5؛ UI capacity پس از ۶. **ریسک:** drift قرارداد، accessibility و دو frontend. **پذیرش:** معادل بودن flows و regression tests، feature flag و rollback، عدم انتقال authorization به client.

### Phase 8 — Classroom integration and feature completion
- **هدف:** classroom React، media، chat، whiteboard، presentation و moderation با UX کامل. **بازاستفاده:** LiveKit integration، socket protocol، board/mesh logic پس از ارزیابی شاخهٔ دیگر. **تغییر:** adapterهای typed، snapshot/reconnect، device/error states، enforcement واقعی و در صورت نیاز mesh محدود. **وابستگی:** Phases 2, 5–7. **ریسک:** ناسازگاری browser/device و out-of-order events. **پذیرش:** آزمون چندکاربره واقعی، قطع/وصل، permissions، waiting و screen share؛ تصمیم صریح برای recording/announcements.

### Phase 9 — Automated testing, security validation, concurrency and deployment readiness
- **هدف:** معیار انتشار مبتنی بر شواهد. **بازاستفاده:** Django/Channels tests، Playwright و CI فعلی. **تغییر:** PostgreSQL/Redis/LiveKit test environment، security review، load/failover، observability، backup/restore و deploy runbook. **وابستگی:** تمام مراحل پیشین؛ تست‌های امنیتی و concurrency البته از Phase 2 به‌صورت مستمر شروع می‌شوند. **ریسک:** محیط غیرنماینده و flaky tests. **پذیرش:** گزارش واقعی pass/fail/skip، تست isolation/revocation، SLO و ظرفیت اندازه‌گیری‌شده با workload مشخص، restore و rollback موفق، sign-off امنیتی.

## J. پیشنهاد نهایی و modular monolith

1. **ادامه در همین repository**، با حفظ تاریخچه و migrationهای موجود؛ rewrite کامل یا microservice بی‌دلیل توصیه نمی‌شود. LiveKit/Redis سرویس‌های زیرساختی جدا هستند، نه دلیل شکستن domain به microservices.
2. **حفظ:** `accounts` و User؛ مفاهیم و تست‌های `classrooms`، validation فایل، chat/whiteboard event protocol، quiz/assignment، templateها تا زمان جایگزینی تأییدشده، و CI به‌عنوان نقطهٔ شروع.
3. **refactor:** `classrooms` به مرزهای شفاف، serviceهای domain و policy واحد؛ `chat`, `whiteboard`, `quizzes`, `assignments` با session/tenant scope؛ استخراج JS از DOM و contractهای typed. `core` برای cross-cutting باقی بماند نه محل business logic پراکنده.
4. **بازطراحی:** organization و RBAC؛ مدل تفکیک EducationalClass/Session/Participant/Group؛ invitations و access policies؛ capacity؛ private media؛ lifecycle و enforcement در SFU؛ snapshot/order تخته. ساختار پیشنهادی Django: `accounts`, `organizations`, `permissions` (یا policy module مشترک نه لزوماً app مستقل)، `educational_classes`, `groups`, `sessions`, `participants`, `invitations`, `capacity`, `realtime`, `whiteboard`؛ `chat`, `quizzes`, `assignments` در جای مناسب حفظ می‌شوند. مرزبندی دقیق appها بعد از طراحی domain و migration تعیین شود؛ rename صوری به‌تنهایی سودی ندارد.
5. **ایمن‌ترین اولین milestone پیاده‌سازی:** Phase 2 با تست‌های بازتولیدپذیر برای direct-media bypass، waiting-room entry points و revocation؛ سپس بستن public media، policy مشترک و قطع media سمت SFU در محیط ایزوله، با تست regression/rollback قبل از توسعهٔ tenancy. React structure پیشنهادی `frontend/src/features/{dashboard,organizations,classes,sessions,classroom,whiteboard,administration}` با `shared/{api,auth,ui,realtime}` است؛ این تنها پیشنهاد است و در این فاز فایلی ایجاد نشده است.
