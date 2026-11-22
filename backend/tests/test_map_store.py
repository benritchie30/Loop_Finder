"""Downloading map tiles (map_store.MapStore) with made-up Overpass servers.

    cd backend
    python -m unittest discover -s tests -v
"""
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import map_store  # noqa: E402
from map_store import MapError, MapStore, user_agent  # noqa: E402

A = 'https://a.test/api/interpreter'
B = 'https://b.test/api/interpreter'
TILES = [(350 + r, -810 + c) for r in range(2) for c in range(4)]  # 8 tiles


def refused(url):
    return urllib.error.HTTPError(url, 406, 'Not Acceptable', None, None)


class Servers:
    """A fetch for MapStore: per-server behaviour, and a record of what was asked."""

    def __init__(self, behave):
        self.behave = behave  # url -> callable(url) that returns when the server "answers", or raises
        self.lock = threading.Lock()
        self.calls = []  # (url, number of tiles)
        self.now = 0
        self.most = 0  # most requests in flight at once

    def __call__(self, query, url, on_bytes=None, cancelled=None):
        with self.lock:
            self.calls.append((url, query.count('"highway"~')))
            self.now += 1
            self.most = max(self.most, self.now)
        try:
            self.behave[url](url)
        finally:
            with self.lock:
                self.now -= 1
        return {'elements': []}

    def asked(self, url):
        return sum(1 for u, _n in self.calls if u == url)


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        env = mock.patch.dict(os.environ, {'OVERPASS_URL': f'{A},{B}'})
        env.start()
        self.addCleanup(env.stop)

    def store(self, behave):
        servers = Servers(behave)
        return MapStore(self.dir.name, fetch=servers, status=lambda url: 0.0), servers

    def test_placeholder_contact_is_not_sent(self):
        self.assertNotIn('example.com', user_agent(map_store.CONTACT_PLACEHOLDER))
        self.assertNotIn('example.com', user_agent(''))
        self.assertIn('me@real.org', user_agent('me@real.org'))

    def test_tiles_are_shared_over_every_slot_of_every_server(self):
        store, servers = self.store({A: lambda u: time.sleep(0.3), B: lambda u: time.sleep(0.3)})
        self.assertTrue(store.ensure(TILES))
        self.assertEqual(store.missing(TILES), [])
        self.assertEqual(sorted(servers.calls), [(A, 2), (A, 2), (B, 2), (B, 2)])
        self.assertEqual(servers.most, 4)

    def test_a_refusing_server_rests_and_the_other_takes_its_tiles(self):
        def refuse(url):
            raise refused(url)
        store, servers = self.store({A: refuse, B: lambda u: None})
        self.assertTrue(store.ensure(TILES))
        self.assertEqual(store.missing(TILES), [])
        self.assertLessEqual(servers.asked(A), map_store.SLOTS)  # not asked again after its 406

    def test_a_silent_server_is_overtaken_by_another(self):
        release = threading.Event()
        store, servers = self.store({A: lambda u: release.wait(30), B: lambda u: None})

        def release_and_settle():
            # The silent server answers at last: let its download finish (it may
            # still write a tile) before the folder is removed, or the removal
            # can meet a file being written ("Directory not empty").
            release.set()
            deadline = time.time() + 5
            while time.time() < deadline:
                with store._lock:
                    if not store._active:
                        return
                time.sleep(0.02)
        self.addCleanup(release_and_settle)
        with mock.patch.object(map_store, 'HEDGE_AFTER', 0.2):
            started = time.time()
            self.assertTrue(store.ensure(TILES))
            self.assertLess(time.time() - started, 10)
        self.assertEqual(store.missing(TILES), [])

    def test_gives_up_when_every_server_keeps_failing(self):
        def down(url):
            raise urllib.error.URLError('no route')
        store, servers = self.store({A: down, B: down})
        with mock.patch.object(map_store, 'RETRY_WAITS', (0.0,)):
            with self.assertRaises(MapError) as caught:
                store.ensure(TILES[:1])
        self.assertIn('internet connection', str(caught.exception))
        self.assertEqual(len(servers.calls), map_store.ATTEMPTS)


if __name__ == '__main__':
    unittest.main()
