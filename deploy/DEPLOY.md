# استقرار روی سرور — راهنمای کامل

این سند دو مسیر را پوشش می‌دهد:

* **الف) ابر وب‌لاینز (PaaS)** — همان پنلی که باز کرده‌اید؛ کانتینری، بدون دسترسی به nginx، دامنه و SSL خودکار.
* **ب) سرور مجازی (VPS)** — nginx + Daphne + systemd + Redis + Celery.

هر دو مسیر با **همین کد** کار می‌کنند؛ فرقشان فقط در «چه کسی استاتیک را سرو می‌کند» و «چه کسی پروسه‌ها را بالا نگه می‌دارد» است.

---

## ۰) در یک نگاه

| نیاز | اجباری؟ | چرا |
|---|---|---|
| Python 3.11+ | ✅ | بدنهٔ اپ |
| PostgreSQL | توصیهٔ جدی | در کانتینر، SQLite با هر دیپلوی پاک می‌شود |
| `collectstatic` | ✅ **حتماً** | با `DEBUG=false` جنگو استاتیک سرو نمی‌کند؛ WhiteNoise از `STATIC_ROOT` سرو می‌کند |
| Redis | برای چند پروسه ✅ | channel layer + cache + صف Celery؛ بدونش تک‌پروسه و کارها درون‌خطی |
| Celery worker | برای تبدیل Office | بدونش تبدیل همان‌جا و درون درخواست انجام می‌شود |
| Celery beat یا کرون | اختیاری | جلسهٔ رهاشده، نگهداری داده، پاک‌سازی مهمان |
| فضای دائمی (volume) | ✅ در کانتینر | `media/` و `private_media/` وگرنه با هر دیپلوی پاک می‌شوند |
| LiveKit | اختیاری | بدونش اتاق روی mesh P2P کار می‌کند |

> **چرا استاتیک‌ها لود نمی‌شوند؟** با `DEBUG=false` دیگر `runserver`/جنگو فایل‌های `/static/` را سرو نمی‌کند و `daphne` هم به‌تنهایی این کار را نمی‌کند. این پروژه **WhiteNoise** دارد: کافی است یک بار `python manage.py collectstatic --noinput` اجرا شود تا فایل‌ها در `STATIC_ROOT` باشند و اپ خودش سروشان کند — بدون nginx. جزئیات در بخش ۳.

---

## ۰.۱) لاگِ سالم چه شکلی است؟

هر دیپلوی (با ایمیجِ ما) با این دو خط شروع می‌شود — و اگر شروع نشود، همان‌جا مشکل را پیدا کرده‌اید:

```text
entrypoint: role=web port=8000
deploy_check: server: asgi (daphne) | debug: False | database: postgresql | static: 179 files in /app/staticfiles
```

| در لاگ می‌بینید | یعنی | کار |
|---|---|---|
| `Starting gunicorn …` یا `Booting worker with pid` | پلتفرم به‌جای `CMD` ایمیج، **پروسهٔ WSGI خودش** را بالا آورده. گونیکورن WebSocket ندارد؛ `/ws/` هیچ‌وقت وصل نمی‌شود | Build settings را روی **Dockerfile** (`deploy/weblines/Dockerfile`) بگذارید. اگر فیلد «Start command» دارید، خالی‌اش کنید یا `/usr/local/bin/entrypoint` بگذارید |
| `Not Found: /ws/classroom/…` پشت سر هم | همان مورد بالا: درخواست به جنگوی WSGI می‌رسد و هیچ مسیری برای `/ws/` نیست | همان. با کد فعلی، جای این ۴۰۴ها یک خط `websocket_under_wsgi` و پاسخ `426` می‌بینید |
| `WSGI app sent body bytes on a no-body response` | هم گونیکورن (روی `HEAD` استاتیک) | با `daphne` خودبه‌خود می‌رود |
| `no such table: accounts_user` | مایگریشن اجرا نشده **و/یا** دیتابیس SQLite داخل کانتینر که با هر دیپلوی پاک می‌شود | یک PostgreSQL لینک کنید (`DATABASE_URL`). `deploy_check` می‌نویسد `database: sqlite3` یا `postgresql` |
| خط `deploy_check:` در لاگ نیست | entrypoint اجرا نشده، پس نه مایگریشن شده نه استاتیک ساخته شده | Start command را به `/usr/local/bin/entrypoint` برگردانید |
| `static: 0 files in /app/staticfiles` | `collectstatic` در build اجرا نشده | مسیر Dockerfile را چک کنید و **FULL BUILD** بزنید |
| `ImproperlyConfigured: Unsupported DATABASE_URL` | `DATABASE_URL` روی Redis/سرویس دیگری افتاده | متغیر را دستی روی DSN درست postgres بگذارید |

برای دیدن همین گزارش داخل کانتینر (Shell پنل):

```bash
python manage.py deploy_check          # جدول کامل: دیتابیس، مسیرها، تعداد استاتیک، Redis
python manage.py deploy_check --brief  # همان یک خط بالا
```

---

## الف) ابر وب‌لاینز

پلتفرم بر پایهٔ کانتینر است و **build خودکارش فقط Node.js را می‌شناسد**؛ برای پایتون باید صریحاً Dockerfile بدهید. برای همین یک Dockerfile آمادهٔ **فقط-دیپلوی** در ریپو هست:

```text
deploy/weblines/Dockerfile     ← همین را در ویزارد انتخاب می‌کنید
deploy/weblines/entrypoint.sh  ← نقش سرویس را با ROLE انتخاب می‌کند
```

این با تصمیم «بدون Docker در توسعه» تناقض ندارد: برای اجرای لوکال همان `python scripts/dev.py` یا `manage.py runserver` است؛ Dockerfile صرفاً قراردادِ این پلتفرم برای build است.

### ۱) پیش‌نیاز: ریپوی گیت

* اپ از **ریپوی خصوصی** هم ساخته می‌شود، ولی **Worker** فقط از **ریپوی عمومی** یا ایمیج عمومی. اگر ریپو خصوصی است:
  * یا اپ را از ریپوی خصوصی بسازید و Worker را از ایمیج ساخته‌شده،
  * یا ریپو را عمومی کنید (ساده‌ترین راه).
* برنچ: همان `main` (یا برنچی که کد نهایی روی آن است).

### ۲) دیتابیس PostgreSQL

**SERVICES → + NEW SERVICE → Database → PostgreSQL** → پک کوچک → CREATE.
سپس در کارت اپ: **+ LINK** → همان دیتابیس را تیک بزنید. پلتفرم خودش `DATABASE_URL` را تزریق می‌کند.

> `DATABASE_URL` فقط باید `postgres://` (یا `mysql://`) باشد. اپ اگر scheme ناشناخته ببیند **بوت نمی‌شود** و عمداً به SQLite برنمی‌گردد تا داده در سکوت جای اشتباه نرود.

### ۳) Redis

**+ NEW SERVICE → Database → Redis**. بعد از RUNNING شدن، آدرسِ داخلی را از کارت سرویس بردارید.

دو راه برای رساندنش به اپ:

* **لینک کردن** (اگر دیتابیس دومِ اپ باشد به‌صورت `DATABASE_URL_2` تزریق می‌شود و اپ نادیده‌اش می‌گیرد) — بعد باید خودتان `REDIS_URL` را هم ست کنید؛
* **ساده‌تر و بی‌ابهام:** در **ENV** اپ یک متغیر دستی بسازید:

```text
REDIS_URL = redis://:<رمز>@<میزبان داخلی>:6379/0
```

بعد از هر تغییرِ متغیرها، **REDEPLOY** لازم است.

### ۴) اپ (سرویس اصلی)

**SERVICES → + NEW SERVICE → Custom app** و در ویزارد:

| مرحله | مقدار |
|---|---|
| **NAME & SIZE** | مثلاً `virtualclass`، پک Nano برای شروع |
| **SOURCE** | Git Repo + آدرس ریپو + برنچ |
| **Port** | **`8000`** (باید با `EXPOSE`/`PORT` ایمیج یکی باشد) |
| **Build settings** | `Dockerfile` و مسیر: **`deploy/weblines/Dockerfile`** |
| **Link database** | PostgreSQL (بند ۲) |

> اگر پنل فیلد «Start command» / «Run command» دارد، آن را خالی بگذارید یا `/usr/local/bin/entrypoint` بنویسید؛ هر مقدار دیگری (مثل `gunicorn …`) و تمام کارِ entrypoint — مایگریشن، پورت، ASGI — را دور می‌زند. فایل `Procfile` در ریشهٔ ریپو هم همان دستور درست را برای پلتفرم‌هایی دارد که Procfile می‌خوانند.

سپس **CREATE & DEPLOY**. build حدوداً چند دقیقه است (اگر `INSTALL_LIBREOFFICE=1` بخواهید، بیشتر).

**بعد از ساخت، سه کار:**

1. **Storage → ADD VOLUME** با مسیر **`/data`** (برای فایل‌های آپلودی) و بعد **DEPLOY**.
2. **ENV** — حداقل این‌ها (فهرست کامل در `.env.production.example`):

```text
SECRET_KEY=<رشتهٔ تصادفی — پنل خودش هم می‌سازد>
DEBUG=false
ALLOWED_HOSTS=<زیردامنه‌ای که پنل داد>,<دامنهٔ خودتان>
CSRF_TRUSTED_ORIGINS=https://<همان زیردامنه>,https://<دامنهٔ خودتان>
TRUST_X_FORWARDED_PROTO=true
REDIS_URL=redis://…            (بند ۳)
MEDIA_ROOT=/data/media
PRIVATE_MEDIA_ROOT=/data/private_media
TIME_ZONE=Asia/Tehran
```

> زیردامنه را از کارت اپ (**آدرس**) بردارید؛ `ALLOWED_HOSTS` **بدون** `https://` نوشته می‌شود و در `CSRF_TRUSTED_ORIGINS` **با** `https://`.

3. یک **superuser** بسازید: از work card → **Shell** → `python manage.py createsuperuser`.
   (مایگریشن‌ها خودکار در `entrypoint.sh` قبل از بالا آمدن وب اجرا می‌شوند.)

### ۵) Worker (Celery) و زمان‌بند

**SERVICES → + NEW SERVICE → Worker** (حالت ساده) و:

* منبع: **همان ریپوی عمومی** + همان Dockerfile (`deploy/weblines/Dockerfile`)،
* همان متغیرهای محیطی (`SECRET_KEY`, `DEBUG`, `DATABASE_URL`, `REDIS_URL`, `MEDIA_ROOT`, `PRIVATE_MEDIA_ROOT` …) **به‌علاوه**:

```text
ROLE=worker
CELERY_CONCURRENCY=2
```

برای زمان‌بند دو انتخاب دارید:

| راه | هزینه | چطور |
|---|---|---|
| **کرون‌جاب پلتفرم** (توصیه) | رایگان‌تر | یک Cron Job بسازید که روزی یک‌بار `python manage.py housekeeping` را در همان اپ اجرا کند |
| **Worker دوم با `ROLE=beat`** | یک کانتینر همیشه‌روشن | Worker دیگر با `ROLE=beat` — فقط **یکی**، وگرنه کارها دو بار اجرا می‌شوند |

`manage.py housekeeping` همان سه کار beat را انجام می‌دهد (بستن جلسهٔ رهاشده، پاک‌سازی مهمان‌های قدیمی، `prune_history`) و پنجره‌هایش از همان متغیرها می‌آید.

### ۶) دامنه و SSL

**دامنه** → دامنهٔ اختصاصی را وصل کنید (رکورد `CNAME`/`A` از پنل)، گواهی خودکار گرفته می‌شود. بعد:

* `ALLOWED_HOSTS` و `CSRF_TRUSTED_ORIGINS` را با دامنهٔ نهایی به‌روز کنید،
* **DEPLOY**.

### ۷) چک‌لیست بعد از دیپلوی

```bash
BASE=https://<آدرس-اپ>

curl -s -o /dev/null -w "home %{http_code}\n"   $BASE/
curl -s -o /dev/null -w "login %{http_code}\n"  $BASE/accounts/login/
curl -s -o /dev/null -w "static %{http_code}\n" $BASE/static/css/main.css
curl -sI $BASE/static/css/main.css | grep -i content-type   # باید text/css باشد

# WebSocket — 101 یعنی سوکت باز شد، 403 هم یعنی «رسید ولی عضو نیستی»
curl -si -o /dev/null -w "ws %{http_code}\n" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==" \
  "$BASE/ws/classroom/<کد-اتاق>/"
```

> اگر پاسخ `101` نبود ولی صفحه بالا می‌آید، لاگ را ببینید: `ws_origin_rejected` یعنی سوکت رسیده اما Origin پذیرفته نشده (بخش ۰.۱ و جدول عیب‌یابی)، و `Not Found: /ws/…` یعنی پروسه WSGI است.
>
> تفسیر کد وب‌سوکت: **101** = اتصال کامل. **403** = دست‌دادن انجام شد و به کانزومر رسید ولی چون کوکی/عضویت ندارید رد شد (طبیعی برای `curl`). **200 / 302 / 404 / 502** = درخواست هرگز به کانزومر نرسیده ← پروکسی/پورت مشکل دارد.

و در مرورگر: ورود، ساخت کلاس، باز کردن اتاق در دو تب/دو مرورگر (چت + تخته)، و آپلود یک فایل.

---

## ب) سرور مجازی (VPS)

فرض: Ubuntu 22.04/24.04، دامنه‌ای که به IP سرور اشاره می‌کند، دسترسی `sudo`.

### ۱) بسته‌های پایه

```bash
sudo apt update
sudo apt install -y python3-venv python3-pip nginx redis-server git \
                    libreoffice-impress libreoffice-writer   # LibreOffice اختیاری است
sudo systemctl enable --now redis-server
```

### ۲) کاربر و کد

```bash
sudo adduser --system --group --home /srv/virtualclass virtualclass
sudo -u virtualclass git clone <repo-url> /srv/virtualclass
cd /srv/virtualclass
sudo -u virtualclass python3 -m venv .venv
sudo -u virtualclass .venv/bin/pip install -r requirements.txt
```

### ۳) تنظیمات

```bash
sudo -u virtualclass cp .env.production.example .env
sudo -u virtualclass .venv/bin/python -c \
  "from django.core.management.utils import get_random_secret_key as k; print(k())"   # → SECRET_KEY
sudo -u virtualclass nano .env
```

مقادیر لازم: `SECRET_KEY`, `DEBUG=false`, `ALLOWED_HOSTS=class.example.com`, `CSRF_TRUSTED_ORIGINS=https://class.example.com`, `DATABASE_URL` (PostgreSQL)، `REDIS_URL=redis://127.0.0.1:6379/0`, `TRUST_X_FORWARDED_PROTO=true`.

```bash
# پوشه‌های داده + مایگریشن + استاتیک + سوپریوزر
sudo -u virtualclass .venv/bin/python manage.py migrate --noinput
sudo -u virtualclass .venv/bin/python manage.py collectstatic --noinput
sudo -u virtualclass .venv/bin/python manage.py createsuperuser
```

### ۴) سه سرویس systemd

نمونه‌ها در `deploy/systemd/` هستند (`virtualclass-web`, `virtualclass-worker`, `virtualclass-beat`). مسیرها و کاربر را در آن‌ها با سرور خودتان هم‌خوان کنید، بعد:

```bash
sudo cp deploy/systemd/virtualclass-{web,worker,beat}.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now virtualclass-web virtualclass-worker virtualclass-beat
systemctl status virtualclass-web --no-pager
```

### ۵) nginx + SSL

```bash
sudo cp deploy/nginx/virtualclass.conf /etc/nginx/sites-available/virtualclass
sudo ln -s /etc/nginx/sites-available/virtualclass /etc/nginx/sites-enabled/
sudo nano /etc/nginx/sites-available/virtualclass     # دامنه و مسیرها
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d class.example.com
```

نکات آن فایل: `client_max_body_size 32m` (برای آپلود ۲۵ مگابایتی)، هدرهای `Upgrade` برای `/ws/`، و **هرگز** نگاشت `PRIVATE_MEDIA_ROOT` در nginx (فایل‌های کلاس باید از مسیر مجوزدار جنگو بروند).

### ۶) به‌روزرسانی

```bash
cd /srv/virtualclass
sudo -u virtualclass git pull
sudo -u virtualclass .venv/bin/pip install -r requirements.txt
sudo -u virtualclass .venv/bin/python manage.py migrate --noinput
sudo -u virtualclass .venv/bin/python manage.py collectstatic --noinput
sudo systemctl restart virtualclass-web virtualclass-worker virtualclass-beat
```

---

## ۳) استاتیک‌ها — چرا و چطور

سه چیز باید هم‌زمان درست باشند:

1. **`DEBUG=false`** ⇒ جنگو دیگر استاتیک سرو نمی‌کند (این عمدی است: سرو کردن فایل با پایتون در dev است، نه در تولید).
2. **`collectstatic`** ⇒ همهٔ فایل‌های `static/` (و استاتیک اپ‌های نصب‌شده) در `STATIC_ROOT` کپی می‌شوند. در این پروژه:
   * در ایمیج: داخل `deploy/weblines/Dockerfile` در **زمان build** انجام می‌شود،
   * روی VPS: بعد از هر deploy دستی اجرا کنید.
3. **سرو کردن** ⇒ **WhiteNoise** (در `MIDDLEWARE`، بعد از `SecurityMiddleware`) فایل‌ها را از `STATIC_ROOT` با gzip/brotli و هدر کش سرو می‌کند — بدون nginx. اگر nginx دارید، می‌توانید `location /static/` را هم اضافه کنید (سریع‌تر است، ولی اجباری نیست).

بررسی سریع:

```bash
ls staticfiles/css/main.css            # باید وجود داشته باشد
curl -I https://class.example.com/static/css/main.css   # 200 + Content-Type: text/css
```

اگر ۴۰۴ گرفتید:

| علت | نشانه | راه |
|---|---|---|
| `collectstatic` اجرا نشده | `staticfiles/` خالی یا نبودِ فایل | `python manage.py collectstatic --noinput` |
| `STATIC_ROOT` جای عجیب | فایل‌ها آنجا هستند ولی اپ جای دیگری می‌گردد | `STATIC_ROOT` را یکسان کنید (Dockerfile/VPS/ENV) |
| volume روی `staticfiles` مانت شده | پوشه خالی و کدِ collect در image | volume را از `staticfiles` بردارید؛ فقط `media`/`private_media` باید volume باشند |
| `DEBUG=true` در سرور | صفحه استایل ندارد ولی `/static/...` هم ۲۰۰ نیست | `DEBUG=false` + `collectstatic` |

> **مدیای عمومی** (لوگوی کلاس) روی `/media/classroom_logos/…` سرو می‌شود و در همهٔ محیط‌ها کار می‌کند: ویوی `core/views.py::public_media` فقط همین زیرشاخه را می‌دهد (هر مسیر دیگری ۴۰۴ است). روی VPS می‌توانید `location /media/` را در nginx نگاشت کنید تا از پایتون سریع‌تر باشد — اختیاری است.
>
> **مدیای خصوصی** (`PRIVATE_MEDIA_ROOT`: فایل‌های کلاس، PDF ارائه، پاسخ تکالیف) **هرگز** از `/media/` و هرگز از nginx سرو نمی‌شود؛ فقط از ویوهای مجوزدار جنگو. در nginx عمداً هیچ `location` برایش نیست.

---

## ۴) عیب‌یابی

| علامت | علت محتمل | کار |
|---|---|---|
| صفحهٔ سفید / `502` | پورت اپ با پورت پنل یکی نیست، یا پروسه بالا نیامده | لاگ کانتینر را ببینید؛ `Port=8000` و `daphne -p 8000` را هم‌خوان کنید |
| لاگ `gunicorn` نشان می‌دهد (نه `daphne`) | پلتفرم `CMD` ایمیج را نادیده گرفته | بخش ۰.۱ — Start command را `/usr/local/bin/entrypoint` کنید |
| `DisallowedHost` | دامنه در `ALLOWED_HOSTS` نیست | دامنهٔ دقیق را اضافه و redeploy کنید |
| هر POST → `403 CSRF` | پروکسی HTTPS را تمام می‌کند ولی اپ آن را نمی‌داند | `TRUST_X_FORWARDED_PROTO=true` و `CSRF_TRUSTED_ORIGINS=https://دامنه` |
| چت/تخته وصل نمی‌شود، بقیه کار می‌کند | WebSocket در لبهٔ شبکه پشتیبانی/آپگرید نمی‌شود | تست `curl` بخش ۷؛ اگر ۱۰۱ نشد، پلتفرم WS را پشتیبانی نمی‌کند → VPS |
| در لاگ `ws_origin_rejected room=… origin=… compared_with=…` | دست‌دادن سوکت انجام شد ولی `Origin` مرورگر با هاستی که سرور می‌بیند جور نیست — معمولاً چون TLS در پروکسی تمام می‌شود (مرورگر `https`، سوکت `ws`) یا پروکسی `Host` را بازنویسی می‌کند | کد فعلی **scheme را مقایسه نمی‌کند** و فقط هاست/پورت مهم است؛ اگر باز هم رد شد: همان دامنه را در `ALLOWED_HOSTS` و `CSRF_TRUSTED_ORIGINS=https://…` بگذارید و `TRUST_X_FORWARDED_PROTO=true` را روشن کنید (تا `X-Forwarded-Host/Proto` معتبر شمرده شوند) |
| ورود می‌شود ولی کاربر بعد از رفرش خارج است | چند پروسه بدون Redis | `REDIS_URL` را ست کنید (channel layer مشترک) |
| آپلودها بعد از هر دیپلوی گم می‌شوند | کانتینر بی‌حالت است | volume روی `/data` + `MEDIA_ROOT=/data/media` |
| `no such table: …` | مایگریشن اجرا نشده یا دیتابیس SQLite موقتِ کانتینر | `DATABASE_URL` را لینک کنید؛ بعد `python manage.py migrate` (در ایمیج خودکار است). `deploy_check` موتور دیتابیس را نشان می‌دهد |
| تبدیل Office کار نمی‌کند | LibreOffice نصب نیست | `INSTALL_LIBREOFFICE=1` (build مجدد) یا نصب بستهٔ سیستمی |
| `ImproperlyConfigured: Unsupported DATABASE_URL` | `DATABASE_URL` روی Redis/MySQL ناشناخته افتاده | همان متغیر را با DSN درست postgres پر کنید |
| صف کار نمی‌کند ولی اپ بالا است | Worker خاموش است یا `REDIS_URL` متفاوت | لاگ Worker؛ همان `REDIS_URL` در هر سه سرویس |

### بررسی سلامت تنظیمات قبل از تحویل

```bash
DEBUG=false SECRET_KEY=<کلید واقعی> ALLOWED_HOSTS=… CSRF_TRUSTED_ORIGINS=… \
  python manage.py check --deploy
```

خروجی سالم: فقط دو هشدار. `deploy.W002` (بدون `REDIS_URL`) که در یک نصب تک‌پروسه پذیرفتنی است، و `security.W021` (`SECURE_HSTS_PRELOAD`) که **عمداً** روشن نشده — ثبت در preload list کاری یک‌طرفه است و باید آگاهانه انجام شود.

دو تنظیم امنیتی که در حالت `DEBUG=false` خودکار روشن می‌شوند و ممکن است در تست اول غافلگیرتان کنند:

| تنظیم | پیش‌فرض | چه می‌کند |
|---|---|---|
| `SECURE_SSL_REDIRECT` | `true` | هر درخواست HTTP را با ۳۰۱ به HTTPS می‌فرستد. اگر پشت TLS نیستید (یا health check پلتفرم ۳۰۱ را «سالم» نمی‌داند) با `SECURE_SSL_REDIRECT=false` خاموشش کنید |
| `SECURE_HSTS_SECONDS` | ۳۰ روز + زیردامنه‌ها | مرورگر را مجبور به HTTPS می‌کند. تا وقتی HTTPS یک بار برای مرورگر تست نشده، HSTS روی همان مرورگر می‌ماند؛ برای آزمایش با IP، `DEBUG=false` + HTTPS نگیرید |

---

## ۵) پشتیبان‌گیری

* **دیتابیس:** بکاپ خودکار پلتفرم (اگر دارد) یا `pg_dump` روزانه.
* **فایل‌ها:** `media/` و `private_media/` (روی volume یا `rsync` از سرور).
* **تنظیمات:** `.env` را جای امن نگه دارید (در گیت نیست).
* **نگهداری دوره‌ای:** `python manage.py housekeeping` (یا `prune_history --dry-run` برای گزارش بدون تغییر).
