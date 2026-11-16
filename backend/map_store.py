"""Map tiles: rideable OSM roads downloaded once and kept on disk per tile.

The world is cut into TILE_DEG x TILE_DEG tiles (0.1 deg, about 7 x 5.7 mi at
35 N). A tile holds every way of the download filter that touches it, with
its node ids, coordinates and tags, exactly as Overpass returned it. Ways that
cross a tile border are in both tiles; readers merge by way id. OSM ids are
stable, so the "master map" is simply the set of tiles on disk, and it grows
as people generate in new places.

Files: <data dir>/tiles-v<FILTER_VERSION>/<row>_<col>.json.gz. Changing the
query bumps FILTER_VERSION, so every tile is fetched again into a new folder.

Downloading: a public Overpass server costs tens of seconds per request
almost regardless of size, and gives each user only a couple of query slots.
So the wanted tiles that are missing are shared out over every free query slot
of every server in OVERPASS_URL (SLOTS requests at a time per server, up to
MAX_BATCH tiles per request: one bbox clause per tile, results split into tiles
here), generation requests before prefetches, nearest first. A request a server
has not started answering after HEDGE_AFTER seconds is sent to another server
too, and whichever answers first wins. A server that fails rests for a while
(on 429, until its /status says a slot frees) and its tiles go to the others;
a tile gives up after ATTEMPTS failed requests.
A prefetch (a dropped pin) can be cancelled, even mid-download, until a
generation waits for the same tiles.
"""
import gzip
import json
import math
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable, Dict, Iterable, List, Optional, Set, Tuple

from limits import env_number

TILE_DEG = 0.1
FILTER_VERSION = 1
HIGHWAYS = (
    'trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|'
    'unclassified|residential|living_street|pedestrian|cycleway|path|bridleway|road'
)
BIKE_OK = 'yes|designated|permissive'
# Main public server, then a public instance without rate limits (OSM wiki list).
DEFAULT_OVERPASS = ('https://overpass-api.de/api/interpreter,'
                    'https://overpass.private.coffee/api/interpreter')
# Who to contact about this app's Overpass requests: the public servers ask that
# heavy users can be reached. Set LOOP_CONTACT (an email or a project URL) on a
# public server; the placeholder makes the server warn at start.
CONTACT_PLACEHOLDER = 'contact@example.com'
CONTACT = (os.environ.get('LOOP_CONTACT') or CONTACT_PLACEHOLDER).strip()


def user_agent(contact: str = CONTACT) -> str:
    """The placeholder address is left out: overpass-api.de answers it with 406."""
    if not contact or contact == CONTACT_PLACEHOLDER:
        return 'loop-finder/0.1 (bike loop generator)'
    return f'loop-finder/0.1 (bike loop generator; {contact})'


USER_AGENT = user_agent()
MAX_BATCH = 16  # tiles per request (~0.4 x 0.4 deg; Charlotte that size is ~45 MB, ~1 min)
SLOTS = env_number('LOOP_MAP_SLOTS', 2, lo=1)  # requests at a time per server (overpass-api.de allows 2)
HEDGE_AFTER = 20.0  # seconds without a first byte before another server is asked too
ATTEMPTS = 5  # failed requests before a tile gives up
# Seconds a server rests after its 1st, 2nd, ... failure in a row (LOOP_MAP_RETRY_WAITS for tests).
RETRY_WAITS = tuple(float(x) for x in (os.environ.get('LOOP_MAP_RETRY_WAITS') or '5,15,30').split(','))
MAX_SLOT_WAIT = 90.0  # longest wait for a rate-limit slot before trying again anyway
REFUSED_WAIT = 300.0  # rest after an answer that will not change soon (400, 403, 406, ...)
QUERY_TIMEOUT = 300  # seconds Overpass may spend on a query
READ_CHUNK = 1 << 16

Tile = Tuple[int, int]  # (row, col) = floor(lat / TILE_DEG), floor(lng / TILE_DEG)


class MapError(RuntimeError):
    """Map data could not be downloaded (message is shown to the user)."""


class Cancelled(Exception):
    """Every tile of a running download stopped being wanted."""


def default_dir() -> str:
    return os.environ.get('LOOP_MAP_DIR') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'map_data')


def overpass_urls() -> List[str]:
    raw = os.environ.get('OVERPASS_URL') or DEFAULT_OVERPASS
    return [u.strip() for u in raw.split(',') if u.strip()]


def tile_of(lat: float, lng: float) -> Tile:
    return int(math.floor(lat / TILE_DEG)), int(math.floor(lng / TILE_DEG))


def tile_bbox(tile: Tile) -> Tuple[float, float, float, float]:
    """(south, west, north, east)."""
    r, c = tile
    return (round(r * TILE_DEG, 6), round(c * TILE_DEG, 6),
            round((r + 1) * TILE_DEG, 6), round((c + 1) * TILE_DEG, 6))


def _meters_to_box(lat, lng, box) -> float:
    """Distance from a point to the nearest point of a lat/lng box (flat approx)."""
    s, w, n, e = box
    y = min(max(lat, s), n)
    x = min(max(lng, w), e)
    k = math.cos(math.radians(lat))
    return math.hypot(y - lat, (x - lng) * k) * 111320.0


def tiles_for_circle(lat: float, lng: float, radius_m: float) -> List[Tile]:
    """Tiles touching the circle, nearest first."""
    d_lat = radius_m / 111320.0
    d_lng = radius_m / (111320.0 * max(0.05, math.cos(math.radians(lat))))
    r0, c0 = tile_of(lat - d_lat, lng - d_lng)
    r1, c1 = tile_of(lat + d_lat, lng + d_lng)
    out = []
    for r in range(r0, r1 + 1):
        for c in range(c0, c1 + 1):
            dist = _meters_to_box(lat, lng, tile_bbox((r, c)))
            if dist <= radius_m:
                out.append((dist, (r, c)))
    out.sort()
    return [t for _d, t in out]


def overpass_query(tiles: Iterable[Tile]) -> str:
    """One query for every ways-of-interest clause of every tile."""
    parts = []
    for tile in tiles:
        s, w, n, e = tile_bbox(tile)
        bbox = f'{s},{w},{n},{e}'
        parts.append(f'way["highway"~"^({HIGHWAYS})$"]({bbox});')
        parts.append(f'way["highway"="footway"]["bicycle"~"^({BIKE_OK})$"]({bbox});')
    return f'[out:json][timeout:{QUERY_TIMEOUT}];({"".join(parts)});out geom qt;'


def overpass_fetch(query: str, url: str,
                   on_bytes: Optional[Callable[[int], None]] = None,
                   cancelled: Optional[Callable[[], bool]] = None) -> dict:
    """One Overpass request. Reads in chunks so it can be abandoned (Cancelled).
    Raises urllib errors / ValueError / Cancelled."""
    body = urllib.parse.urlencode({'data': query}).encode()
    req = urllib.request.Request(url, data=body, headers={
        'User-Agent': USER_AGENT,
        'Accept-Encoding': 'gzip',
    })
    with urllib.request.urlopen(req, timeout=QUERY_TIMEOUT + 30) as resp:
        chunks, got = [], 0
        while True:
            if cancelled is not None and cancelled():
                raise Cancelled()
            chunk = resp.read(READ_CHUNK)
            if not chunk:
                break
            chunks.append(chunk)
            got += len(chunk)
            if on_bytes is not None:
                on_bytes(got)
        raw = b''.join(chunks)
        if resp.headers.get('Content-Encoding') == 'gzip':
            raw = gzip.decompress(raw)
    data = json.loads(raw)
    remark = data.get('remark') or ''
    if 'runtime error' in remark.lower():
        raise ValueError(f'Overpass: {remark}')
    return data


def slot_wait(url: str) -> Optional[float]:
    """Seconds until this server gives us a query slot (its /status page), or None."""
    status_url = url.rsplit('/', 1)[0] + '/status'
    try:
        with urllib.request.urlopen(status_url, timeout=15) as resp:
            text = resp.read().decode('utf-8', 'replace')
    except (urllib.error.URLError, OSError, ValueError):
        return None
    if re.search(r'^\s*[1-9]\d* slots? available now', text, re.M):
        return 0.0
    waits = [float(x) for x in re.findall(r'in (\d+) seconds', text)]
    return min(waits) if waits else None


def compact_ways(data: dict) -> List[list]:
    """[[way_id, [node ids], [lng, lat, lng, lat, ...], {tags}], ...] from `out geom`."""
    out = []
    for el in data.get('elements', []):
        if el.get('type') != 'way':
            continue
        nodes = el.get('nodes') or []
        geom = el.get('geometry') or []
        if len(nodes) < 2 or len(geom) != len(nodes) or any(p is None for p in geom):
            continue
        flat = []
        for p in geom:
            flat.append(round(p['lon'], 7))
            flat.append(round(p['lat'], 7))
        out.append([el['id'], nodes, flat, el.get('tags') or {}])
    return out


def split_by_tile(ways: List[list], tiles: Iterable[Tile]) -> Dict[Tile, List[list]]:
    """Ways of one batch answer per requested tile: a way goes to every tile
    its segments' bounding boxes touch (a superset of what Overpass matched
    per bbox; readers merge by way id and the builder clips anyway)."""
    wanted = set(tiles)
    out: Dict[Tile, List[list]] = {t: [] for t in wanted}
    for way in ways:
        flat = way[2]
        hit: Set[Tile] = set()
        for i in range(0, len(flat) - 2, 2):
            x0, y0, x1, y1 = flat[i], flat[i + 1], flat[i + 2], flat[i + 3]
            r0, c0 = tile_of(min(y0, y1), min(x0, x1))
            r1, c1 = tile_of(max(y0, y1), max(x0, x1))
            for r in range(r0, r1 + 1):
                for c in range(c0, c1 + 1):
                    if (r, c) in wanted:
                        hit.add((r, c))
        if len(flat) == 2:  # single point, not expected from `out geom`
            t = tile_of(flat[1], flat[0])
            if t in wanted:
                hit.add(t)
        for t in hit:
            out[t].append(way)
    return out


class _Want:
    """A tile someone is waiting for or prefetching."""
    __slots__ = ('event', 'owners', 'holds', 'seq', 'error', 'fails')

    def __init__(self, seq):
        self.event = threading.Event()
        self.owners: Set[object] = set()  # prefetch owners (cancellable)
        self.holds = 0  # ensure() callers that may not be cancelled
        self.seq = seq
        self.error: Optional[str] = None
        self.fails = 0  # requests for this tile that failed


class _Request:
    """One Overpass request in flight."""
    __slots__ = ('tiles', 'url', 'started', 'bytes', 'hedged')

    def __init__(self, tiles, url, hedged):
        self.tiles: List[Tile] = tiles
        self.url = url
        self.started = time.monotonic()
        self.bytes = 0  # received so far
        self.hedged = hedged  # it is, or has, a copy on another server


class MapStore:
    """Tiles on disk plus the download workers. Thread-safe; one per process."""

    def __init__(self, data_dir: Optional[str] = None,
                 fetch: Callable[..., dict] = overpass_fetch,
                 status: Callable[[str], Optional[float]] = slot_wait):
        self.dir = data_dir or default_dir()
        self.tile_dir = os.path.join(self.dir, f'tiles-v{FILTER_VERSION}')
        os.makedirs(self.tile_dir, exist_ok=True)
        self._fetch = fetch
        self._status = status
        self._lock = threading.Lock()
        self._work = threading.Condition(self._lock)
        self._wants: Dict[Tile, _Want] = {}
        self._seq = 0
        self._active: List[_Request] = []
        self._done_bytes = 0  # received by the requests that ended since the workers were last idle
        self._workers: List[threading.Thread] = []
        self._rest: Dict[str, float] = {}  # server -> time.monotonic() it may be asked again
        self._streak: Dict[str, int] = {}  # server -> failures in a row
        self._cache: Dict[Tile, List[list]] = {}  # recently read tiles
        self._cache_order: List[Tile] = []
        # Parsed tiles kept (a dense city tile is ~10 MB in memory). A build reads all of
        # its tiles anyway; the cache only saves re-reading them for the next build nearby.
        self.cache_tiles = env_number('LOOP_TILE_CACHE', 16, lo=1)
        self.requests = 0  # Overpass requests made (for checks)

    # ---- disk ----

    def path(self, tile: Tile) -> str:
        return os.path.join(self.tile_dir, f'{tile[0]}_{tile[1]}.json.gz')

    def has(self, tile: Tile) -> bool:
        return os.path.exists(self.path(tile))

    def _read(self, tile: Tile) -> Optional[dict]:
        path = self.path(tile)
        if not os.path.exists(path):
            return None
        try:
            with gzip.open(path, 'rt') as f:
                doc = json.load(f)
        except (OSError, ValueError, EOFError):
            os.remove(path)  # damaged: fetch it again next time
            return None
        with self._lock:
            self._remember(tile, doc['ways'])
        return doc

    def _remember(self, tile, ways):
        if tile not in self._cache:
            self._cache_order.append(tile)
        self._cache[tile] = ways
        while len(self._cache_order) > self.cache_tiles:
            old = self._cache_order.pop(0)
            self._cache.pop(old, None)

    def clear_cache(self) -> int:
        """Forget the parsed tiles (the server has gone idle). Returns how many."""
        with self._lock:
            n = len(self._cache)
            self._cache.clear()
            self._cache_order.clear()
        return n

    def _write(self, tile: Tile, ways: List[list]):
        doc = {'v': FILTER_VERSION, 'tile': list(tile), 'bbox': list(tile_bbox(tile)),
               'fetched': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'ways': ways}
        tmp = self.path(tile) + f'.tmp{threading.get_ident()}'
        with gzip.open(tmp, 'wt', compresslevel=5) as f:
            json.dump(doc, f, separators=(',', ':'))
        os.replace(tmp, self.path(tile))

    def tile_ways(self, tile: Tile) -> List[list]:
        with self._lock:
            got = self._cache.get(tile)
        if got is not None:
            return got
        doc = self._read(tile)
        if doc is None:
            raise MapError(f'Map tile {tile} is not downloaded.')
        return doc['ways']

    def ways(self, tiles: Iterable[Tile]):
        """Every way in the tiles once: (way_id, node_ids, [(lng, lat)], tags)."""
        seen = set()
        for tile in tiles:
            for way_id, nodes, flat, tags in self.tile_ways(tile):
                if way_id in seen:
                    continue
                seen.add(way_id)
                yield way_id, nodes, list(zip(flat[0::2], flat[1::2])), tags

    def stats(self) -> dict:
        files = [f for f in os.listdir(self.tile_dir) if f.endswith('.json.gz')]
        size = sum(os.path.getsize(os.path.join(self.tile_dir, f)) for f in files)
        return {'tiles': len(files), 'mb': round(size / 1e6, 1)}

    def tiles(self) -> List[Tile]:
        """Every downloaded tile (row, col)."""
        out = []
        for name in os.listdir(self.tile_dir):
            m = re.match(r'^(-?\d+)_(-?\d+)\.json\.gz$', name)
            if m:
                out.append((int(m.group(1)), int(m.group(2))))
        return sorted(out)

    def missing(self, tiles: Iterable[Tile]) -> List[Tile]:
        return [t for t in tiles if not self.has(t)]

    # ---- wants (call with the lock held) ----

    def _want(self, tile: Tile) -> _Want:
        w = self._wants.get(tile)
        if w is None:
            self._seq += 1
            w = self._wants[tile] = _Want(self._seq)
            if self.has(tile):  # landed since the caller checked
                w.event.set()
                del self._wants[tile]
                return w
            self._work.notify_all()
            self._workers = [t for t in self._workers if t.is_alive()]
            for _ in range(len(overpass_urls()) * SLOTS - len(self._workers)):
                t = threading.Thread(target=self._run, name='map-download', daemon=True)
                self._workers.append(t)
                t.start()
        return w

    def _drop_if_unwanted(self, tile: Tile):
        w = self._wants.get(tile)
        if w is not None and not w.owners and w.holds <= 0:
            del self._wants[tile]
            w.event.set()  # nobody waits; keeps the event consistent

    # ---- workers ----

    def _next_job(self):
        """(tiles, server, hedged) for a free query slot, or None. Lock held.
        Tiles nobody is fetching come first: generation holds, then the oldest
        request (requests list tiles nearest first, so work starts at the pin),
        shared out evenly over the free slots. With none left, a request whose
        server has sent nothing for HEDGE_AFTER seconds is copied to another."""
        urls = overpass_urls()
        now = time.monotonic()
        load = {u: 0 for u in urls}
        for r in self._active:
            if r.url in load:
                load[r.url] += 1
        free = [u for u in urls if load[u] < SLOTS and self._rest.get(u, 0.0) <= now]
        if not free:
            return None
        running = {t for r in self._active for t in r.tiles}
        todo = sorted((0 if w.holds > 0 else 1, w.seq, t) for t, w in self._wants.items() if t not in running)
        if todo:
            slots = sum(SLOTS - load[u] for u in free)
            size = min(MAX_BATCH, -(-len(todo) // slots))
            return [t for _h, _s, t in todo[:size]], min(free, key=load.get), False
        for r in self._active:
            if r.hedged or r.bytes or now - r.started < HEDGE_AFTER:
                continue
            others = [u for u in free if u != r.url]
            tiles = [t for t in r.tiles if t in self._wants]
            if others and tiles:
                r.hedged = True
                return tiles, min(others, key=load.get), True
        return None

    def _run(self):
        while True:
            with self._lock:
                job = self._next_job()
                while job is None:
                    # With tiles wanted, look again soon: a server's rest ends, a request turns slow.
                    self._work.wait(timeout=1.0 if self._wants else 30.0)
                    job = self._next_job()
                tiles, url, hedged = job
                if not self._active:
                    self._done_bytes = 0
                req = _Request(tiles, url, hedged)
                self._active.append(req)
            host = urllib.parse.urlparse(url).netloc
            if hedged:
                print(f'[map] no answer yet for {len(tiles)} tiles; asking {host} too')
            failure = None  # (message, kind, seconds the server rests)
            ok = False
            try:
                self._download(req)
                ok = True
            except Cancelled:
                print(f'[map] download of {len(tiles)} tiles from {host} dropped (no longer wanted)')
            except Exception as exc:  # never let a worker die
                failure = self._failure(exc, url)
                print(f'[map] {failure[0]}; {host} rests {failure[2]:.0f}s')
            with self._lock:
                self._active.remove(req)
                self._done_bytes += req.bytes
                if ok:
                    self._streak[url] = 0
                elif failure:
                    self._streak[url] = self._streak.get(url, 0) + 1
                    self._rest[url] = time.monotonic() + failure[2]
                elsewhere = {t for r in self._active for t in r.tiles}
                for t in tiles:
                    w = self._wants.get(t)
                    if w is None:
                        continue
                    if self.has(t):
                        del self._wants[t]
                        w.event.set()
                    elif failure:
                        w.fails += 1
                        if w.fails >= ATTEMPTS and t not in elsewhere:
                            w.error = self._error_text(failure)
                            del self._wants[t]
                            w.event.set()
                self._work.notify_all()

    def _still_wanted(self, batch) -> bool:
        with self._lock:
            return any(t in self._wants for t in batch)

    def _download(self, req: _Request):
        """One request for req.tiles; writes the tiles. Raises what the fetch raises."""
        host = urllib.parse.urlparse(req.url).netloc

        def cancelled():
            return not self._still_wanted(req.tiles)

        def on_bytes(n):
            req.bytes = n

        if cancelled():
            raise Cancelled()
        t0 = time.time()
        with self._lock:
            self.requests += 1
        data = self._fetch(overpass_query(req.tiles), req.url, on_bytes=on_bytes, cancelled=cancelled)
        ways = compact_ways(data)
        for tile, tile_ways in split_by_tile(ways, req.tiles).items():
            if not self.has(tile):  # a copy of this request on another server may have won
                self._write(tile, tile_ways)
        print(f'[map] {len(req.tiles)} tiles, {len(ways)} ways, {req.bytes / 1e6:.1f} MB '
              f'from {host} in {time.time() - t0:.1f}s')

    def _failure(self, exc: Exception, url: str):
        """(message, kind, seconds the server rests) for a failed request."""
        host = urllib.parse.urlparse(url).netloc
        retry = RETRY_WAITS[min(self._streak.get(url, 0), len(RETRY_WAITS) - 1)]
        if isinstance(exc, urllib.error.HTTPError):
            message = f'HTTP {exc.code} from {host}'
            if exc.code == 429:
                wait = self._status(url)
                return message, 'busy', 10.0 if wait is None else min(MAX_SLOT_WAIT, wait + 1.0)
            if exc.code in (502, 503, 504):
                return message, 'busy', retry
            return message, 'server', retry if exc.code == 500 else REFUSED_WAIT
        if isinstance(exc, ValueError):  # bad JSON or an Overpass runtime error (timeout, memory)
            return f'{exc} ({host})', 'server', retry
        if isinstance(exc, (urllib.error.URLError, TimeoutError, OSError)):
            return f'{type(exc).__name__} from {host}: {getattr(exc, "reason", exc)}', 'network', retry
        return f'Map download failed: {exc} ({host})', 'server', retry

    @staticmethod
    def _error_text(failure) -> str:
        advice = {
            'busy': 'The map server is busy; try again in a minute.',
            'server': 'The map server returned an error; try again later.',
            'network': 'Check the internet connection and try again.',
        }[failure[1]]
        return f'Could not download map data ({failure[0]}). {advice}'

    # ---- public ----

    def prefetch(self, tiles: Iterable[Tile], owner: object = None) -> List[Tile]:
        """Download missing tiles in the background (nearest first if `tiles`
        is). `owner` (e.g. a connection) can cancel them with cancel_prefetch.
        Returns the missing tiles."""
        todo = self.missing(tiles)
        with self._lock:
            for t in todo:
                self._want(t).owners.add(owner)
        return todo

    def cancel_prefetch(self, owner: object, keep: Iterable[Tile] = ()) -> int:
        """Drop `owner`'s prefetches except `keep` (a pin moved). A tile still
        wanted by another owner or a waiting generation stays; a running
        download is abandoned once none of its tiles is wanted. Returns how
        many tiles were dropped."""
        keep = set(keep)
        dropped = 0
        with self._lock:
            for t, w in list(self._wants.items()):
                if t in keep or owner not in w.owners:
                    continue
                w.owners.discard(owner)
                if not w.owners and w.holds <= 0:
                    self._drop_if_unwanted(t)
                    dropped += 1
        return dropped

    def progress_mb(self) -> float:
        """MB received by the requests running now and those just ended."""
        return round((self._done_bytes + sum(r.bytes for r in list(self._active))) / 1e6, 1)

    def ensure(self, tiles: List[Tile],
               progress: Optional[Callable[[int, int, float], None]] = None,
               should_stop: Optional[Callable[[], bool]] = None,
               hold: bool = True) -> bool:
        """Block until every tile is on disk. progress(done, total, mb) is
        called as tiles land and about every second while downloading (only
        when something had to be downloaded). Returns False if should_stop
        fired first, or (hold=False) the tiles were cancelled. Raises
        MapError when a download fails.
        hold: the tiles may not be cancelled while waiting (a generation);
        a prefetch waits with hold=False so a moved pin can still cancel them."""
        todo = self.missing(tiles)
        if not todo:
            return True
        with self._lock:
            wants = {}
            for t in todo:
                w = self._want(t)
                if hold:
                    w.holds += 1
                wants[t] = w
        done = 0
        last_report = 0.0
        if progress:
            progress(0, len(todo), 0.0)
        pending = dict(wants)
        try:
            while pending:
                if should_stop and should_stop():
                    return False
                for t, w in list(pending.items()):
                    if w.event.wait(timeout=0.05):
                        del pending[t]
                        if w.error:
                            raise MapError(w.error)
                        if not self.has(t):  # a cancelled prefetch
                            return False
                        done += 1
                        if progress:
                            progress(done, len(todo), self.progress_mb())
                            last_report = time.time()
                if progress and pending and time.time() - last_report >= 1.0:
                    progress(done, len(todo), self.progress_mb())
                    last_report = time.time()
            return True
        finally:
            if hold:
                with self._lock:
                    for t, w in wants.items():
                        w.holds -= 1
                        if t in self._wants and self._wants[t] is w:
                            self._drop_if_unwanted(t)
