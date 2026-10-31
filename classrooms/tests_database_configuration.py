from django.core.exceptions import ImproperlyConfigured
from django.test import SimpleTestCase
from config.settings import _database_from_url


class DatabaseConfigurationTests(SimpleTestCase):
    def test_unknown_scheme_does_not_silently_fallback_to_sqlite(self):
        with self.assertRaises(ImproperlyConfigured):
            _database_from_url('postgre://wrong-scheme/db')

    def test_empty_url_is_local_sqlite(self):
        self.assertEqual(_database_from_url('')['ENGINE'], 'django.db.backends.sqlite3')
