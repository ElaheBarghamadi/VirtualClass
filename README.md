# کلاس آنلاین (Online Classroom)

پلتفرم کامل کلاس درس آنلاین مبتنی بر **Django** با معماری ماژولار و آمادهٔ پروداکشن. شامل ویدیو/صدای زنده (WebRTC + SFU)، اشتراک صفحه، تخته سفید هم‌زمان، گفتگوی زنده، اشتراک فایل، ارائه، مدیریت شرکت‌کنندگان با نقش و سطح دسترسی جزئی، اتاق انتظار، قفل کلاس، جلسات و گزارش حضور.

رابط کاربری **فارسی و راست‌به‌چپ (RTL)** با فونت **وزیرمتن**، ریسپانسیو روی دسکتاپ/لپ‌تاپ/تبلت/موبایل، و با پشتیبانی از کیبورد، `aria-label` و وضعیت فوکوس.

---

## ۱. امکانات

**رسانهٔ زنده**
- دوربین: روشن/خاموش، سوییچ دوربین، پیش‌نمایش در لابی
- میکروفون: mute/unmute، انتخاب دستگاه، تست میکروفون (نمایشگر سطح صدا در لابی)
- خروجی صدا: انتخاب اسپیکر در مرورگرهای پشتیبانی‌کننده
- اشتراک صفحه: کل صفحه / پنجره / تب، با نشانگر روشن «چه کسی در حال اشتراک است»
- گرید ویدیوی ریسپانسیو (۱، ۲، ۳، ۴، ۶، ۹ نفر)، تشخیص **سخن‌گویندهٔ فعال**، **پین کردن** شرکت‌کننده، فوکوس روی اشتراک صفحه

**مدیریت کلاس**
- نقش‌ها: OWNER / MODERATOR / PRESENTER / STUDENT / GUEST — مالک نقش‌ها را اعطا/لغو می‌کند
- سطح دسترسی جزئی: `can_use_microphone`, `can_use_camera`, `can_share_screen`, `can_use_whiteboard`, `can_send_messages`, `can_upload_files`, `can_raise_hand`, `can_present`
- پنل میزبان برای هر شرکت‌کننده: بی‌صدا کردن، درخواست روشن کردن میکروفون، تغییر نقش/دسترسی، حذف از کلاس (با ممنوعیت موقت)
- «بی‌صدا کردن همه» و «بی‌صدا کردن همه جز من»
- بالا بردن دست: فهرست مرتب‌شده، نشانگر کنار شرکت‌کننده، شمارندهٔ دست‌های بالا
- جستجو و فیلتر شرکت‌کنندگان (همه / دست بالا / بی‌صدا / نقش)
- اتاق انتظار با تأیید/رد توسط میزبان
- قفل کلاس (ورود اعضای جدید مسدود، اعضا متصل می‌مانند)
- پنل تنظیمات کلاس (ذخیره در دیتابیس)

**ورود مهمان (بدون حساب کاربری)**
- لینک کلاس برای همه کار می‌کند: لابی → نام نمایشی (+رمز در صورت نیاز) → بررسی دستگاه‌ها → ورود
- شناسهٔ امن و تصادفی برای هر مهمان (`secrets.token_urlsafe`)، نام یکتا در هر کلاس («Ali»، «Ali (2)»)
- اعتبارسنجی نام: trim، حداقل/حداکثر طول، حذف کاراکترهای markup، نمایش escape‌شده
- مهمان دقیقاً با همان سیستم مجوزها (`can_*`) مدیریت می‌شود؛ هیچ bypass وجود ندارد
- مالک می‌تواند ورود مهمان را per-classroom غیرفعال کند؛ صفحهٔ اختصاصی برای کلاس‌های بدون مهمان
- دسترسی مهمان به session خودش محدود است: داشبورد/پروفایل/کنترل میزبان/کلاس دیگر در دسترس نیست

**تجربهٔ کاربری یکپارچه (Phase 3)**
- **سیستم طراحی**: همهٔ رنگ‌ها/فاصله‌ها/سایه‌ها از `tokens.css` (CSS variables) — بدون رنگ hard-code پراکنده
- **پوسته**: روشن / تیره / خودکار(سیستم) — ذخیره در حساب کاربری (و کوکی برای مهمان)، کنتراست دسترسی‌پذیر، پشتیبانی `prefers-reduced-motion`
- **ترجیحات کاربر**: پوسته، تراکم رابط (راحت/فشرده)، کاهش انیمیشن، صفحهٔ فرود پس از ورود
- **شخصی‌سازی کلاس توسط مالک**: عنوان، توضیحات، لوگو، رنگ اصلی (accent)، پیام خوش‌آمدگویی، اجازهٔ مهمان، نمایش پیش‌فرض گفتگو — با broadcast زنده به افراد داخل کلاس
- **بررسی دستگاه‌ها قبل از ورود (واقعی، نه شبیه‌سازی)**: پیش‌نمایش دوربین با حالت‌های مختلف (در حال بررسی/فعال/مسدود/یافت نشد/در اختیار برنامهٔ دیگر)، تست میکروفون با **تحلیل سیگنال واقعی** (AnalyserNode)، تست بلندگو با پخش بوق و تأیید کاربر، انتخاب دوربین/میکروفون/بلندگو با `enumerateDevices` و رفرش خودکار، راهنمای فارسی برای خطای دسترسی
- **چیدمان صحنه**: شبکه / سخنران / تمرکز / ارائه — انتخاب کاربر در localStorage ذخیره می‌شود
- **منوی «بیشتر»**: تنظیمات دستگاه‌ها (تغییر بدون خروج از کلاس)، پوسته، تنظیمات کلاس (میزبان)، صفحهٔ مدیریت، کلیدهای میان‌بر، راهنما، گزارش مشکل
- **میان‌برهای صفحه‌کلید**: `M` میکروفون، `V` دوربین، `C` گفتگو، `P` شرکت‌کنندگان، `S` اشتراک صفحه — هنگام تایپ غیرفعال
- **کیفیت اتصال واقعی**: `ConnectionQualityChanged` لایوکیت (بر پایهٔ RTT/افت بسته) + RTT سیگنالینگ از ping/pong — بدون سطح کیفی جعلی
- **مودال یکپارچه** (`modal.js`): همهٔ تأییدها (خروج، حذف، پایان جلسه، قفل) با دیالوگ دسترسی‌پذیر، focus trap و بازگشت فوکوس
- **صفحات وضعیت**: کلاس پایان‌یافته (۴۱۰)، قفل‌شده، فقط-کاربری، لینک نامعتبر (۴۰۴)، دسترسی غیرمجاز (۴۰۳)
- **دسترس‌پذیری**: skip-link، فوکوس قابل مشاهده، ARIA برای دیالوگ/منو/تب‌ها، وضعیت‌ها فقط با رنگ منتقل نمی‌شوند

**محتوا**
- گفتگوی زنده با تاریخچه، زمان، هویت فرستنده، شمارندهٔ پیام خوانده‌نشده
- مدیریت گفتگو: حذف پیام توسط مدیر، قطع کامل گفتگو
- تخته سفید هم‌زمان: قلم، هایلایت، پاک‌کن، خط، فلش، مستطیل، دایره، متن، Undo/Redo/Clear، رنگ و ضخامت
- اشتراک فایل: PDF, PNG, JPG, JPEG, DOCX, PPTX, XLSX, ZIP با اعتبارسنجی سمت سرور
- ارائه: انتخاب فایل و صفحه، همگام‌سازی بین همهٔ شرکت‌کنندگان

**سازمان‌دهی**
- جدا بودن **کلاس** (دائمی) از **جلسه** (`SCHEDULED` / `LIVE` / `ENDED`)
- زمان‌بندی جلسه با نمایش در داشبورد
- گزارش حضور با پشتیبانی از چند ورود/خروج

**ارتباط**
- اعلان‌های زنده (toast): بی‌صدا شدن، حذف شدن، ارتقای نقش، درخواست روشن کردن میکروفون، قفل شدن کلاس و…
- وضعیت اتصال: متصل / در حال اتصال / در حال اتصال مجدد / قطع
- اتصال مجدد خودکار WebSocket با بازیابی کامل state — بدون نیاز به رفرش صفحه

---

## ۲. معماری

```
                     ┌──────────────────────────────────────────┐
                     │                Browser                    │
                     │  Django Templates + Vanilla JS (ESM)      │
                     └───────┬──────────────────────┬───────────┘
                             │ HTTPS                │ WebRTC (media)
                             │ WebSocket (events)   │
                             ▼                      ▼
        ┌────────────────────────────────┐   ┌─────────────────────┐
        │            Django              │   │   LiveKit SFU       │
        │                                │   │                     │
        │  HTTP views ──┐                │   │  audio / video /    │
        │  DRF API ─────┤                │   │  screen share /     │
        │  Channels ────┼─► services.py  │   │  media routing      │
        │  consumers    │   (business    │   └─────────▲───────────┘
        │               │    logic)      │             │
        │  permissions  ┘                │             │
        │  media.py ── short-lived JWT ──┼─────────────┘
        └──────┬──────────────┬──────────┘   (token scopes = permissions)
               │              │
               ▼              ▼
        PostgreSQL/SQLite   Redis
        (source of truth)  (channel layer + cache)
```

### چرا Django به‌عنوان بک‌اند اصلی باقی می‌ماند؟

تمام منطق کسب‌وکار — احراز هویت، احراز دسترسی، عضویت، نقش‌ها، مجوزها، جلسات، حضور، فایل‌ها — در یک لایهٔ واحد به نام `classrooms/services.py` زندگی می‌کند. ویوهای HTTP و کانکیومرهای WebSocket **دقیقاً از همان توابع** استفاده می‌کنند، بنابراین هیچ تفاوتی بین آنچه در صفحه اتفاق می‌افتد و آنچه روی سوکت اتفاق می‌افتد وجود ندارد. افزودن یک بک‌اند دوم یعنی دو نسخه از همین قواعد و دو جا برای اشتباه کردن.

### چرا WebRTC؟

صوت و تصویر باید **نقطه‌به‌نقطه و رمزنگاری‌شده** بین مرورگرها جریان داشته باشد. عبور دادن مدیا از Django یعنی هر فریم از سرور اپلیکیشن بگذرد: تأخیر بیشتر، مصرف پهنای باند سرور، و گلوگاه مقیاس‌پذیری. WebSocket تنها برای **رویدادهای سبک JSON** استفاده می‌شود (حضور، گفتگو، عملیات تخته، سیگنالینگ).

### چرا SFU لازم است؟

در حالت mesh (بدون سرور رسانه) هر شرکت‌کننده باید جریان خود را به N-1 نفر دیگر بفرستد: آپلود کاربر با رشد کلاس خطی زیاد می‌شود و کلاس‌های بالای ۴–۵ نفر عملاً غیرقابل استفاده‌اند. یک **SFU** (Selective Forwarding Unit) جریان را یک بار می‌گیرد و به بقیه فوروارد می‌کند — آپلود ثابت می‌ماند، کنترل سمت سرور (mute، قطع دسترسی) ممکن می‌شود و مقیاس‌پذیری به ده‌ها شرکت‌کننده می‌رسد.

### چرا LiveKit انتخاب شد؟

| گزینه | ارزیابی |
|---|---|
| **LiveKit** ✅ | SDK رسمی پایتون (`livekit-api`) → تولید توکن **داخل خود Django**، بدون سرویس جانبی، کاملاً قابل تست به‌صورت آفلاین. سرور: یک ایمیج Docker، Apache-2.0، فعال و پرنگهداری. |
| mediasoup | کتابخانهٔ **Node.js** — یک رانتایم بک‌اند دوم تحمیل می‌کند و Django را از مرکزیت خارج می‌کند. |
| Janus | نوشته‌شده در C با معماری پلاگین/REST — یکپارچه‌سازی با Django به‌مراتب پیچیده‌تر و کم‌نگهداری‌تر. |

کلید API و secret هرگز به مرورگر نمی‌رسند؛ Django فقط **JWT کوتاه‌مدت و محدود به مجوزهای مؤثر کاربر** صادر می‌کند و SFU همان را enforce می‌کند.

### حالت جایگزین: WebRTC Mesh (بدون نیاز به SFU)

اگر LiveKit پیکربندی نشده باشد، اتاق به‌طور خودکار به **حالت mesh** می‌رود (`static/js/mesh.js`): هر شرکت‌کننده اتصال P2P مستقیم با بقیه می‌سازد (mic/camera و اشتراک صفحه روی اتصال‌های جدا، تا تصویر صفحه با دوربین قاطی نشود). هماهنگی با *perfect negotiation* انجام می‌شود: **عضو با `member_id` بزرگ‌تر پیشنهاد می‌دهد** و کوچکت‌ر پاسخ می‌دهد؛ SDP/ICE از مسیر `rtc_signal` بالا و **نقطه‌به‌نقطه** (نه broadcast) رله می‌شوند. STUN عمومی گوگل استفاده می‌شود و کاندیدای host برای شبکهٔ محلی بدون اینترنت هم کار می‌کند. رسانه هرگز از Django عبور نمی‌کند. برای کلاس‌های بزرگ همان LiveKit توصیه می‌شود (mesh با N نفر، O(N²) اتصال می‌سازد).

### معماری WebSocket

| اندپوینت | کانکیومر | وظیفه |
|---|---|---|
| `/ws/classroom/<code>/` | `ClassroomConsumer` | حضور، فهرست شرکت‌کنندگان، بالا بردن دست، relay رویدادهای مدیریتی، اعلان‌های هدفمند، ثبت حضور |
| `/ws/classroom/<code>/chat/` | `ChatConsumer` | گفتگوی زنده + تاریخچه + ذخیره در DB + حذف پیام توسط مدیر |
| `/ws/classroom/<code>/whiteboard/` | `WhiteboardConsumer` | همگام‌سازی عملیات ساخت‌یافتهٔ تخته + ذخیرهٔ رویدادها |

**اعتبارسنجی اتصال:** کاربر ثبت‌نام‌شده (session/auth) یا مهمانِ دارای `guest_uid` در session خودش باید عضو فعال آن کلاس باشد (وگرنه ۴۴۰۱/۴۴۰۳) — با `SessionMiddlewareStack` در ASGI. هر عملیات **به‌صورت مستقل و زنده** بازبینی می‌شود — تغییر تنظیمات در میانهٔ جلسه فوراً اثر می‌کند.

### پروتکل رویدادها

```
user_joined · user_left · participant_list · media_state · classroom_updated
raise_hand · lower_hand
chat_message · chat_deleted
permission_changed · role_changed · participant_muted · mute_all
participant_removed · waiting_room_entry · notification
classroom_locked · classroom_unlocked · settings_changed
session_started · session_ended
file_uploaded · presentation_changed
whiteboard_operation · whiteboard_history
whiteboard_state · rtc_signal
```

**`whiteboard_state`** — وقتی کسی با مجوز `can_use_whiteboard` تخته را باز/بسته می‌کند، سرور وضعیت را به **همهٔ اعضا** broadcast می‌کند و در فیلد `classroom.whiteboard_open` ذخیره می‌کند؛ بنابراین حتی عضوِ دیرهنگام هم تختهٔ باز را می‌بیند.

**`rtc_signal`** — پاکتِ **کدر و محدود به ۱۶KB** برای SDP/ICE در حالت mesh:
`{"action":"rtc_signal","to_member_id":<id>,"data":{...}}` → فقط به همان هم‌کلاسیِ فعال تحویل می‌شود
(`{"type":"rtc_signal","from_identity":...,"data":...}`). Django هرگز محتوای سیگنال را تفسیر نمی‌کند و **هیچ رسانه‌ای** از آن عبور نمی‌کند.

### معماری سطح دسترسی

دو لایه، یک نقطهٔ ترکیب:

```
Role ──► PermissionDefaults (ماتریس پیش‌فرض نقش)
              │
              ▼
     ClassroomMember.can_*   (per-member، قابل تغییر توسط میزبان)
              │
              ├── AND ──► Classroom.allow_student_*  (تنظیمات اتاق)
              ├── AND ──► Classroom.chat_disabled
              └── override ──► member.muted / member.camera_disabled
                        │
                        ▼
          effective_permissions()  ◄── تنها منبع حقیقت
                        │
        ┌───────────────┼────────────────┬─────────────────┐
        ▼               ▼                ▼                 ▼
   WebSocket auth   LiveKit grants   صفحهٔ کلاس        DRF API
```

`classrooms/permissions.py` تنها جایی است که قواعد نوشته شده‌اند. افزودن قابلیت جدید = یک فیلد روی `ClassroomMember` + یک مقدار پیش‌فرض در ماتریس. **هیچ مجوزی در ویوها یا کانکیومرها hard-code نشده است.**

**تغییر JavaScript در مرورگر هیچ دسترسی‌ای ایجاد نمی‌کند:** دکمه‌ها فقط affordance هستند؛ هر درخواست (HTTP یا WebSocket) سمت سرور بازبینی می‌شود و توکن SFU هم بر اساس همان مجوزهای مؤثر صادر می‌شود، پس حتی فراخوانی دستی تابع فرانت‌اند نتیجه‌ای ندارد.

### معماری دسترسی مهمان

مهمان‌ها **یک `ClassroomMember` با `user=NULL`** هستند (نه مدل جدا) — همان خط لولهٔ
مجوز/میزبان/consumer برای هر دو کار می‌کند:

```
ClassroomMember
├── user          → NULL برای مهمان
├── is_guest      → True
├── guest_uid     → secrets.token_urlsafe(16)  (حدس‌ناپذیر)
├── display_name  → «Ali» / «Ali (2)»
└── identity      → «g:<guest_uid>» یا «u:<user_id>»  (کلید عمومی کلاینت)
```

احراز هویت مهمان فقط از **session سمت سرور** انجام می‌شود
(`request.session["guest_member_<room_code>"]`): در HTTP با `resolve_member` و در
WebSocket با `SessionMiddlewareStack` + `resolve_scope_member`. هیچ شناسه‌ای از
کلاینت پذیرفته نمی‌شود؛ uid جعلی = ۴۰۳/close. نام‌ها در `ChatMessage.sender_name`
و `WhiteboardEvent.actor_identity` دنورمالایز می‌شوند تا تاریخچه پس از خروج مهمان
هم درست نمایش داده شود.

### معماری دیتابیس

```
User (accounts)
 └─ ClassroomMember ──► Classroom ──► Whiteboard ──► WhiteboardEvent
        │                   │
        │                   ├── ChatMessage
        │                   ├── SharedFile
        │                   └── ClassroomSession ──► AttendanceRecord
        └──────────────────────────────────────────────┘
```

**ایندکس‌ها** (بر اساس الگوهای واقعی کوئری، نه حدسی):

| ایندکس | دلیل |
|---|---|
| `Classroom.room_code` (unique) | هر درخواست با کد اتاق شروع می‌شود |
| `(classroom, is_active)` روی عضو | فهرست شرکت‌کنندگان فعال |
| `(classroom, role)` روی عضو | فیلتر بر اساس نقش |
| `(owner, created_at)` | داشبورد |
| `(classroom, status)` روی جلسه | یافتن جلسهٔ LIVE |
| `(session, user)` روی حضور | جمع‌بندی گزارش حضور |
| `(classroom, created_at)` روی پیام | تاریخچهٔ گفتگو |
| `(classroom, uploaded_at)` روی فایل | فهرست فایل‌ها |
| `(whiteboard, id)` | replay عملیات تخته |

`select_related()` در همهٔ مسیرهای دارای FK استفاده شده تا N+1 حذف شود؛ در مسیرهای bulk (مثل `mute_all`) از `update()` به‌جای حلقه روی آبجکت‌ها استفاده می‌شود.

### تخته سفید: event-sourced، نه تصویری

هر stroke/شکل/متن یک **عملیات JSON ساخت‌یافته** است:

```json
{"type": "draw", "tool": "pen", "points": [[12,40],[18,52], …], "color": "#2563eb", "width": 3, "id": "…"}
```

هیچ تصویر باینری ذخیره یا ارسال نمی‌شود. عملیات در `WhiteboardEvent` ذخیره می‌شود، روی اتصال جدید replay می‌شود، و عملیات `clear` تاریخچه را compact می‌کند تا جدول کوچک بماند. یک `seq` watermark از دوباره‌کاری در لحظهٔ اتصال مجدد جلوگیری می‌کند.

---

## ۳. راه‌اندازی

پیش‌نیاز: **Python 3.11+**

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
| `SECRET_KEY` | کلید مخفی Django |
| `DEBUG` | توسعه `true`، پروداکشن `false` |
| `DATABASE_URL` | خالی = SQLite؛ پروداکشن `postgres://user:pass@host:5432/db` |
| `REDIS_URL` | خالی = لایهٔ InMemory؛ پروداکشن `redis://127.0.0.1:6379/0` |
| `ALLOWED_HOSTS` / `CSRF_TRUSTED_ORIGINS` | هاست‌ها و originهای مورد اعتماد |
| `MEDIA_SERVER_URL` / `MEDIA_SERVER_API_KEY` / `MEDIA_SERVER_API_SECRET` | تنظیمات LiveKit — خالی بگذارید تا بدون مدیا اجرا شود |
| `MEDIA_TOKEN_TTL_MINUTES` | عمر توکن رسانه (پیش‌فرض ۳۶۰) |
| `MAX_UPLOAD_MB` | حداکثر حجم آپلود (پیش‌فرض ۲۵) |

### مایگریشن، سوپریوزر، اجرا

```bash
python manage.py migrate
python manage.py createsuperuser
python manage.py runserver
```

سرور توسعه با **Daphne** هم HTTP و هم WebSocket را سرو می‌کند.

> بدون تنظیم LiveKit هم همه‌چیز کار می‌کند — گفتگو، تخته، فایل، مدیریت شرکت‌کنندگان فعال‌اند و ناحیهٔ ویدیو پیام «سرور رسانه پیکربندی نشده» نشان می‌دهد.

### Redis

```bash
# Docker
docker run -d -p 6379:6379 --name classroom-redis redis:7

# یا مستقیم
redis-server
```

سپس در `.env`: `REDIS_URL=redis://127.0.0.1:6379/0`

Redis برای **channel layer** و **cache** (rate limiting رمز کلاس) استفاده می‌شود — نه به‌عنوان دیتابیس. منبع حقیقت داده‌های ماندگار همیشه PostgreSQL/SQLite است.

### راه‌اندازی سرور رسانه (LiveKit)

```bash
# حالت توسعه (کلیدهای dev)
docker run -d --name livekit -p 7880:7880 -p 7881:7881 -p 7882:7882/udp \
  livekit/livekit-server --dev --bind 0.0.0.0

# سپس در .env
MEDIA_SERVER_URL=ws://127.0.0.1:7880
MEDIA_SERVER_API_KEY=devkey
MEDIA_SERVER_API_SECRET=secretsecretsecretsecretsecretse
```

برای پروداکشن از `livekit-server` با فایل کانفیگ و TURN سرور استفاده کنید (مستندات رسمی LiveKit).

### Docker

```bash
cp .env.example .env   # SECRET_KEY و MEDIA_SERVER_* را تنظیم کنید
docker compose up --build
```

سرویس‌ها: `web` (Django + Daphne)، `postgres:16`، `redis:7`. سرور رسانه جدا deploy می‌شود (بند قبل). Docker برای توسعهٔ لوکال **الزامی نیست**.

### اجرای تست‌ها

```bash
python manage.py test
```

---

## ۴. ساختار پروژه

```
online_classroom/
├── manage.py
├── config/                  # settings, urls, asgi (WebSocket routing), wsgi
├── accounts/                # کاربر سفارشی، ثبت‌نام، ورود، پروفایل،
│                            #   context_processors (ترجیحات UI)
├── classrooms/              # هستهٔ دامنه
│   ├── models.py            # Classroom, ClassroomMember, ClassroomSession,
│   │                        #   AttendanceRecord, SharedFile
│   ├── permissions.py       # ماتریس نقش → مجوز + effective_permissions()
│   ├── services.py          # تمام منطق کسب‌وکار + اکشن‌های میزبان + broadcast
│   ├── media.py             # تولید توکن LiveKit (scoped به مجوزها)
│   ├── file_validation.py   # پسوند + magic bytes + ظرف OOXML
│   ├── consumers.py         # حضور و رویدادها
│   ├── api.py               # DRF
│   └── views.py / forms.py / urls*.py / admin.py
├── chat/                    # ChatMessage + ChatConsumer (مدریشن)
├── whiteboard/              # Whiteboard, WhiteboardEvent + WhiteboardConsumer
├── core/                    # صفحات عمومی، API URLها، templatetags
├── static/
│   ├── css/                 # tokens.css (design system), main.css, room.css
│   └── js/                  # theme.js, modal.js, room.js, media.js, chat.js,
│                            #   whiteboard.js, lobby.js, toast.js, app.js
├── templates/               # base.html, home.html, 403.html, 404.html
├── Dockerfile / docker-compose.yml / .dockerignore
├── requirements.txt / .env.example / .gitignore
└── README.md
```

### آدرس‌ها

```
/                                        خانه
/accounts/register|login|logout|profile
/accounts/after-login/                   ریدایرکت بر اساس صفحهٔ فرود کاربر
/dashboard/                              داشبورد + جلسات پیش‌رو
/classrooms/                             کلاس‌های من
/classrooms/create/                      ایجاد کلاس
/classrooms/<code>/                      مدیریت (تنظیمات، زمان‌بندی، جلسات)
/class/<code>/                           لینک عمومی → لابی
/class/<code>/lobby/                     لابی: نام/رمز → بررسی واقعی دستگاه‌ها
/class/<code>/leave/                     خروج (مهمان از session خارج می‌شود)
/class/<code>/waiting/                   اتاق انتظار
/class/<code>/room/                      صفحهٔ کلاس
/class/<code>/media-token/               توکن کوتاه‌مدت LiveKit
/class/<code>/members/<id>/permission|role|mute|remove|waiting/
/class/<code>/mute-all|lock|settings|presentation/
/class/<code>/sessions/start|<id>/end|<id>/attendance/
/class/<code>/files/upload|<id>/download/
/api/auth/register|login/
/api/classrooms/                         لیست/ایجاد
/api/classrooms/<code>/                  جزئیات
/api/classrooms/<code>/participants/[<id>/]     لیست (?role=&q=) / PATCH
/api/classrooms/<code>/sessions/[<id>/<start|end>/]
/api/classrooms/<code>/messages|files|attendance/
```

---

## ۵. امنیت

**اعتبارسنجی سمت سرور**
- هر اکشن میزبان در `services.py` دوباره بررسی می‌کند: عضو فعال؟ نقش کافی؟ آیا این هدف قابل مدیریت است؟ (مالک همه را مدیریت می‌کند جز خودش؛ مدیر فقط غیرمدیران را)
- تغییر نقش فقط OWNER؛ نقش OWNER قابل تغییر نیست
- IDOR: عضو یک کلاس نمی‌تواند با تغییر `room_code` یا `member_id` به کلاس دیگر دست بزند — هر کوئری با `classroom=...` محدود شده و در صورت نقض، ۴۰۳/۴۰۴
- `user_id`، `role`، `permission` و `room_id` ارسالی از مرورگر **هرگز** مورد اعتماد نیستند؛ همه از session و دیتابیس خوانده می‌شوند

**رمزها**
- رمز کاربر و رمز کلاس هر دو با `make_password`/`check_password` هش می‌شوند؛ هش هرگز در HTML یا JSON نمی‌رود
- رمز کلاس فقط در بدنهٔ POST است، نه در URL
- **Rate limiting**: ۵ تلاش ناموفق رمز → ۱۲۰ ثانیه مسدودیت (cache-backed، در پروداکشن Redis)

**آپلود فایل**
- whitelist پسوند → بررسی حجم → **sniffing magic bytes** → برای Office بررسی ظرف OOXML (`[Content_Types].xml` و marker مربوطه)
- پسوند جعلی (مثلاً ELF با نام `.pdf`) رد می‌شود
- نام فایل sanitize می‌شود (path traversal حذف) و مسیر ذخیره‌سازی با UUID تصادفی ساخته می‌شود
- دانلود فقط برای اعضای فعال

**XSS**: همهٔ متن‌های کاربر (نام، پیام، نام فایل) با `textContent` در JS و autoescape در تمپلیت درج می‌شوند — هیچ `innerHTML` با دادهٔ کاربر وجود ندارد.

**CSRF**: روی همهٔ فرم‌ها و همهٔ POSTهای JSON (هدر `X-CSRFToken`).

**WebSocket**: احراز هویت از session کوکی (`AuthMiddlewareStack` + `SessionMiddlewareStack`) + بررسی عضویت فعال در `connect` + بازبینی مجوز در هر پیام.

**مهمان‌ها**
- `guest_uid` با `secrets.token_urlsafe(16)` ساخته می‌شود و فقط در session سمت سرور همان مرورگر ذخیره می‌شود؛ شناسهٔ جعلی در WS/HTTP → رد
- scope مهمان به یک کلاس محدود است (`guest_member_<room_code>`)؛ با session یک کلاس نمی‌توان وارد کلاس دیگر شد
- endpointهای داشبورد، پروفایل، مدیریت کلاس و اکشن‌های میزبان همچنان `login_required`اند — مهمان حتی با session معتبر به آن‌ها نمی‌رسد
- `can_upload_files` برای مهمان همیشه False است، حتی اگر flag در دیتابیس True باشد

**کوکی‌ها/هدرها**: `SameSite=Lax`، و در حالت غیردیباگ `Secure`، `HSTS` و `SSL redirect` به‌صورت خودکار فعال می‌شوند.

**لاگ‌ها**: ساخت‌یافته و فقط با شناسه‌ها (`room_code`, `user_id`, `session_id`). رمز، توکن و credentials هرگز لاگ نمی‌شوند.

---

## ۶. تست‌ها

```bash
python manage.py test     # 106 تست
```

| حوزه | پوشش |
|---|---|
| احراز هویت | ثبت‌نام، ورود، خروج، محافظت از داشبورد، رندر همهٔ صفحات |
| کلاس | ایجاد، یکتایی room code، هش بودن رمز، کد نامعتبر، کلاس رمزدار، دسترسی غیرمجاز |
| مجوزها | پیش‌فرض نقش‌ها، `effective_permissions` با تنظیمات اتاق، تلاش برای ارتقای غیرمجاز، مدیریت مدیر توسط مدیر دیگر، تغییر نقش مالک |
| میزبان | mute، mute-all، تغییر نقش/مجوز، حذف + ممنوعیت موقت، قفل، تنظیمات |
| اتاق انتظار | ورود به انتظار، تأیید، رد |
| Rate limiting | مسدود شدن پس از ۵ رمز اشتباه |
| جلسات/حضور | زمان‌بندی → شروع → پایان، ممنوعیت شروع توسط دانش‌آموز، چند ورود/خروج، گزارش حضور فقط برای میزبان |
| فایل‌ها | آپلود مجاز، پسوند غیرمجاز، **پسوند جعلی**، فایل خالی، ظرف Office نامعتبر، سقف حجم، path traversal، دانلود غیرمجاز |
| توکن رسانه | grants مالک، grants دانش‌آموز، حذف میکروفون برای کاربر mute، ۴۰۳ برای غیرعضو، ۵۰۳ بدون پیکربندی |
| WebSocket | اتصال/قطع، `user_joined`/`user_left`، بالا بردن دست، گفتگو، حذف پیام، رد دانش‌آموز در تخته، عملیات نامعتبر، compact شدن `clear`، رد کاربر ناشناس و غیرعضو |
| مهمان‌ها | ورود با نام، trim/طول/markup، نام تکراری → «Ali (2)»، رمز درست/غلط، guests غیرفعال (۴۰۳)، کلاس قفل/غیرفعال، اتاق انتظار، هویت `g:` در WS، رد uid جعلی، عدم دسترسی به داشبورد/مدیریت/کلاس دیگر، host action → redirect به login، خروج = unbind از session |
| مجوز مهمان | پیش‌فرض‌های نقش GUEST، `can_upload_files` همیشه False، محدود شدن با تنظیمات اتاق مثل دانش‌آموز، عدم امکان ارتقای نقش توسط خود مهمان |

---

## ۷. نقشهٔ راه

- رابط چندزبانه (زیرساخت ترجیحات کاربر آماده است؛ UI فعلی فارسی است)
- ضبط جلسه (LiveKit Egress)
- Breakout rooms
- همگام‌سازی cursor/لیزر اشاره‌گر روی تخته
- نظرسنجی و کوییز
- اعلان‌های push و ایمیل
- moderation خودکار محتوا (معماری `ChatMessage.is_deleted` و لاگ رویدادها آماده است)
- زیرنویس زنده
- پرداخت و اشتراک

---

## ۸. نکتهٔ استقرار پروداکشن

```bash
# چند پروسه — هر دو HTTP و WebSocket
daphne -b 0.0.0.0 -p 8000 config.asgi:application
```

چک‌لیست: `DEBUG=false` · `SECRET_KEY` تصادفی · `DATABASE_URL` روی PostgreSQL · `REDIS_URL` روی Redis · `ALLOWED_HOSTS` و `CSRF_TRUSTED_ORIGINS` · `MEDIA_SERVER_*` · پشت reverse proxy با پشتیبانی WebSocket (Nginx با `Upgrade`/`Connection` headers) · `MEDIA_ROOT` روی volume یا object storage · `python manage.py collectstatic`.
