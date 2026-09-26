"""
پیکربندی WSGI برای PythonAnywhere.

روش استفاده:
1. داشبورد PythonAnywhere → تب Web → اپلیکیشن شما →
   «WSGI configuration file» → کل محتوای آن فایل را با این کد جایگزین کنید.
2. در دو خط اولِ زیر، YOUR_USERNAME را با نام کاربری PythonAnywhere خود و
   PYTHON_VERSION را با نسخهٔ پایتونی که .venv را با آن ساخته‌اید عوض کنید
   (همان نسخه‌ای که در تب Web انتخاب کرده‌اید).
3. دکمهٔ سبز Reload را بزنید.
"""
import os
import sys

# --- مسیر پروژه روی PythonAnywhere ---
PROJECT_PATH = '/home/YOUR_USERNAME/VirtualClass'
VENV_PATH = os.path.join(PROJECT_PATH, '.venv')
PYTHON_VERSION = 'python3.11'  # باید با نسخهٔ virtualenv یکی باشد

# معرفی پروژه و site-packages محیط مجازی به پایتون
if PROJECT_PATH not in sys.path:
    sys.path.insert(0, PROJECT_PATH)
_site_packages = os.path.join(VENV_PATH, 'lib', PYTHON_VERSION, 'site-packages')
if os.path.isdir(_site_packages) and _site_packages not in sys.path:
    sys.path.insert(0, _site_packages)

# --- متغیرهای محیطی از فایل .env پروژه ---
# (باید قبل از import شدن settings اجرا شود؛ dotenv مقادیر موجود را
# بازنویسی نمی‌کند، پس با load_dotenv داخلی settings تداخلی ندارد.)
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(PROJECT_PATH, '.env'))
except ImportError:
    pass

from django.core.wsgi import get_wsgi_application  # noqa: E402

application = get_wsgi_application()
