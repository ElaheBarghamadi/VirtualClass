# کلاس آنلاین (Online Classroom)

یک پلتفرم کلاس درس آنلاین مبتنی بر **Django** با معماری ماژولار و آمادهٔ گسترش — شامل احراز هویت کامل، ساخت کلاس با لینک یکتا و رمز عبور اختیاری، لابی ورود، صفحه کلاس به سبک اپلیکیشن‌های جلسهٔ مدرن، فهرست شرکت‌کنندگان با نقش‌ها، گفتگوی زنده با WebSocket و زیربنای تخته سفید.

رابط کاربری **فارسی و راست‌به‌چپ (RTL)** است و با فونت **وزیرمتن** نمایش داده می‌شود.

---

## ۱. امکانات فاز فعلی

- ثبت‌نام / ورود / خروج / داشبورد / ویرایش پروفایل (بر پایهٔ سیستم احراز هویت خود Django)
- ساخت کلاس با عنوان، توضیحات و **محافظت اختیاری با رمز عبور** (رمز به‌صورت هش‌شده ذخیره می‌شود)
- **لینک یکتا و امن** برای هر کلاس با کد تصادفی غیرقابل حدس (مثلاً `/class/a8K29xP7mQ2/`) + دکمهٔ «کپی لینک»
- **لابی کلاس**: نمایش عنوان، معلم، تعداد شرکت‌کنندگان و دریافت رمز در صورت نیاز
- **عضویت و نقش‌ها**: OWNER / MODERATOR / PRESENTER / STUDENT (مالک به‌صورت خودکار OWNER می‌شود)
- **معماری سطح دسترسی جزئی** (میکروفون، دوربین، اشتراک صفحه، تخته، پیام، فایل، بالا بردن دست) با پیش‌فرض نقش‌محور و اعتبارسنجی **سمت سرور**
- **Django Channels**: رویدادهای زندهٔ `user_joined` و `user_left` روی `/ws/classroom/<room_code>/`
- **گفتگوی زنده** با ذخیره در دیتابیس روی `/ws/classroom/<room_code>/chat/`
- **تخته سفید** (Canvas) با ابزار قلم/پاک‌کن/متن/Undo/Redo/Clear — همگام‌سازی بین کاربران در فاز بعد
- **REST API** پایه: `/api/auth/`، `/api/classrooms/`، `/api/classrooms/<room_code>/`، `/api/classrooms/<room_code>/participants/`
- **پنل ادمین** برای کاربران، کلاس‌ها، اعضا و پیام‌ها (ویژهٔ مدیران سامانه)

### آنچه عمداً در این فاز پیاده‌سازی نشده (اما معماری‌اش آماده است)

WebRTC کامل (صوت/تصویر/اشتراک صفحه)، ضبط جلسه، Breakout Room، همگام‌سازی تخته سفید، اشتراک فایل، نظرسنجی/کوییز، اعلان‌ها و پرداخت.

---

## ۲. معماری

```
مرورگر (Django Templates + Vanilla JS)
   │
   ├── HTTP ──► Django (WSGI/ASGI) ──► ویوها ──► services.py (منطق کسب‌وکار) ──► دیتابیس
   │
   └── WebSocket ──► Channels (AuthMiddlewareStack)
                        ├── /ws/classroom/<code>/       → ClassroomConsumer (حضور: join/leave)
                        └── /ws/classroom/<code>/chat/  → ChatConsumer (گفتگو + ذخیره در DB)
                                     │
                                     ▼
                          Channel Layer (Redis در پروداکشن /
                          InMemory در توسعهٔ تک‌پروسه)
```

اصول کلیدی:

- **منطق کسب‌وکار در `classrooms/services.py`** — ویوهای HTTP و کانکیومرهای WebSocket دقیقاً از یک قواعد استفاده می‌کنند.
- **سیستم سطح دسترسی مرکزی در `classrooms/permissions.py`** — پیش‌فرض هر نقش در یک ماتریس واحد تعریف شده؛ افزودن قابلیت جدید یعنی افزودن یک فیلد به `ClassroomMember` و یک مقدار پیش‌فرض در همان ماتریس. هیچ مجوزی در ویوها/کانکیومرها hard-code نشده است.
- **هیچ مجوزی به کلاینت اعتماد نمی‌شود**: صفحهٔ کلاس فقط «مجوزهای مؤثر خود کاربر» را دریافت می‌کند و هر تصمیم مهم (عضویت، ارسال پیام، اتصال WebSocket) سمت سرور بررسی می‌شود. تغییر JavaScript در مرورگر هیچ دسترسی اضافه‌ای ایجاد نمی‌کند.
- **رسانه (صوت/تصویر) هرگز از WebSocket عبور نمی‌کند** — در فاز بعد با WebRTC (نقطه‌به‌نقطه) منتقل می‌شود و Django فقط نقش **signaling** و مدیریت دسترسی را دارد (زیربنای آن در `static/js/webrtc.js`).

---

## ۳. نصب و راه‌اندازی

پیش‌نیاز: **Python 3.11+**

### ساخت محیط مجازی و نصب وابستگی‌ها

```bash
python -m venv .venv

# Windows
.venv\Scripts\activate

# Linux/macOS
source .venv/bin/activate

pip install -r requirements.txt
```

### متغیرهای محیطی

```bash
cp .env.example .env
```

| متغیر | توضیح |
|---|---|
| `SECRET_KEY` | کلید مخفی Django (در پروداکشن حتماً مقدار تصادفی بگذارید) |
| `DEBUG` | در توسعه `true`، در پروداکشن `false` |
| `DATABASE_URL` | خالی = SQLite؛ در پروداکشن مثلاً `postgres://user:pass@localhost:5432/dbname` |
| `REDIS_URL` | خالی = لایهٔ کانال InMemory؛ در پروداکشن مثلاً `redis://127.0.0.1:6379/0` |
| `ALLOWED_HOSTS` | لیست هاست‌های مجاز با کاما |

### مایگریشن و ساخت کاربر مدیر

```bash
python manage.py migrate
python manage.py createsuperuser
```

### اجرای سرور توسعه

```bash
python manage.py runserver
```

سرور توسعه به‌کمک **Daphne** هم HTTP و هم WebSocket را سرو می‌کند. سپس آدرس‌های زیر را باز کنید:

- خانه: `http://127.0.0.1:8000/`
- پنل ادمین: `http://127.0.0.1:8000/admin/`
- API: `http://127.0.0.1:8000/api/classrooms/`

### اجرای Redis (برای محیط واقعی/چندپروسه)

در حالت توسعه بدون Redis هم WebSocket کار می‌کند (لایهٔ InMemory، فقط تک‌پروسه). برای محیط واقعی:

```bash
# Docker
docker run -d -p 6379:6379 --name classroom-redis redis:7

# یا مستقیم (Linux)
redis-server
```

و در `.env` قرار دهید:

```
REDIS_URL=redis://127.0.0.1:6379/0
```

اجرای پروداکشن (نمونه):

```bash
daphne -b 0.0.0.0 -p 8000 config.asgi:application
```

### اجرای تست‌ها

```bash
python manage.py test
```

پوشش تست‌ها: جریان ثبت‌نام/ورود، ساخت کلاس، یکتایی کد اتاق، هش بودن رمز کلاس، لابی و رمز اشتباه، کنترل دسترسی صفحهٔ کلاس، API، و **کانکیومرهای WebSocket** (حضور، گفتگو، رد کردن غیرعضو/کاربر ناشناس).

---

## ۴. معماری WebSocket

| اندپوینت | کانکیومر | وظیفه |
|---|---|---|
| `/ws/classroom/<room_code>/` | `classrooms.consumers.ClassroomConsumer` | چرخهٔ اتصال، ارسال فهرست شرکت‌کنندگان، broadcast رویدادهای `user_joined` / `user_left`؛ در آینده relay سیگنالینگ WebRTC |
| `/ws/classroom/<room_code>/chat/` | `chat.consumers.ChatConsumer` | گفتگوی زنده + ارسال تاریخچه + ذخیرهٔ پیام در `ChatMessage` |

اعتبارسنجی اتصال: کاربر باید **احراز هویت شده** و **عضو فعال** آن کلاس باشد (وگرنه اتصال با کد ۴۴۰۱/۴۴۰۳ بسته می‌شود). ارسال پیام مشروط به مجوز `can_send_messages` عضو است.

---

## ۵. ساختار پروژه

```
online_classroom/
├── manage.py
├── config/                 # تنظیمات، URLها، ASGI/WSGI
│   ├── settings.py
│   ├── urls.py
│   ├── asgi.py             # مسیریابی WebSocket (Channels)
│   └── wsgi.py
├── accounts/               # کاربر سفارشی، ثبت‌نام، ورود، پروفایل
├── classrooms/             # کلاس، عضویت، نقش‌ها، سطح دسترسی
│   ├── models.py           # Classroom + ClassroomMember
│   ├── permissions.py      # ماتریس نقش → مجوزها (منبع واحد حقیقت)
│   ├── services.py         # منطق کسب‌وکار (create/join/leave/…)
│   ├── consumers.py        # کانکیومر حضور
│   ├── api.py              # REST API
│   └── views.py / forms.py / urls*.py
├── chat/                   # ChatMessage + کانکیومر گفتگو
├── core/                   # صفحات عمومی، API URLها، templatetags
├── static/
│   ├── css/                # main.css + room.css (طراحی RTL مدرن)
│   └── js/                 # room.js / chat.js / whiteboard.js / webrtc.js / app.js
├── templates/              # base.html، home.html
├── requirements.txt
├── .env.example
└── README.md
```

### آدرس‌های اصلی

```
/                                    خانه
/accounts/register|login|logout|profile
/dashboard/                          داشبورد کاربر
/classrooms/                         کلاس‌های من
/classrooms/create/                  ایجاد کلاس
/class/<room_code>/                  لینک عمومی → لابی
/class/<room_code>/lobby/            لابی (دریافت رمز در صورت نیاز)
/class/<room_code>/room/             صفحه کلاس
/api/auth/register|login             احراز هویت API (توکن)
/api/classrooms/                     لیست/ایجاد کلاس
/api/classrooms/<room_code>/         جزئیات کلاس
/api/classrooms/<room_code>/participants/   شرکت‌کنندگان
```

---

## ۶. ویژگی‌های برنامه‌ریزی‌شدهٔ فازهای بعد

1. **WebRTC**: پیش‌نمایش دوربین/میکروفون، چندشرکت‌کننده، Mute، انتخاب دستگاه — با signaling روی همان WebSocket کلاس (زیربنای کلاینت: `static/js/webrtc.js`)
2. اشتراک صفحه و مدیریت وضعیت‌های زندهٔ شرکت‌کنندگان (میکروفون/دوربین/دست بالا)
3. همگام‌سازی تخته سفید بین کاربران (مدل stroke فعلی از حالا serializable است)
4. پنل مدیریت عضویت برای مالک: تغییر نقش و مجوزهای هر شرکت‌کننده (فیلدهای دیتابیس آماده است)
5. ضبط جلسه، Breakout Room، اشتراک فایل، کوییز/نظرسنجی و اعلان‌ها

## ۷. نکات امنیتی پیاده‌سازی‌شده

- CSRF روی همهٔ فرم‌ها؛ هش شدن رمز کاربران و **رمز کلاس‌ها** (`make_password` / `check_password`)
- کد اتاق تصادفی با `secrets` (غیرقابل حدس، غیرترتیبی)
- کنترل دسترسی سمت سرور در ویوها، کانکیومرهای WebSocket و API
- عدم افشای اطلاعات حساس (هش رمز هرگز در HTML/JSON ارسال نمی‌شود)
- تنظیمات امنیتی خودکار در حالت غیردیباگ (HSTS، Secure Cookie، SSL Redirect)
