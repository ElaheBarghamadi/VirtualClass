# تثبیت امنیت VirtualClass — Phase 2

**وضعیت: کار جزئی است؛ برای داده‌های حساس production-ready نیست.** این سند جایگزین `docs/NEXTCLASS_TECHNICAL_AUDIT.md` نیست. برچسب «تأیید» زیر به آزمون‌های مشخص‌شده محدود است و به معنی تأیید زیرساخت production یا LiveKit واقعی نیست.

## خلاصهٔ وضعیت امنیت

| مورد | وضعیت | شواهد و محدودیت |
|---|---|---|
| جداسازی ذخیره و endpoint فایل خصوصی | FIXED BUT NOT FULLY VERIFIED | `classrooms/storage.py`, `classrooms/views.py:file_download_view`, `assignments/views_manage.py:submission_download_view`: آزمون Django محلی؛ انتقال فایل‌های قدیمی و قطع دسترسی وب‌سرور باید دستی و قبل از انتشار انجام شود. وب‌سرور واقعی تست نشده است. |
| کنترل waiting در upload، assignment، API و WS | PARTIALLY FIXED | `classrooms/permissions.py:is_admitted`, `effective_permissions`, `classrooms/api.py`, `assignments/views_manage.py`, `classrooms/consumers.py` و تست‌های جدید. همهٔ raceها و تمام مسیرهای خارج از این موارد در deployment توزیع‌شده تأیید نشده‌اند. |
| مجوز approve/deny، self-approval و stale target | FIXED BUT NOT FULLY VERIFIED | `classrooms/services.py:_waiting_action_members`, `approve_waiting_room`, `deny_waiting_room`: DB check و row lock، تست SQLite. PostgreSQL concurrency و رویدادها قبل از commit تست نشده‌اند. |
| صدور token تازه برای عضو waiting یا حذف‌شده | FIXED AND VERIFIED | در تست محلی `test_removed_or_waiting_member_cannot_obtain_new_media_token`؛ مجوز هنگام صدور از `effective_permissions` است و response از cache منع شده (`media_token_view`). این ادعا به token تازه محدود است. |
| قطع رسانهٔ فعال/ابطال token صادرشده، پایان session و reconnect | NOT FIXED | نه disconnect سمت LiveKit اجرا شده، نه invalidation قابل اتکا، نه mesh کنترل سروری دارد. صرف TTL یا قطع WS کافی نیست. تا حل و آزمایش واقعی از این سیستم برای محتوای محرمانه یا الزام moderation اجباری استفاده نکنید. |
| invitation expiry/revocation | NOT FIXED | مدل invitation مستقل وجود ندارد؛ room code یک لینک مشترک است. تست انقضای invitation قابل اجرا نیست. |
| شروع هم‌زمان session | PARTIALLY FIXED | `start_session` روی `Classroom` و session انتخاب‌شده lock می‌گیرد و session نامعتبر/پایان‌یافته را رد می‌کند؛ فقط SQLite آزموده شده، SQLite تضمین lock ردیفی PostgreSQL را ندارد. |
| dependencyهای آسیب‌پذیر | NOT FIXED | `pip-audit` روی lock آزمایش ۵۵ مورد در Django، DRF و Pillow گزارش کرد؛ وابستگی‌ها در این تغییر ارتقا نیافتند. برای production ارتقای سازگار و ارزیابی مجدد الزامی است. |

## معماری فایل خصوصی و اقدام اجباری مدیر استقرار

- `Classroom.logo` همچنان دارایی عمومی زیر `MEDIA_ROOT/classroom_logos/` است؛ در DEBUG تنها همین زیرمسیر از Django سرو می‌شود. `SharedFile.file`, `SharedFile.pdf_version` و `Submission.file` از `PrivateFileStorage` و `PRIVATE_MEDIA_ROOT` جدا از `MEDIA_ROOT` استفاده می‌کنند. storage عمداً URL عمومی تولید نمی‌کند. `PRIVATE_MEDIA_ROOT` پیش‌فرض `BASE_DIR/private_media` و قابل تنظیم با environment variable است؛ برنامه هم‌پوشانی آن با `MEDIA_ROOT` را رد می‌کند. فایل خصوصی نباید از هیچ URL mapping، CDN، object-storage public bucket، `alias` یا reverse proxy دیگری منتشر شود.
- `file_download_view` فقط عضو فعال و پذیرفته‌شدهٔ همان کلاس فعال، از جمله guest وابسته به session خود را می‌پذیرد و ID فایل را در همان کلاس محدود می‌کند. `submission_download_view` فقط owner کلاس یا همان عضو ثبت‌نامی صاحب submission را پس از بررسی admission می‌پذیرد؛ شناسهٔ کلاس، assignment و submission با هم بررسی می‌شوند. فایل موجودنبودنی 404 می‌دهد؛ پاسخ attachment، `Cache-Control: private, no-store` و `X-Content-Type-Options: nosniff` دارد. اعتبارسنجی extension/size/magic فعلی هنگام upload حفظ شده و آنتی‌ویروس یا sandbox کامل نیست.
- **قبل از انتشار، نگاشت عمومی کل مسیر قدیمی را ببندید**، به‌ویژه `/media/classrooms/`. محدود کردن مسیرهای Django به‌تنهایی یک Nginx/Apache/PythonAnywhere یا CDN موجود را ایمن نمی‌کند. فقط `MEDIA_ROOT/classroom_logos/` را برای لوگوهای عمومی نگاشت کنید؛ هرگز `PRIVATE_MEDIA_ROOT` را mapping نکنید. روی PythonAnywhere ردیف قدیمی `/media/` که کل media را نشان می‌دهد را حذف و تنها `/media/classroom_logos/` را به `.../media/classroom_logos/` وصل کنید. فایل‌های قدیمی باید از URLهای عمومی حتی در cache/CDN قابل دسترس نباشند.
- مهاجرت‌های `assignments/0002` و `classrooms/0008` تنها تنظیم storage در model را عوض می‌کنند و **هیچ فایل موجودی را منتقل یا حذف نمی‌کنند**. پیش از راه‌اندازی نسخهٔ جدید: maintenance/read-only window و backup معتبر بگیرید؛ مسیر `MEDIA_ROOT/classrooms/` قدیمی را با حفظ ساختار و نام‌های نسبی به `PRIVATE_MEDIA_ROOT/classrooms/` **کپی** کنید؛ فایل‌های اصلی، PDF و assignment را با تعداد، اندازه و checksum در نمونه/کل داده بررسی و owner/permissions سرویس را تنظیم کنید. در Docker، volume جدید `private_media_data` در `/app/private_media` جداگانه است و کپی بین volumeها عملیاتی لازم دارد. کد به فایل قدیمی در مسیر عمومی fallback نمی‌کند؛ اگر کپی انجام نشود دانلودها 404 خواهند بود. پیش از ازسرگیری ترافیک، مسیر قدیمی و cacheهایش را از دسترس عمومی خارج و کنترل کنید؛ پاک‌سازی نسخهٔ قدیمی فقط طبق برنامهٔ backup/retention و پس از تأیید اپراتور انجام شود. مجوز directory را به حساب سرویس محدود و backup خصوصی را جداگانه ایمن کنید.
- پس از کپی، migrations را طبق روال deployment اعمال کنید؛ دانلود مجاز owner/student/guest، IDOR، مستقیم `/media/classrooms/...` و یک لوگوی عمومی را با وب‌سرور واقعی آزمایش کنید. تنظیمات ذخیره‌سازی شخصی‌شده یا چند host نیاز به برنامهٔ انتقال اختصاصی دارند. تغییر storage را بدون هماهنگی و کپی در محیط دارای داده deploy نکنید.

نمونهٔ Nginx (مسیر نمونه را مطابق استقرار جایگزین کنید؛ فایل‌های public باید برای Nginx قابل خواندن باشند):

```nginx
location ^~ /media/classroom_logos/ {
    alias /srv/virtualclass/media/classroom_logos/;
}
location ^~ /media/ { return 404; }
# همهٔ endpointهای /class/ و /classrooms/ را به Django/ASGI proxy کنید.
# هرگز PRIVATE_MEDIA_ROOT یا مسیر قدیمی فایل خصوصی را alias نکنید.
```

این قطعه پیکربندی کامل TLS، proxy یا cache نیست. در صورت استفاده از CDN، قوانین معادل و purge نیز لازم‌اند.

## سیاست انتظار و authorization

`is_admitted` membership فعال، کلاس فعال و نبود waiting را شرط می‌کند. `effective_permissions` برای عضو منتظر تمام قابلیت‌ها را false می‌گذارد؛ کلاس detail API و فایل/assignment نیز admission را می‌سنجند. در `approve_waiting_room`/`deny_waiting_room` عضو باید فعال، پذیرفته‌شده و OWNER/MODERATOR باشد، target باید عضو فعالِ واقعاً منتظر همان کلاس باشد، self-action ممنوع است و moderator حق مدیریت privileged peer ندارد. DB دوباره خوانده و row lock گرفته می‌شود. `ClassroomConsumer.classroom_event` رویدادهای waiting entry/denial را فقط پس از بررسی privilege جاری به میزبان می‌دهد؛ خود شخص منتظر اتصال notification محدود دارد و نمی‌تواند از طریق action در WS خود را approve کند. این پروژه مدل Session-scoped admission ندارد و تصمیم مجوز با کلاس است؛ نباید آن را کنترل مستقل هر session تصور کرد.

بعضی broadcastها هنوز داخل transaction رخ می‌دهند؛ تحویل قبل از commit یا rollback و رفتار چند worker/Redis باید با تست واقعی و طراحی `on_commit`/outbox رفع شود. تغییر مستقیم DB یا حذف account الزاماً notification برای socketهای موجود ایجاد نمی‌کند. `is_active` عضویت نیز حضور واقعی نیست. دور زدن waiting از طریق منابع دیگری که در این تغییر بررسی نشده‌اند باید پیش از production audit شود.

## LiveKit، P2P و محدودیت قطع دسترسی

`classrooms/views.py:media_token_view` پس از resolve عضو/session و رد waiting token تولید می‌کند؛ `classrooms/media.py:generate_media_token` منبع‌های microphone/camera/screen را از effective permissions می‌گیرد؛ پیش‌فرض TTL تنظیم فعلی ۳۶۰ دقیقه است. response دارای `no-store` است. این هیچ تضمینی برای قطع stream موجود یا باطل شدن token قبلاً صادرشده ایجاد نمی‌کند.

SDK نصب‌شده `livekit-api==1.2.2` دارای `RoomService.remove_participant(RoomParticipantIdentity)`, `update_participant(UpdateParticipantRequest)` و `delete_room(DeleteRoomRequest)` است. این patch آنها را **فراخوانی نمی‌کند**: اتصال فعال، tokenهای قبلی، retry/failure و race بین DB و SFU، session اختیاری و نام room مبتنی بر classroom نیازمند طراحی مشخص و LiveKit واقعی‌اند. در mesh حتی یک API سروری برای قطع peer-to-peer موجود نیست؛ اعتماد به client برای mute/removal کافی نیست. حذف بدون ban دائمی می‌تواند در کلاس باز دوباره join شود؛ expiration/revocation دعوت هم وجود ندارد. `end_session` فعلی رسانه را قطع یا token issuance/reconnection را مسدود نمی‌کند. هنگام نیاز به قطع واقعی، طراحی session-bound room و generation، سرویس control plane با ثبت durable، retry/fail-closed، سیاست token/rejoin و حذف یا محدودسازی transport mesh باید تصویب و با SFU واقعی و client مخرب آزموده شود. هیچ ادعای راستی‌آزمایی LiveKit واقعی در این سند وجود ندارد.

## محیط، نصب و آزمایش

`requirements.txt` منبع محدودهٔ dependencyهای runtime است؛ `requirements-dev.txt` اضافه‌های E2E و fixture را تعریف می‌کند، اما بازه‌ها بدون lock قابل تکرار دقیق نیستند. `requirements-test-lock.txt` snapshot محیط unit test حاضر برای Python 3.11 است، با نسخه‌های دقیق و بدون hash؛ production lock امن یا تأیید چند platform نیست و شامل Playwright نیست. این snapshot شامل نسخه‌های آسیب‌پذیر است و **برای deployment استفاده نشود**.

```sh
python3.11 -m venv .venv
. .venv/bin/activate
pip install -r requirements-test-lock.txt
python manage.py check
python manage.py makemigrations --check --dry-run
python manage.py test --noinput
python manage.py test classrooms.tests_stabilization classrooms.tests_security --noinput
for f in static/js/*.js; do node --check "$f"; done
```

برای E2E، جداگانه از `requirements-dev.txt` و Chromium/Playwright، سرویس تست ایزوله و دادهٔ آزمایشی استفاده کنید. LibreOffice برای conversion tests، Redis برای چند worker، PostgreSQL برای row locking/concurrency، و یک سرور LiveKit واقعی برای تست remove/update/delete/reconnect لازم‌اند. اجرای E2E یا مهاجرت production به عنوان بخشی از استقرار این patch خودکار نشده است. متغیرهای مهم: `PRIVATE_MEDIA_ROOT`, `SECRET_KEY`, `DEBUG`, `ALLOWED_HOSTS`, `DATABASE_URL`, `REDIS_URL`, `MEDIA_SERVER_URL`, `MEDIA_SERVER_API_KEY`, `MEDIA_SERVER_API_SECRET`, `MEDIA_TOKEN_TTL_MINUTES`, `WEBRTC_ICE_SERVERS` و متغیرهای HTTPS/CSRF در `.env.example` و `config/settings.py`؛ secretها را فقط از secret manager/environment تأمین کنید.

### نتایج این محیط

- Django/Python: 3.11.2 / 5.0.14؛ full suite: **234 تست، 229 موفق، 0 شکست، 5 skipped** (LibreOffice موجود نبود). Full suite پس از همهٔ تغییرات اجرایی اجرا شد.
- targeted نهایی: `classrooms.tests_stabilization`, `classrooms.tests_security`, `classrooms.tests_phase2`, `assignments.tests`، **81/81 موفق**؛ تست مستقل جدید 9/9 موفق.
- `manage.py check`: بدون issue؛ `makemigrations --check --dry-run`: بدون تغییر؛ `pip check`: بدون ناسازگاری dependency؛ syntax: 112 فایل Python و 13 فایل JS بدون خطا. `check --deploy` با تنظیمات development شش هشدار داد؛ با یک تنظیم آزمایشی DEBUG=false یک هشدار اختیاری HSTS preload (`security.W021`) داد. هیچ‌کدام تأیید استقرار production واقعی نیست.
- `pip-audit --disable-pip --no-deps -r requirements-test-lock.txt`: خروجی nonzero و **55 vulnerability report در 3 package** (Django 5.0.14، DRF 3.17.2، Pillow 12.3.0؛ شناسه‌ها شامل `PYSEC-2026-3717` و `CVE-2026-114138`). دادهٔ advisory و applicability هر مورد باید بررسی شود؛ تکرار aliasها الزاماً ۵۵ exploit مستقل نیست. ارتقای Django پشتیبانی‌شده و DRF/Pillow سازگار، بازبینی وابستگی، migration و آزمایش کامل کار بعدی پیش از production است.
- LiveKit، TURN، PostgreSQL، Redis، LibreOffice، browser E2E و deployment/proxy واقعی: **NOT VERIFIED**. هیچ load test یا ادعای ظرفیت انجام نشده است.
