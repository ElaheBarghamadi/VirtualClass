"""Real row-lock regression: intentionally skipped outside PostgreSQL."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest import skipUnless

from django.contrib.auth import get_user_model
from django.db import close_old_connections, connection
from django.test import TransactionTestCase

from classrooms.models import Classroom, ClassroomSession
from classrooms.services import create_classroom, start_session


@skipUnless(connection.vendor == 'postgresql', 'requires a real PostgreSQL test database')
class PostgreSQLSessionConcurrencyTests(TransactionTestCase):
    def test_two_concurrent_starts_return_one_live_session(self):
        owner = get_user_model().objects.create_user(username='concurrent_owner')
        classroom = create_classroom(owner, 'Concurrency')
        barrier = Barrier(2, timeout=10)

        def start():
            close_old_connections()
            try:
                room = Classroom.objects.get(pk=classroom.pk)
                host = get_user_model().objects.get(pk=owner.pk)
                barrier.wait()
                return start_session(room, host).pk
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = [f.result(timeout=30) for f in (pool.submit(start), pool.submit(start))]
        self.assertEqual(results[0], results[1])
        self.assertEqual(ClassroomSession.objects.filter(classroom=classroom, status=ClassroomSession.Status.LIVE).count(), 1)
