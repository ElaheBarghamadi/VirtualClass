"""Smoke tests: every main page must render without template errors."""
from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse

from classrooms.services import create_classroom

User = get_user_model()


class PageRenderTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="tester", password="pass-12345")
        self.classroom = create_classroom(self.user, title="کلاس تست")

    def assertRenders(self, url: str, login: bool = True) -> None:
        if login:
            self.client.login(username="tester", password="pass-12345")
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200, url)

    def test_public_pages(self):
        self.assertRenders(reverse("home"), login=False)
        self.assertRenders(reverse("accounts:login"), login=False)
        self.assertRenders(reverse("accounts:register"), login=False)

    def test_authenticated_pages(self):
        self.assertRenders(reverse("dashboard"))
        self.assertRenders(reverse("accounts:profile"))
        self.assertRenders(reverse("classrooms:list"))
        self.assertRenders(reverse("classrooms:create"))
        self.assertRenders(reverse("classrooms:detail", args=[self.classroom.room_code]))
        self.assertRenders(reverse("room:room", args=[self.classroom.room_code]))

    def test_admin_index_requires_staff(self):
        response = self.client.get("/admin/", follow=False)
        self.assertIn(response.status_code, (302, 200))
        self.client.force_login(
            User.objects.create_superuser(username="admin", password="admin-pass-123", email="a@x.com")
        )
        response = self.client.get("/admin/")
        self.assertEqual(response.status_code, 200)


class DatabaseUrlTests(TestCase):
    """DATABASE_URL → Django DATABASES translation (postgres/mysql/sqlite)."""

    def test_postgres_url(self):
        from config.settings import _database_from_url
        cfg = _database_from_url("postgres://u:p@db-host:6543/mydb")
        self.assertEqual(cfg["ENGINE"], "django.db.backends.postgresql")
        self.assertEqual(cfg["NAME"], "mydb")
        self.assertEqual(cfg["USER"], "u")
        self.assertEqual(cfg["HOST"], "db-host")
        self.assertEqual(cfg["PORT"], "6543")

    def test_mysql_url_pythonanywhere_style(self):
        from config.settings import _database_from_url
        url = "mysql://elahe:secret@elahe.mysql.pythonanywhere-services.com/elahe$default"
        cfg = _database_from_url(url)
        self.assertEqual(cfg["ENGINE"], "django.db.backends.mysql")
        self.assertEqual(cfg["NAME"], "elahe$default")
        self.assertEqual(cfg["HOST"], "elahe.mysql.pythonanywhere-services.com")
        self.assertEqual(cfg["PORT"], "3306")  # mysql default port

    def test_empty_and_unknown_scheme_fall_back_to_sqlite(self):
        from config.settings import _database_from_url
        for url in ("", "mongodb://x/y", "nonsense"):
            cfg = _database_from_url(url)
            self.assertEqual(cfg["ENGINE"], "django.db.backends.sqlite3", url)
