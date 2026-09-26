# استقرار روی PythonAnywhere — راهنمای گام‌به‌گام

این راهنما پروژه را از صفر روی یک اکانت PythonAnywhere بالا می‌آورد.
همهٔ مراحل در **Bash console** و **تب Web** داشبورد انجام می‌شود.

> ⚠️ **مهم‌ترین نکته — WebSocket:** سرویس وب PythonAnywhere فقط **WSGI**
> ارائه می‌دهد و از ASGI/WebSocket پشتیبانی **نمی‌کند**. یعنی روی این
> هاست، قابلیت‌های *زمان‌واقعی* (گفتگوی زنده، فهرست شرکت‌کنندگان زنده،
> تختهٔ سفید هم‌زمان، سینک ارائه و سیگنال‌دهی صدا/تصویر) کار نمی‌کنند.
> آنچه کامل کار می‌کند: ثبت‌نام/ورود، داشبورد، ساخت و مدیریت کلاس،
> پیوستن از طریق لینک، **بارگذاری و دانلود فایل**، جلسات و حضوروغیاب.
> برای تجربهٔ کامل (چت/تخته/صدا/تصویر) به میزبانی با ASGI نیاز دارید
> (Render، Fly.io، یا یک VPS با Daphne/Uvicorn + Redis) — پروژه برای
> هر دو حالت آماده است و کد تغییری نمی‌خواهد.

---

## ۱) ساخت اپلیکیشن وب

1. در داشبورد: **Web → Add a new web app**
2. **Manual configuration** را انتخاب کنید (نه wizard جنگو)
3. نسخهٔ پایتون: **3.11 یا بالاتر**

## ۲) آپلود کد

در یک **Bash console**:

```bash
cd ~
git clone https://github.com/ElaheBarghamadi/VirtualClass.git
cd VirtualClass
```

(اگر ریپوی شما private است: `git clone https://USERNAME:TOKEN@github.com/...`)

## ۳) محیط مجازی و وابستگی‌ها

```bash
cd ~/VirtualClass
python3.11 -m venv .venv          # نسخه باید با تب Web یکی باشد
source .venv/bin/activate
pip install -r requirements.txt
pip install mysqlclient           # فقط اگر از MySQL استفاده می‌کنید
```

## ۴) فایل `.env`

```bash
cp .env.example .env
nano .env        # یا vim
```

مقادیر لازم برای PythonAnywhere:

```ini
SECRET_KEY=<یک رشتهٔ تصادفی بلند — دستور پایین>
DEBUG=false
ALLOWED_HOSTS=USERNAME.pythonanywhere.com
CSRF_TRUSTED_ORIGINS=https://USERNAME.pythonanywhere.com

# دیتابیس MySQL (ساخت در مرحلهٔ ۵) — یا خالی بگذارید تا SQLite استفاده شود
DATABASE_URL=mysql://USERNAME:DBPASSWORD@USERNAME.mysql.pythonanywhere-services.com/USERNAME$default
```

تولید کلید مخفی:

```bash
python -c "from django.core.management.utils import get_random_secret_key; print(get_random_secret_key())"
```

> اگر `DEBUG=false` باشد و `SECRET_KEY` را نگذارید، پروژه **عمداً بالا
> نمی‌آید** و خطای راهنما می‌دهد — این محافظت عمدی است.

## ۵) دیتابیس MySQL (توصیه‌شده؛ SQLite هم کار می‌کند)

1. داشبورد → **Databases → Create a database** → مثلاً `default`
2. نام کامل دیتابیس `USERNAME$default` است؛ رمز را هم همان‌جا می‌سازید
3. همان `DATABASE_URL` مرحلهٔ ۴ را پر کنید

> برای شروع سریع می‌توانید `DATABASE_URL` را خالی بگذارید (SQLite).
> برای چند کاربر هم‌زمان، MySQL انتخاب بهتری است.

## ۶) مایگریشن و جمع‌آوری استاتیک‌ها

```bash
cd ~/VirtualClass
source .venv/bin/activate
python manage.py migrate
python manage.py collectstatic --no-input
# اختیاری — فقط برای دسترسی به Django Admin:
# python manage.py createsuperuser
```

## ۷) تنظیم تب Web

در **Web → your app**:

| فیلد | مقدار |
|---|---|
| Source code | `/home/USERNAME/VirtualClass` |
| Working directory | `/home/USERNAME/VirtualClass` |
| Virtualenv | `/home/USERNAME/VirtualClass/.venv` |

**Static files** (دو ردیف اضافه کنید):

| URL | Directory |
|---|---|
| `/static/` | `/home/USERNAME/VirtualClass/staticfiles` |
| `/media/` | `/home/USERNAME/VirtualClass/media` |

> ردیف `/media/` برای دانلود فایل‌های اشتراکی کلاس‌ها ضروری است.

**WSGI configuration file:** کل محتوای فایل را با
`deploy/pythonanywhere_wsgi.py` از همین ریپو جایگزین کنید و در دو خط
اول آن `YOUR_USERNAME` و `PYTHON_VERSION` را اصلاح کنید.

در انتها دکمهٔ سبز **Reload** را بزنید.

## ۸) بررسی

- `https://USERNAME.pythonanywhere.com/` → صفحهٔ خانه
- ثبت‌نام → داشبورد → ساخت کلاس → آپلود/دانلود فایل

## ۹) به‌روزرسانی بعد از هر `git push`

```bash
cd ~/VirtualClass
git pull
source .venv/bin/activate
pip install -r requirements.txt      # اگر وابستگی جدیدی آمده بود
python manage.py migrate             # اگر مهاجرت جدیدی بود
python manage.py collectstatic --no-input
```

سپس در تب Web دکمهٔ **Reload** را بزنید.

## عیب‌یابی

| علامت | علت و راه‌حل |
|---|---|
| صفحهٔ خطای 500 و `ImproperlyConfigured: SECRET_KEY` | در `.env` کلید واقعی نگذاشته‌اید |
| استایل/JS بارگذاری نمی‌شود | نگاشت `/static/` در تب Web یا `collectstatic` انجام نشده |
| دانلود فایل 404 می‌دهد | نگاشت `/media/` را در تب Web اضافه نکرده‌اید |
| `ModuleNotFoundError` در error log | مسیر Virtualenv در تب Web اشتباه است یا `pip install` در venv درست انجام نشده |
| چت/تخته/صدا کار نمی‌کند | محدودیت WebSocket خود PythonAnywhere است (بالای همین صفحه توضیح داده شد) |
| خطای `DisallowedHost` | دامنه را به `ALLOWED_HOSTS` در `.env` اضافه کنید و Reload بزنید |
