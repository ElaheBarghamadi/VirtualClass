# راه‌اندازی کامل روی وب‌لاینز — `virtualclass.weblines.ir`

این سند مخصوص همین دامنه است: هر مقداری که باید در پنل بگذارید، آمادهٔ کپی است.
اگر تازه شروع می‌کنید، بخش ۰ را اول بخوانید — سایت الان با دو تنظیم اشتباه بالا است.

---

## ۰) وضعیت همین حالا (بر اساس پاسخ خودِ سایت)

`https://virtualclass.weblines.ir` بالا آمده و Daphne روی پورت ۸۰۰۰ جواب می‌دهد،
اما تنظیماتش هنوز «توسعه‌ای» است:

| چیزی که در پاسخ سایت دیده می‌شود | یعنی | نتیجه |
|---|---|---|
| `DisallowedHost: 'virtualclass.weblines.ir'` و `ALLOWED_HOSTS=['elahe.weblines.ir']` | دامنهٔ قدیمی مانده | **همین حالا همهٔ صفحات `400` می‌دهند** |
| `DEBUG: True` | حالت توسعه | هر خطا **صفحهٔ traceback + همهٔ تنظیمات** را به بازدیدکننده نشان می‌دهد؛ کوکی‌ها `Secure` نیستند |
| `DATABASE_URL: ''` و `ENGINE: sqlite3`, `NAME: /app/db.sqlite3` | بدون دیتابیس | **با هر دیپلوی همهٔ کاربران و کلاس‌ها پاک می‌شوند** |
| `REDIS_URL: ''`, `CHANNEL_LAYERS: InMemory`, `CELERY…EAGER: True` | بدون Redis | رویدادهای چت/تخته فقط داخل همان پروسه می‌رسند؛ کارهای پس‌زمینه درون‌خطی |
| `MEDIA_ROOT: /app/media` | روی فایل‌سیستم کانتینر | لوگو و فایل‌های کلاس با دیپلوی بعدی می‌روند |
| `LIVEKIT_URL: ''` (با `MESH_ENABLED: True` که فقط از `DEBUG` می‌آید) | بدون سرور رسانه | بعد از `DEBUG=false` **دوربین/میکروفون کار نمی‌کند** تا LiveKit بدهید یا Mesh را صریح روشن کنید |

**ترتیب کار:** ۱) متغیرها → ۲) Redeploy → ۳) دیتابیس/Redis/Volume → ۴) سوپرکاربر → ۵) رسانه.

> چرا اول؟ چون `DEBUG=True` روی این دامنه یعنی هر کسی می‌تواند با یک آدرس غلط
> ساختار پروژه، مسیرها و تنظیمات را ببیند. یک دیپلوی با بخش ۱ همین را می‌بندد.

---

## ۱) متغیرهای محیطی (Environment) — کپی کنید

### الف) حداقلِ لازم برای بالا آمدن سالم

```env
DEBUG=false
SECRET_KEY=<رشتهٔ تصادفی زیر>
ALLOWED_HOSTS=virtualclass.weblines.ir
CSRF_TRUSTED_ORIGINS=https://virtualclass.weblines.ir
TRUST_X_FORWARDED_PROTO=true
TIME_ZONE=Asia/Tehran
```

`SECRET_KEY` را با این دستور بسازید (۶۴ کاراکتر، بدون `$` و `#` که در بعضی پنل‌ها مشکل می‌سازند):

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

| متغیر | چرا | اگر غلط باشد |
|---|---|---|
| `DEBUG=false` | بدونش traceback و تنظیمات عمومی می‌شود و کوکی‌ها `Secure` نیستند | صفحهٔ خطای کامل برای همه + کوکی ناامن |
| `ALLOWED_HOSTS` | بدون `https://` و بدون `*` | هر درخواست `400 DisallowedHost` |
| `CSRF_TRUSTED_ORIGINS` | **با** `https://` (چون مرورگر Origin می‌فرستد) | هر فرم، از جمله ورود، `403` |
| `TRUST_X_FORWARDED_PROTO=true` | پروکسی وب‌لاینز TLS را تمام می‌کند و `X-Forwarded-Proto: https` می‌فرستد | CSRF رد می‌شود یا ریدایرکت HTTPS حلقه می‌زند |

> اگر روزی زیردامنهٔ دیگری هم اضافه کردید: `ALLOWED_HOSTS=virtualclass.weblines.ir,.weblines.ir`
> و `CSRF_TRUSTED_ORIGINS=https://virtualclass.weblines.ir,https://*.weblines.ir`.
> `*` تنها (بدون نقطه) با `DEBUG=false` عمداً رد می‌شود.

### ب) پس از ساختن سرویس‌ها (بخش ۳) این‌ها را هم اضافه کنید

```env
# پلتفرم با «+ LINK» خودش تزریق می‌کند؛ دستی نگذارید اگر لینک کرده‌اید
DATABASE_URL=postgres://…

# آدرس خصوصی سرویس Redis
REDIS_URL=redis://default:PASSWORD@redis-host:6379/0

# حجم دائمی (بخش ۳) — بدون این‌ها فایل‌ها با هر دیپلوی می‌روند
MEDIA_ROOT=/data/media
PRIVATE_MEDIA_ROOT=/data/private_media

# رسانه — یکی از دو مسیر بخش ۵
MESH_ENABLED=1
# یا
MEDIA_SERVER_URL=wss://livekit.example.com
MEDIA_SERVER_API_KEY=…
MEDIA_SERVER_API_SECRET=…
MEDIA_TOKEN_TTL_MINUTES=120
```

**در کانتینر `STATIC_ROOT` را دستی نگذارید.** استاتیک‌ها هنگام build داخل ایمیج جمع
می‌شوند (`/app/staticfiles`) و WhiteNoise همان‌جا را سرو می‌کند؛ ست کردن `STATIC_ROOT`
روی یک مسیر خالی، همان «صفحه بدون CSS» کلاسیک است.

بقیهٔ پیش‌فرض‌ها امن‌اند: `SECURE_SSL_REDIRECT=true`, `SECURE_HSTS_SECONDS=30d`,
`SESSION_COOKIE_SECURE=true`. اگر DNS/HTTPS هنوز آماده نیست، موقتاً
`SECURE_SSL_REDIRECT=false` بگذارید و بعد برگردانید.

---

## ۲) تنظیمات Build & Deploy در پنل

| فیلد | مقدار |
|---|---|
| Repository / Branch | همان برنچی که کد نهایی روی آن است (اگر پنل روی `main` build می‌کند، اول merge کنید) |
| Build | **Dockerfile** (نه Auto) |
| Dockerfile path | `deploy/weblines/Dockerfile` |
| Port | `8000` |
| Start / Run command | **خالی** (CMD ایمیج = `entrypoint`) |
| Health check path | `/healthz` (یا `/healthz?db=1` برای بررسی دیتابیس) |
| Memory | حداقل ۵۱۲MB؛ برای کلاس واقعی با چند دوربین ۱GB |

اگر پنل «Start command» را اجباری می‌خواهد: `/usr/local/bin/entrypoint`.
هر چیزی شبیه `gunicorn` یا `python manage.py runserver` را نگذارید — گونیکورن
WebSocket ندارد و اتاق/چت/تخته وصل نمی‌شود.

---

## ۳) سرویس‌های پنل (به همین ترتیب)

1. **PostgreSQL** → `+ NEW SERVICE → Database → PostgreSQL` → کوچک‌ترین پلن کافی است
   → در کارت اپ: `+ LINK` → همان دیتابیس را تیک بزنید → **Redeploy**.
   (`DATABASE_URL` خودکار تزریق می‌شود؛ تاییدش: `deploy_check` باید `database: postgresql` بنویسد.)
2. **Redis** → `+ NEW SERVICE → Redis` → آدرس خصوصی را در `REDIS_URL` بگذارید → Redeploy.
   با این کار: channel layer مشترک، cache مشترک، صف Celery واقعی.
3. **Volume** → `+ Volume` و mount روی `/data` → `MEDIA_ROOT=/data/media`,
   `PRIVATE_MEDIA_ROOT=/data/private_media` → Redeploy. (فقط همین مسیرها بین دیپلوی‌ها می‌مانند.)
4. **Worker** → یک سرویس دیگر از **همان ایمیج** با `ROLE=worker` (برای تبدیل Office → PDF و کارهای صف).
5. **Beat** → یک سرویس با `ROLE=beat` و **فقط یکی** (جلسهٔ رهاشده، نگهداری داده، پاک‌سازی مهمان).

کارگر و beat به همان `.env` اپ نیاز دارند؛ خصوصاً `SECRET_KEY`, `DATABASE_URL`, `REDIS_URL`,
`MEDIA_ROOT`, `PRIVATE_MEDIA_ROOT`.

---

## ۴) بالا آمدن و تأیید (چه چیزی «کامل» است)

`entrypoint` هنگام هر boot این‌ها را انجام می‌دهد و بعد Daphne را بالا می‌آورد:

1. یک خط تشخیصی `deploy_check --brief`
2. ساختن مسیرهای مدیا
3. `python manage.py migrate --noinput`
4. (فقط اگر `STATIC_ROOT` ست شده باشد) `collectstatic`

لاگ سالم در همان چند ثانیهٔ اول:

```text
entrypoint: role=web port=8000
deploy_check: server: asgi (daphne) | debug: False | database: postgresql | static: 184 files in /app/staticfiles
```

تأیید از بیرون:

```bash
curl -fsS https://virtualclass.weblines.ir/healthz            # {"status": "ok", "debug": false}
curl -fsS https://virtualclass.weblines.ir/healthz?db=1       # + "database": "ok"
curl -s -o /dev/null -w '%{http_code}\n' https://virtualclass.weblines.ir/accounts/login/   # 200
curl -sI https://virtualclass.weblines.ir/static/css/room.css | head -1                     # 200
```

ساخت حساب مدیر (از تب **Shell** همان اپ، یا یک سرویس `ROLE=shell`):

```bash
python manage.py createsuperuser
# غیرتعاملی:
DJANGO_SUPERUSER_USERNAME=admin \
DJANGO_SUPERUSER_EMAIL=admin@example.com \
DJANGO_SUPERUSER_PASSWORD='یک-رمز-قوی' \
python manage.py createsuperuser --noinput
```

بررسی تنظیمات (باید فقط **دو** هشدار بدهد: `deploy.W002` اگر Redis ندارید و
`security.W021` که عمدی است):

```bash
python manage.py deploy_check
python manage.py check --deploy
```

---

### ۴.۱) دستورهایی که در تب Shell می‌زنید (کپی‌پیست)

داخل شلِ اپ، پوشهٔ کاری `/app` است و پکیج‌ها داخل ایمیج نصب‌اند؛ پس **بدون** `.venv`
و فقط `python manage.py …`. این‌ها جایی ذخیره نمی‌شوند — هر `export` بعد از بستن شل
می‌رود؛ متغیرها را در پنل Environment بگذارید.

```bash
# ۰) اول ببینید این کانتینر با چه تنظیماتی بالا آمده (DB، استاتیک، Redis، نوع سرور)
python manage.py deploy_check

# ۱) اگر مایگریشن‌ها اعمال نشده‌اند (entrypoint معمولاً خودش می‌زند)
python manage.py migrate --noinput

# ۲) فقط اگر STATIC_ROOT را دستی ست کرده‌اید (در کانتینر لازم نیست)
python manage.py collectstatic --noinput

# ۳) ساخت حساب مدیر — تعاملی
python manage.py createsuperuser

#    یا غیرتعاملی (اگر شل تعاملی نیست):
DJANGO_SUPERUSER_USERNAME=admin DJANGO_SUPERUSER_EMAIL=admin@example.com DJANGO_SUPERUSER_PASSWORD='یک-رمز-قوی' python manage.py createsuperuser --noinput

# ۴) بررسی تنظیمات پروداکشن (باید فقط W002/W021 یا W008 بدهد)
python manage.py check --deploy

# ۵) سلامت از داخل خودِ کانتینر
curl -fsS http://127.0.0.1:8000/healthz?db=1

# ۶) نگه‌داری دوره‌ای (اگر beat ندارید)
python manage.py housekeeping
```

اگر لازم شد اپ را دستی بالا بیاورید (مثلاً Start command پنل خالی است و می‌خواهید
تست کنید) — این موقتی است، چون با بستن شل پروسه می‌میرد:

```bash
daphne -b 0.0.0.0 -p 8000 --proxy-headers config.asgi:application
```

> Worker و Beat را در شل اجرا نکنید؛ هر کدام یک **سرویس جدا** با همان ایمیج و
> `ROLE=worker` / `ROLE=beat` هستند (بخش ۳).

> ⚠️ اگر `deploy_check` نوشت `database: sqlite3`، هر کاری در شل (از جمله ساخت
> سوپرکاربر) با دیپلوی بعدی پاک می‌شود. اول PostgreSQL را لینک کنید، بعد این دستورها.

## ۵) دوربین و میکروفون: یکی از دو مسیر را انتخاب کنید

با `DEBUG=false` حالت P2P خودش خاموش می‌شود (`MESH_ENABLED` پیش‌فرض `0`) تا کلاس روی
سرورِ واقعی از مسیر کنترل‌شده برود. پس یکی از این دو لازم است:

**الف) LiveKit (توصیه‌شده برای کلاس واقعی)** — یک پروژهٔ LiveKit (ابری یا self-host)
بسازید و مقادیرش را بگذارید:

```env
MEDIA_SERVER_URL=wss://your-livekit-host
MEDIA_SERVER_API_KEY=API...
MEDIA_SERVER_API_SECRET=...
MEDIA_TOKEN_TTL_MINUTES=120
```

`MEDIA_SERVER_URL` باید از **مرورگر** قابل دسترسی باشد (`wss://` معتبر با گواهی درست)
و key/secret فقط سمت سرور می‌ماند (توکن کوتاه‌عمر صادر می‌شود). Django هیچ‌وقت خودش
مدیا را پروکسی نمی‌کند.

**ب) Mesh (ساده، برای گروه‌های کوچک)** — بدون سرور رسانه:

```env
MESH_ENABLED=1
MESH_MAX_PARTICIPANTS=8
# برای شبکه‌های سخت‌گیر (NAT)، TURN لازم است — بستهٔ آماده در deploy/coturn/
WEBRTC_ICE_SERVERS=[{"urls":["turn:turn.example.com:3478?transport=udp"],"username":"classroom","credential":"…"}]
```

محدودیت mesh: با تعداد زیاد شرکت‌کننده سنگین می‌شود و نمی‌تواند اتصالِ برقرارشدهٔ یک
دانش‌آموزِ حذف‌شده را قطع کند.

---

## ۵.۱) «دوربین و میکروفون روشن می‌شود، ولی بقیه نمی‌بینند»

این تقریباً همیشه **مشکل شبکه است، نه باگ اپ**:

* پیش‌نمایش تصویر خودتان مستقیماً از دوربین می‌آید؛ پس دکمه و دوربین سالم‌اند.
* رسیدن تصویر به هم‌کلاسی به **ICE** بستگی دارد: دو مرورگر باید یک مسیر مستقیم
  (یا از طریق رله) پیدا کنند. پشت NAT سخت‌گیر / شبکهٔ موبایل (CGNAT) این مسیر
  پیدا نمی‌شود و تصویر «روشن است ولی نمی‌رسد».
* تنظیم فعلی این هاست: `MEDIA_SERVER_URL` خالی → حالت P2P، و `WEBRTC_ICE_SERVERS`
  خالی → فقط STUN عمومی گوگل (که در بسیاری از شبکه‌های ایران جواب نمی‌دهد).

**تأیید در ۳۰ ثانیه:** در اتاق، کارت «تست صدا و تصویر» → «شروع تست». حالا یک خط
شبکه هم نشان می‌دهد:

| پیام | یعنی | کار |
|---|---|---|
| «رلهٔ سرور (TURN) در دسترس است» | مسیر رله هست | مشکلی نیست |
| «فقط با STUN جواب داد» | شبکه‌های باز کار می‌کند، NAT سخت نه | TURN یا LiveKit |
| «هیچ آدرس عمومی برنگرداند» | هیچ مسیری نیست | TURN یا LiveKit |

همین را در کنسول مرورگر هم می‌بینید: `[device-test] ice candidates: host,srflx` و
برای هر لینک `[mesh] link up with … local=relay remote=srflx`.

**راه‌حل الف — LiveKit (بدون سرور، مناسب همین هاست)**
یک پروژهٔ LiveKit Cloud (پلن رایگان هم دارد) بسازید و سه مقدار را بگذارید؛ پلن
Cloud روی TCP/443 کار می‌کند و نیازی به باز کردن پورت UDP ندارد:

```env
MEDIA_SERVER_URL=wss://your-project.livekit.cloud
MEDIA_SERVER_API_KEY=APIxxxxxxxx
MEDIA_SERVER_API_SECRET=****************
MESH_ENABLED=0
```

**راه‌حل ب — TURN خودتان (سرور مجازی لازم است)**
راهنمای آمادهٔ ریپو: [`deploy/coturn/`](coturn/). خلاصه: `coturn` را روی یک VPS نصب
کنید، `turnserver.conf` را با `realm` و `user=classroom:<secret>` پر کنید، پورت‌های
**3478/udp**, **3478/tcp** و **49152–65535/udp** را باز کنید، سپس:

```env
MESH_ENABLED=1
WEBRTC_ICE_SERVERS=[{"urls":["stun:turn.example.com:3478"]},{"urls":["turn:turn.example.com:3478?transport=udp"],"username":"classroom","credential":"<secret>"}]
```

**آزمون سریع برای اثبات تشخیص (موقت، نه برای کلاس واقعی):** یک رلهٔ عمومی رایگان
مثل Open Relay را موقتاً اضافه کنید؛ اگر تصویر بلافاصله رسید، مشکل قطعاً TURN بوده
و فقط باید رلهٔ خودتان (یا LiveKit) را جایگزین کنید:

```env
WEBRTC_ICE_SERVERS=[{"urls":["turn:openrelay.metered.ca:80","turn:openrelay.metered.ca:443?transport=tcp"],"username":"openrelayproject","credential":"openrelayproject"}]
```

> `python manage.py check --deploy` این وضعیت را هم گزارش می‌کند:
> `deploy.W008` = mesh بدون TURN (تصویر فقط بین شبکه‌های باز)،
> `deploy.W009` = نه LiveKit نه mesh (رسانه کاملاً خاموش).

---

## ۶) عیب‌یابی مخصوص همین دامنه

| نشانه | علت | رفع |
|---|---|---|
| `DisallowedHost: 'virtualclass.weblines.ir'` | `ALLOWED_HOSTS` قدیمی است | `ALLOWED_HOSTS=virtualclass.weblines.ir` + Redeploy |
| همهٔ صفحات `400` | همان بالا | همان |
| هر POST `403` (ورود هم) | `CSRF_TRUSTED_ORIGINS` خالی/قدیمی یا هدر پروکسی | `CSRF_TRUSTED_ORIGINS=https://virtualclass.weblines.ir` + `TRUST_X_FORWARDED_PROTO=true` |
| «صفحه بدون CSS» | `collectstatic` نشده یا `STATIC_ROOT` دستی ست شده | `STATIC_ROOT` را در کانتینر خالی کنید و Full rebuild بزنید |
| بعد از هر دیپلوی کاربران رفته‌اند | `DATABASE_URL` خالی → SQLite در کانتینر | PostgreSQL را لینک کنید (`deploy_check` → `postgresql`) |
| `no such table: classrooms_classroom` | کانتینر تازه بالا آمده و `migrate` اجرا نشده (Start command پنل `entrypoint` را رد کرده) | از Shell: `python manage.py migrate --noinput`؛ Start command را خالی/`/usr/local/bin/entrypoint` کنید و PostgreSQL لینک کنید تا دیگر تکرار نشود. کد فعلی برای همین حالت صفحهٔ ۵۰۳ با پیام «پایگاه‌داده آماده نیست» می‌دهد، نه traceback |
| در `check --deploy` می‌بینید `deploy.W010` | دیتابیسِ جلوی این پروسه خالی/بدون مایگریشن است | همان `migrate` |
| `DisallowedHost … You may need to add '<دامنه>' to ALLOWED_HOSTS` | `ALLOWED_HOSTS` این دامنه را ندارد (با تغییر env، مقدار قبلی مانده) | `ALLOWED_HOSTS=virtualclass.weblines.ir` یا برای همهٔ زیردامنه‌ها `ALLOWED_HOSTS=.weblines.ir`؛ یا `PUBLIC_URL=https://virtualclass.weblines.ir` بگذارید تا خودکار اضافه شود — بعد Redeploy. کد فعلی به‌جای traceback صفحهٔ ۴۰۰ با نام دامنهٔ رسیده و فهرست فعلی نشان می‌دهد |
| در `check --deploy` می‌بینید `deploy.W011` | `ALLOWED_HOSTS` فقط localhost/LAN است | همان `ALLOWED_HOSTS=<دامنه>` |
| چت/تخته بین دو تب یا دو نفر همگام نیست | `REDIS_URL` خالی → channel layer درون‌پروسه | سرویس Redis + `REDIS_URL` |
| `/healthz` از داخل کانتینر ۲۰۰ است ولی پنل می‌گوید unhealthy | پروب با IP صدا می‌زند | کد فعلی `/healthz` را از بررسی Host مستثنی می‌کند؛ مسیر Health check را روی `/healthz` بگذارید |
| دوربین/میکروفون بی‌صدا است | `MEDIA_SERVER_URL` خالی و `MESH_ENABLED=0` | بخش ۵ |
| `502` | پورت/Start command | Port `8000`، Start command خالی |
| خط `deploy_check:` در لاگ نیست | entrypoint اجرا نشده | Start command = `/usr/local/bin/entrypoint` (یا Build روی Dockerfile) |

---

## ۷) چک‌لیست تحویل

- [ ] `DEBUG=false` و `SECRET_KEY` واقعی (۶۴ کاراکتر)
- [ ] `ALLOWED_HOSTS=virtualclass.weblines.ir` و `CSRF_TRUSTED_ORIGINS=https://virtualclass.weblines.ir`
- [ ] `TRUST_X_FORWARDED_PROTO=true`
- [ ] PostgreSQL لینک‌شده و `deploy_check` → `database: postgresql`
- [ ] Redis + `REDIS_URL` (+ Worker و Beat)
- [ ] Volume روی `/data` و `MEDIA_ROOT`/`PRIVATE_MEDIA_ROOT`
- [ ] رسانه: LiveKit **یا** `MESH_ENABLED=1`
- [ ] `https://…/healthz?db=1` → `{"status":"ok","database":"ok"}`
- [ ] `check --deploy` → فقط `W002`/`W021`
- [ ] سوپرکاربر ساخته‌شده و ورود مدیر آزمایش شده
- [ ] یک کلاس آزمایشی: باز کردن «کلاس»، ورود با حساب مهمان، چت، تخته، ارائه یک PDF
