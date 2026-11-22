"""Browser check of the map and sidebar behaviour, on the real app.

Starts the backend (port 8799, the tiles in backend/map_data, no
map downloads) and the Vite dev server (port 5199), then drives the UI in
headless Chromium on a rural area (Boone, NC) and a city (Charlotte, NC):
generates loops and checks the hover marker, clicking routes, the Road tool,
areas, and the sidebar (fits without scrolling, filters, sort, cards). Screenshots go to
backend/check_frontend_out/.

    cd backend
    python tools/check_frontend.py                 # both areas
    python tools/check_frontend.py --area city     # one area
    python tools/check_frontend.py --headed        # watch it
    python tools/check_frontend.py --only hover,road_tool

Setup: see TESTING.md. Run it with the project's virtual environment
activated (source venv/bin/activate). Exit code 0 when every
check passes.
"""
import argparse
import asyncio
import glob
import json
import math as Math
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
ROOT = os.path.dirname(BACKEND)
UI = os.path.join(ROOT, 'route-loop-finder')
OUT = os.path.join(BACKEND, 'check_frontend_out')
WS_PORT = 8799
UI_PORT = 5199

# Start pins inside the uploaded tiles, with a short enough length that the
# whole reach circle is covered. The rural one is on the junction of US 321 and
# Laurel Creek Road (enough routes for the list to scroll).
# (A start near the edge of the downloaded tiles is found each run: __chk.edgeStart.)
# `dead_end`: the end of a dead-end street (Northside Drive, Boone; Marvin Road,
# Charlotte; their whole reach is downloaded), where routes must start (not at
# the nearest junction).
AREAS = {
    'rural': {'lat': 36.254622, 'lng': -81.851116, 'min': 6, 'max': 12, 'zoom': 13,
              'dead_end': [36.248045, -81.855159]},
    'city': {'lat': 35.2, 'lng': -80.8, 'min': 5, 'max': 10, 'zoom': 14,
             'dead_end': [35.197059, -80.8004]},
}

RED = '#dc2626'
GREEN_AREA = '#16a34a'


# ---------------------------------------------------------------- servers

def _port_open(port):
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(('127.0.0.1', port)) == 0


def _wait(pred, timeout, what):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return
        time.sleep(0.25)
    raise RuntimeError(f'timed out waiting for {what}')


def _http_ok(url):
    try:
        with urllib.request.urlopen(url, timeout=1) as r:
            return r.status == 200
    except Exception:
        return False


def start_servers(log_dir):
    for port in (WS_PORT, UI_PORT):
        if _port_open(port):
            raise RuntimeError(f'port {port} is busy (an earlier check still running?)')
    env = dict(os.environ, LOOP_PORT=str(WS_PORT),
               OVERPASS_URL='http://127.0.0.1:9/', PYTHONUNBUFFERED='1')
    backend_log = open(os.path.join(log_dir, 'backend.log'), 'w')
    backend = subprocess.Popen([sys.executable, 'server.py'], cwd=BACKEND, env=env,
                               stdout=backend_log, stderr=subprocess.STDOUT)
    npx = shutil.which('npx') or shutil.which('npx.cmd')
    if not npx:
        backend.terminate()
        raise RuntimeError('npx not found (install Node.js)')
    ui_env = dict(os.environ, VITE_WS_URL=f'ws://localhost:{WS_PORT}',
                  VITE_GEOCODER_URL='http://127.0.0.1:9')
    ui_log = open(os.path.join(log_dir, 'vite.log'), 'w')
    # Own process group: npx starts vite as a child, and both must stop.
    group = ({'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == 'nt'
             else {'start_new_session': True})
    ui = subprocess.Popen([npx, 'vite', '--port', str(UI_PORT), '--strictPort'], cwd=UI, env=ui_env,
                          stdout=ui_log, stderr=subprocess.STDOUT, **group)
    try:
        _wait(lambda: _port_open(WS_PORT), 30, 'the backend')
        _wait(lambda: _http_ok(f'http://localhost:{UI_PORT}/'), 60, 'the Vite dev server')
    except Exception:
        stop_servers([backend, ui])
        raise
    return [backend, ui]


def stop_servers(procs):
    for p in procs:
        if p.poll() is not None:
            continue
        if os.name == 'nt':
            subprocess.run(['taskkill', '/F', '/T', '/PID', str(p.pid)], capture_output=True)
        else:
            try:
                os.killpg(p.pid, 15)  # the vite group (npx and its child)
            except (ProcessLookupError, PermissionError, OSError):
                p.terminate()
    for p in procs:
        try:
            p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            p.kill()


# ---------------------------------------------------------------- browser

# Chrome / Chromium / Edge a machine may already have (used when Playwright's own Chromium is missing).
SYSTEM_BROWSERS = [
    'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', '/snap/bin/chromium',
    'microsoft-edge', 'msedge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
]


# Browsers downloaded by Puppeteer (Chrome for Testing) or Playwright, in any user's cache.
def _cache_roots():
    roots = [os.path.expanduser('~/.cache')]
    for env in ('PUPPETEER_CACHE_DIR', 'PLAYWRIGHT_BROWSERS_PATH'):
        if os.environ.get(env):
            roots.append(os.environ[env])
    if os.name == 'nt':
        roots += [os.path.join(os.environ.get('USERPROFILE', ''), '.cache'), os.environ.get('LOCALAPPDATA', '')]
    else:
        roots += glob.glob('/home/*/.cache') + ['/root/.cache', '/opt']
    return [r for r in roots if r and os.path.isdir(r)]


DOWNLOADED_PATTERNS = [
    # Puppeteer: <cache>/puppeteer/chrome/<platform>-<version>/chrome-<platform>/chrome
    'puppeteer/chrome/*/chrome-*/chrome',
    'puppeteer/chrome/*/chrome-*/chrome.exe',
    'puppeteer/chrome/*/chrome-*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome/*/chrome-*/chrome',  # PUPPETEER_CACHE_DIR itself
    # Playwright: <cache>/ms-playwright/chromium-<rev>/chrome-<platform>/chrome
    'ms-playwright/chromium-*/chrome-*/chrome',
    'ms-playwright/chromium-*/chrome-*/chrome.exe',
    'chromium-*/chrome-*/chrome',  # PLAYWRIGHT_BROWSERS_PATH itself, /opt/pw-browsers
    'pw-browsers/chromium-*/chrome-*/chrome',
    # Headless-only builds, last
    'puppeteer/chrome-headless-shell/*/chrome-headless-shell-*/chrome-headless-shell',
    'ms-playwright/chromium_headless_shell-*/chrome-*/headless_shell',
]


def _version_key(path):
    nums = [int(n) for n in re.findall(r'\d+', path)]
    return nums


def downloaded_browsers():
    """Chrome for Testing / Chromium builds found in Puppeteer and Playwright caches, newest first."""
    found = []
    for pattern in DOWNLOADED_PATTERNS:
        hits = []
        for root in _cache_roots():
            hits += [p for p in glob.glob(os.path.join(root, pattern)) if os.path.isfile(p)]
        found += sorted(set(hits) - set(found), key=_version_key, reverse=True)
    return found


def browser_candidates(explicit=None):
    """(label, launch options) in the order they are tried."""
    if explicit:
        return [(explicit, {'executable_path': explicit})]
    out = [("Playwright's Chromium", {})]
    seen = set()
    for path in downloaded_browsers():
        if os.path.realpath(path) not in seen:
            seen.add(os.path.realpath(path))
            out.append((path, {'executable_path': path}))
    out.append(('installed Google Chrome', {'channel': 'chrome'}))
    out.append(('installed Microsoft Edge', {'channel': 'msedge'}))
    for name in SYSTEM_BROWSERS:
        path = shutil.which(name) or (name if os.path.isabs(name) and os.path.exists(name) else None)
        if path and os.path.realpath(path) not in seen:
            seen.add(os.path.realpath(path))
            out.append((path, {'executable_path': path}))
    return out


async def launch_browser(pw, headless, explicit=None):
    """Playwright's Chromium, a Chrome for Testing / Chromium that
    Puppeteer or Playwright downloaded, else an installed Chrome / Chromium / Edge."""
    errors = []
    for label, options in browser_candidates(explicit):
        try:
            browser = await pw.chromium.launch(headless=headless, **options)
            print(f'Browser: {label} ({browser.version})')
            return browser
        except Exception as exc:  # not installed, or cannot start
            errors.append(f'  {label}: {str(exc).strip().splitlines()[0]}')
    raise RuntimeError('No browser could be started:\n' + '\n'.join(errors)
                       + '\nSee TESTING.md ("A browser for the check").')


# ---------------------------------------------------------------- results

class Results:
    def __init__(self):
        self.rows = []

    def check(self, name, ok, detail=''):
        self.rows.append((name, bool(ok), detail))
        mark = 'PASS' if ok else 'FAIL'
        print(f'  [{mark}] {name}' + (f' - {detail}' if detail else ''))
        return ok

    @property
    def failed(self):
        return [r for r in self.rows if not r[1]]


# ---------------------------------------------------------------- page helpers

JS_HELPERS = r"""
window.__chk = {
  // The start nearest (lat, lng) whose search area needs map tiles that are not
  // downloaded (its own tile is), by the app's own tile maths (utils/mapTiles.js)
  // and the tiles the server reported (MAP_INFO). Starts about 300 m around it
  // need missing tiles too, so a click a pixel off still does. Null: none near.
  async edgeStart(lat, lng, maxMiles) {
    const { tilesForStart, tileOf } = await import('/src/utils/mapTiles.js');
    const cov = window.__loopState.mapCoverage;
    if (!cov || !cov.tiles) return null;
    const have = new Set(cov.tiles.map(([r, c]) => `${r}_${c}`));
    const has = (a, b) => { const [r, c] = tileOf(a, b, cov.deg); return have.has(`${r}_${c}`); };
    const needsMore = (a, b) => tilesForStart(a, b, maxMiles, cov.deg).some(([r, c]) => !have.has(`${r}_${c}`));
    const d = 0.003;
    let best = null;
    for (let i = -60; i <= 60; i++) {
      for (let j = -60; j <= 60; j++) {
        const a = lat + i * 0.01, b = lng + j * 0.01;
        const dist = Math.hypot(i, j);
        if (best && dist >= best.dist) continue;
        const ok = [[0, 0], [d, 0], [-d, 0], [0, d], [0, -d]]
          .every(([da, db]) => has(a + da, b + db) && needsMore(a + da, b + db));
        if (ok) best = { lat: a, lng: b, dist };
      }
    }
    return best && { lat: best.lat, lng: best.lng };
  },
  // Screen (page) position of a lat/lng.
  screen(lat, lng) {
    const map = window.__loopMap;
    const p = map.latLngToContainerPoint([lat, lng]);
    const r = map.getContainer().getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  },
  // Is this page point on the bare map (not under the panel or the chart)?
  onMap(x, y) {
    const el = document.elementFromPoint(x, y);
    return !!el && !!el.closest('.leaflet-container') && !el.closest('.leaflet-control-container');
  },
  profile(path) {
    return (path || window.__loopState.currentPath).properties.elevation_profile;
  },
  // Page points along a route, each pushed `offPx` to the side of it.
  along(path, from, to, n, offPx) {
    const prof = this.profile(path);
    const out = [];
    for (let k = 0; k < n; k++) {
      const f = from + (to - from) * (k / Math.max(1, n - 1));
      const i = Math.min(prof.length - 2, Math.max(0, Math.round(f * (prof.length - 1))));
      const a = this.screen(prof[i][2], prof[i][3]);
      const b = this.screen(prof[i + 1][2], prof[i + 1][3]);
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      out.push({ x: a.x - ((b.y - a.y) / len) * offPx, y: a.y + ((b.x - a.x) / len) * offPx, i });
    }
    return out;
  },
  // Screen distance (px) from a page point to a route.
  distPx(path, x, y) {
    const prof = this.profile(path);
    let best = Infinity;
    for (let i = 1; i < prof.length; i++) {
      const a = this.screen(prof[i - 1][2], prof[i - 1][3]);
      const b = this.screen(prof[i][2], prof[i][3]);
      const vx = b.x - a.x, vy = b.y - a.y;
      const den = vx * vx + vy * vy;
      const t = den ? Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / den)) : 0;
      best = Math.min(best, Math.hypot(x - a.x - vx * t, y - a.y - vy * t));
    }
    return best;
  },
  // A visible map point at least `minPx` from every listed route.
  emptySpot(minPx) {
    const r = window.__loopMap.getContainer().getBoundingClientRect();
    const paths = window.__loopState.paths;
    for (let y = r.top + 60; y < r.bottom - 60; y += 37) {
      for (let x = r.left + 80; x < r.right - 80; x += 41) {
        if (!this.onMap(x, y)) continue;
        if (paths.every((p) => this.distPx(p, x, y) > minPx)) return { x, y };
      }
    }
    return null;
  },
  // A point on some route other than the shown one, far (px) from the shown one
  // (and, with `avoid` a CSS selector, well clear of that element: an open menu).
  otherRouteSpot(minPx, avoid = null) {
    const st = window.__loopState;
    const el = avoid && document.querySelector(avoid);
    const box = el ? el.getBoundingClientRect() : null;
    const clear = (p) => !box || p.x < box.left - 20 || p.x > box.right + 20 || p.y < box.top - 20 || p.y > box.bottom + 20;
    for (const path of st.paths) {
      if (path.id === st.currentPath.id) continue;
      for (const p of this.along(path, 0.05, 0.95, 60, 0)) {
        if (this.onMap(p.x, p.y) && clear(p) && this.distPx(st.currentPath, p.x, p.y) > minPx) return { ...p, id: path.id };
      }
    }
    return null;
  },
  // A point on the shown route with room around it (marginPx) on the bare map.
  visibleOnRoute(marginPx) {
    for (const f of [0.3, 0.35, 0.25, 0.4, 0.2, 0.5, 0.6, 0.15, 0.7, 0.8]) {
      const p = this.along(null, f, f, 1, 0)[0];
      const ok = [[0, 0], [marginPx, 0], [-marginPx, 0], [0, marginPx], [0, -marginPx]]
        .every(([dx, dy]) => this.onMap(p.x + dx, p.y + dy));
      if (ok) return p;
    }
    return this.along(null, 0.3, 0.3, 1, 0)[0];
  },
  // Routes within px of a page point.
  routesNear(x, y, px) {
    return window.__loopState.paths.filter((p) => this.distPx(p, x, y) <= px).map((p) => p.id);
  },
  // Does anything in the panel overflow (the panel itself must never scroll)?
  panelFits() {
    const panel = document.querySelector('.control-panel');
    const r = panel.getBoundingClientRect();
    return {
      fits: panel.scrollHeight <= panel.clientHeight + 1 && r.bottom <= window.innerHeight + 1,
      bottom: Math.round(r.bottom), height: window.innerHeight,
      pageScroll: document.documentElement.scrollHeight > window.innerHeight + 1,
    };
  },
  // Selected card's centre relative to the route list's centre (px), and whether the list can scroll there.
  cardOffset() {
    const list = document.querySelector('.route-list');
    const card = list.querySelector('.route-card.is-selected');
    if (!card) return null;
    const l = list.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    return {
      offset: Math.round((c.top + c.height / 2) - (l.top + l.height / 2)),
      atTop: list.scrollTop <= 1,
      atBottom: list.scrollTop >= list.scrollHeight - list.clientHeight - 1,
      scrolls: list.scrollHeight > list.clientHeight + 1,
    };
  },
  // Route lines in the active pane (the bold shown route; not the hover marker).
  activeLines() {
    return [...document.querySelectorAll('.leaflet-activePath-pane path:not(.route-hover-marker)')]
      .map((p) => p.getAttribute('d') || '');
  },
  // The stroke colours of the faint routes.
  // The faint routes: one canvas draws them (CanvasLines); on the dev server it
  // records what it draws: [{ color, lines, halo }] per style. The halos (a
  // thin outline in the map's tone under each style's lines) are left out.
  faintLines() {
    return [...document.querySelectorAll('.leaflet-backgroundPaths-pane canvas[data-lines]')]
      .flatMap((c) => JSON.parse(c.dataset.lines || '[]'))
      .filter((g) => g.lines > 0 && !g.halo);
  },
  // The stroke colour of the bold shown route.
  activeStroke() {
    const p = document.querySelector('.leaflet-activePath-pane path:not(.route-hover-marker)');
    return p ? p.getAttribute('stroke') : null;
  },
  // The open generation's routes that are favorites (by route key), and the cards marked as favorites.
  favoritesShown() {
    const st = window.__loopState;
    const keys = new Set(st.favoriteKeys);
    return { routes: st.paths.filter((p) => keys.has(window.__routeKey(p))).length,
             cards: document.querySelectorAll('.route-card.is-favorite').length };
  },
  // The elevation chart's drawing (its lines), to tell whether it changed.
  chartLines() {
    return [...document.querySelectorAll('.elevation-window svg path')].map((p) => p.getAttribute('d') || '').join('|');
  },
  // Two neighbouring cards fully inside the list box, neither selected:
  // their list indexes and page boxes, and the gap between them.
  cardPair() {
    const list = document.querySelector('.route-list').getBoundingClientRect();
    const cards = [...document.querySelectorAll('.route-list .route-card')];
    for (let i = 0; i + 1 < cards.length; i++) {
      const a = cards[i].getBoundingClientRect();
      const b = cards[i + 1].getBoundingClientRect();
      const inside = (r) => r.top >= list.top + 20 && r.bottom <= list.bottom - 20;
      if (cards[i].classList.contains('is-selected') || cards[i + 1].classList.contains('is-selected')) continue;
      if (!inside(a) || !inside(b)) continue;
      return { i, x: a.left + a.width / 2, ay: a.top + a.height / 2, by: b.top + b.height / 2,
               gapY: (a.bottom + b.top) / 2, gap: b.top - a.bottom };
    }
    return null;
  },
  // Is the selected card shown whole (inside the list box)?
  // A point in the lowest card (not the selected one) showing at least minPx
  // at the bottom of the list: the middle of what shows of it.
  lowCard(minPx) {
    const list = document.querySelector('.route-list');
    const l = list.getBoundingClientRect();
    const cards = [...list.querySelectorAll('.route-card')];
    let pick = null;
    cards.forEach((card, i) => {
      const r = card.getBoundingClientRect();
      if (card.classList.contains('is-selected') || r.top > l.bottom - minPx || r.bottom < l.top) return;
      pick = { i, x: r.left + r.width / 2, y: (r.top + Math.min(r.bottom, l.bottom)) / 2 };
    });
    return pick;
  },
  selectedCardWhole() {
    const list = document.querySelector('.route-list').getBoundingClientRect();
    const card = document.querySelector('.route-list .route-card.is-selected')?.getBoundingClientRect();
    if (!card) return null;
    return { whole: card.top >= list.top && card.bottom <= list.bottom,
             top: Math.round(card.top - list.top), bottom: Math.round(list.bottom - card.bottom) };
  },
  // The first card not cut off at the top of the list (its index), and how far below the top it sits.
  topCard() {
    const list = document.querySelector('.route-list');
    const top = list.getBoundingClientRect().top;
    const cards = [...list.querySelectorAll('.route-card')];
    const i = cards.findIndex((c) => c.getBoundingClientRect().top >= top - 1);
    const max = list.scrollHeight - list.clientHeight;
    const last = cards.findIndex((c) => c.offsetTop >= max);  // the top card when scrolled to the end
    return { i, below: i < 0 ? null : Math.round(cards[i].getBoundingClientRect().top - top), last };
  },
  // The card under a page point (its list index), or -1.
  cardAt(x, y) {
    const card = document.elementFromPoint(x, y)?.closest('.route-card');
    return card ? [...document.querySelectorAll('.route-list .route-card')].indexOf(card) : -1;
  },
  // Boundary outlines drawn on the map: grey dotted ones (a boundary in use).
  boundaryOutlines() {
    return [...document.querySelectorAll('.leaflet-tools-pane path')]
      .filter((p) => p.getAttribute('stroke') === '#64748b' && p.getAttribute('stroke-dasharray') === '2 6').length;
  },
  toolsPaths() {
    return [...document.querySelectorAll('.leaflet-tools-pane path')].map((p) => ({
      stroke: p.getAttribute('stroke'),
      dash: p.getAttribute('stroke-dasharray'),
      opacity: p.getAttribute('stroke-opacity'),
      d: (p.getAttribute('d') || '').length,
    }));
  },
};
"""


async def state(page, expr):
    return await page.evaluate(f'() => {{ const s = window.__loopState; return {expr}; }}')


async def helpers(page):
    await page.evaluate(JS_HELPERS)


async def wait_state(page, expr, timeout=60000):
    await page.wait_for_function(f'() => {{ const s = window.__loopState; return !!s && ({expr}); }}',
                                 timeout=timeout)


async def settle(page, ms=120):
    await page.wait_for_timeout(ms)


async def marker_shown(page):
    return await page.evaluate("() => !!document.querySelector('.route-hover-marker')")


# ---------------------------------------------------------------- scenario

async def toggle_view_option(page, label):
    """Flip one switch in the map display options (gear) menu, then close it
    (the menu closes when the pointer leaves it)."""
    gear = page.get_by_role('button', name='Map display options')
    if await gear.get_attribute('aria-expanded') != 'true':
        await gear.click()
    await page.locator('.view-options label', has_text=label).click()
    await settle(page, 150)
    box = await page.locator('.control-panel').bounding_box()
    await page.mouse.move(box['x'] + 20, box['y'] + box['height'] - 20, steps=4)
    await settle(page, 150)
    if await gear.get_attribute('aria-expanded') == 'true':
        await gear.click()
        await settle(page, 150)


async def plan_checks(page, area, res):
    """The plan (before generating): fits, tools visible, Advanced is its own page."""
    fit = await page.evaluate('() => window.__chk.panelFits()')
    res.check(f'{area}: plan panel fits without scrolling', fit['fits'] and not fit['pageScroll'], str(fit))
    res.check(f'{area}: through / avoid tools are on the plan', await page.locator('.control-panel .tools').is_visible())
    surface = page.locator('[aria-label="Surface"] button')
    res.check(f'{area}: the plan offers Surface (Paved only / Allow gravel / Prefer gravel), Allow gravel first',
              await surface.all_inner_texts() == ['Paved only', 'Allow gravel', 'Prefer gravel']
              and await page.locator('[aria-label="Surface"] .is-active').inner_text() == 'Allow gravel',
              str(await surface.all_inner_texts()))
    await page.get_by_text('Advanced settings').click()
    await settle(page, 200)
    res.check(f'{area}: Advanced opens as a page over the whole panel',
              await page.locator('.advanced').is_visible()
              and await page.get_by_role('button', name='Find loops').count() == 0)
    res.check(f'{area}: Advanced closes with its back arrow only (no Done)',
              await page.locator('.advanced').get_by_role('button', name='Done').count() == 0)
    await page.keyboard.press('Escape')
    await settle(page, 200)
    res.check(f'{area}: Esc closes Advanced', await page.get_by_role('button', name='Find loops').is_visible())


async def plan_draw_checks(page, area, res):
    """Drawing an area in the plan: releasing the mouse must not move the start pin."""
    pin = await state(page, 's.pendingMarker')
    centre = await page.evaluate('([a, b]) => window.__chk.screen(a, b)', [pin['lat'], pin['lng']])
    for key, name in (('b', 'box'), ('c', 'circle'), ('f', 'freeform')):
        x, y = centre['x'] + 120, centre['y'] - 80
        await page.keyboard.press(key)
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.move(x + 50, y + 20, steps=4)
        await page.mouse.move(x + 60, y + 60, steps=4)
        await page.mouse.move(x + 10, y + 50, steps=4)
        await page.mouse.up()
        await settle(page, 400)
        after = await state(page, '{ pin: s.pendingMarker, n: s.selections.length, tool: s.activeTool }')
        moved = abs(after['pin']['lat'] - pin['lat']) > 1e-9 or abs(after['pin']['lng'] - pin['lng']) > 1e-9
        res.check(f'{area}: drawing a {name} in the plan leaves the start pin where it was',
                  after['n'] == 1 and not moved and after['tool'] is None, str(after))
        await page.keyboard.press('z')  # undo: the search must not be constrained by it
        await settle(page, 200)
    # A plain click in pan mode still moves the pin (and back).
    await page.mouse.click(centre['x'] + 30, centre['y'] + 30)
    await settle(page, 300)
    moved = await state(page, 's.pendingMarker')
    res.check(f'{area}: a click in pan mode still moves the start pin',
              abs(moved['lat'] - pin['lat']) > 1e-9, str(moved))
    await page.mouse.click(centre['x'], centre['y'])
    await settle(page, 300)


async def dead_end_checks(page, area, res, shot):
    """A start at the end of a dead-end street: every route starts right there."""
    lat, lng = AREAS[area]['dead_end']
    if await state(page, 's.mode') == 'display':
        await page.keyboard.press('Backspace')  # back to the plan
        await settle(page, 300)
    await page.evaluate('([a, b]) => { window.__loopMap.setView([a, b], 17, { animate: false }); }', [lat, lng])
    await settle(page, 400)
    pt = await page.evaluate('([a, b]) => window.__chk.screen(a, b)', [lat, lng])
    await page.mouse.click(pt['x'] + 4, pt['y'] + 3)  # a few metres off the end of the road
    clicked = await state(page, 's.pendingMarker')
    await page.get_by_text('Map ready').wait_for(timeout=90000)
    try:
        await page.wait_for_function(
            '(c) => { const p = window.__loopState.pendingMarker; return p && (p.lat !== c.lat || p.lng !== c.lng); }',
            arg=clicked, timeout=5000)
        moved = True
    except Exception:
        moved = False
    await settle(page, 600)
    pin = await state(page, 's.pendingMarker')
    off = lambda a, b: Math.hypot((a['lat'] - b[0]) * 111320, (a['lng'] - b[1]) * 111320 * Math.cos(b[0] * Math.pi / 180))
    res.check(f'{area}: the start pin moves onto the road', moved,
              f'{off(clicked, [pin["lat"], pin["lng"]]):.1f} m from where it was clicked')
    res.check(f'{area}: ...onto the end of the dead end', off(pin, [lat, lng]) < 1, f'{off(pin, [lat, lng]):.1f} m from it')
    await page.get_by_text('Map ready').wait_for(timeout=30000)
    await page.get_by_role('button', name='Find loops').click()
    await wait_state(page, "s.mode === 'display' && s.totalCount >= 1 && !s.isGenerating", 120000)
    await settle(page, 500)
    far = await page.evaluate("""([lat, lng]) => window.__loopState.paths.map((p) => {
        const [x, y] = p.geometry.coordinates[0];
        return Math.hypot((y - lat) * 111320, (x - lng) * 111320 * Math.cos(lat * Math.PI / 180));
    })""", [pin['lat'], pin['lng']])
    res.check(f'{area}: a start at the end of a dead end finds loops', len(far) > 0, f'{len(far)} routes')
    res.check(f'{area}: ...and every one starts where the pin is',
              far and max(far) < 1, f'farthest start {max(far or [0]):.1f} m from the pin')
    await page.evaluate('() => { window.__loopMap.setZoom(15, { animate: false }); }')
    await settle(page, 400)
    await shot('dead_end')


async def plan_again_here(page):
    """The open generation's menu: Plan again from here (back to the plan at its start)."""
    await page.get_by_role('button', name='More', exact=True).click()
    await page.get_by_role('button', name='Plan again from here').click()
    await wait_state(page, "s.mode === 'input' && !!s.pendingMarker", 10000)
    await page.get_by_text('Map ready').wait_for(timeout=90000)
    await settle(page, 300)


async def favorites_checks(page, area, res, shot):
    """Favorite routes: S and the card stars, the favorite colour, favorites only
    (an unfavorited route stays until the next one), kept after a reload and after
    deleting their generation."""
    if await state(page, 's.favoritesOnly'):
        await page.locator('.fav-toggle').click()
    if await state(page, 's.selections.length'):  # earlier sections' roads and areas filter the list
        await page.locator('.tools__summary').get_by_role('button', name='Clear').click()
        await settle(page, 300)
    before = await state(page, 's.favoriteCount')
    first = await state(page, 's.currentPath.id')
    await page.mouse.move(10, 10)
    await page.keyboard.press('s')
    await settle(page, 300)
    st = await state(page, '{ fav: s.currentFavorite, n: s.favoriteCount }')
    res.check(f'{area}: S makes the shown route a favorite', st['fav'] and st['n'] == before + 1, str(st))
    stroke = await page.evaluate('() => window.__chk.activeStroke()')
    res.check(f'{area}: ...drawn in the favorite colour (the theme colour\'s complement)',
              stroke and stroke.replace(' ', '').startswith('hsl(35,'), stroke)
    res.check(f'{area}: ...and its card is marked', await page.locator('.route-card.is-selected.is-favorite').count() == 1)
    await shot('favorite')

    star = page.locator('.route-card:not(.is-selected) .route-card__star').first
    await star.click()
    await settle(page, 300)
    st = await state(page, '{ n: s.favoriteCount, cur: s.currentPath.id }')
    res.check(f'{area}: a card\'s star makes its route a favorite without selecting it',
              st['n'] == before + 2 and st['cur'] == first, str(st))

    faint = await page.evaluate('() => window.__chk.faintLines()')
    colours = sorted({g['color'] for g in faint})
    drawn = sum(g['lines'] for g in faint)
    listed = await state(page, 's.paths.length')
    # (every listed route has its faint line, the shown one too, under its bold line)
    res.check(f'{area}: faint favorite routes look like the other faint routes',
              len(colours) == 1 and not colours[0].replace(' ', '').startswith('hsl(35,') and drawn == listed,
              f'{colours}, {drawn} faint lines of {listed} routes')
    await page.locator('.route-card.is-favorite:not(.is-selected)').first.hover()
    await settle(page, 300)
    preview = await page.evaluate('() => window.__chk.activeStroke()')
    res.check(f'{area}: ...a favorite previewed from its card is in the favorite colour',
              preview and preview.replace(' ', '').startswith('hsl(35,'), preview)
    await page.mouse.move(10, 10)
    await settle(page, 200)

    await page.locator('.fav-toggle').click()
    await settle(page, 300)
    st = await state(page, '{ on: s.favoritesOnly, n: s.paths.length, cur: s.currentPath && s.currentPath.id }')
    label = await page.locator('.route-nav__label').inner_text()
    res.check(f'{area}: Favorites lists only the favorites, staying on the shown one',
              st['on'] and st['n'] == 2 and st['cur'] == first and label.startswith('Favorite'), f"{st}, {label!r}")
    await page.keyboard.press('s')  # unfavorite the shown one
    await settle(page, 300)
    kept = await state(page, '{ n: s.paths.length, fav: s.currentFavorite }')
    res.check(f'{area}: ...an unfavorited route stays listed while it is shown', kept['n'] == 2 and not kept['fav'], str(kept))
    last = await state(page, 's.paths.findIndex((p) => p.id === s.currentPath.id) === s.paths.length - 1')
    await page.keyboard.press('ArrowLeft' if last else 'ArrowRight')  # to the other favorite
    await settle(page, 300)
    gone = await state(page, f'{{ n: s.paths.length, gone: !s.paths.some((p) => p.id === {json.dumps(first)}) }}')
    res.check(f'{area}: ...and is gone once another one is shown', gone['n'] == 1 and gone['gone'], str(gone))
    await page.locator('.fav-toggle').click()
    await settle(page, 300)

    # kept in the browser: after a reload, and after deleting their generation
    set_id = await state(page, 's.activePathSetId')
    count = await state(page, 's.favoriteCount')
    await page.reload()
    await page.wait_for_function('() => !!window.__loopMap && !!window.__loopState')
    await helpers(page)
    await wait_state(page, f's.favoriteCount === {count} && s.generations.length > 0', 10000)
    res.check(f'{area}: favorites are kept after a reload', True)
    name = await state(page, f"s.generations.find((g) => g.id === {json.dumps(set_id)}).name")
    row = page.locator('.gen-list__row').filter(has=page.get_by_text(name, exact=True))
    await row.hover()
    await row.get_by_role('button', name=f'Delete {name}', exact=True).click()
    await settle(page, 400)
    res.check(f'{area}: ...and after deleting their generation',
              await state(page, f's.favoriteCount === {count} && !s.generations.some((g) => g.id === {json.dumps(set_id)})'))
    kept = await state(page, "s.generations.find((g) => g.id === 'kept:deleted') || null")
    toast = await page.locator('.undo-toast').inner_text()
    res.check(f'{area}: ...kept in "Favorites from deleted sets", and the notice says so',
              bool(kept) and kept['name'] == 'Favorites from deleted sets' and kept['pathCount'] == count and 'kept' in toast,
              f'{kept and kept["name"]}, {toast!r}')
    await page.locator('.undo-toast').get_by_role('button', name='Undo').click()
    await settle(page, 400)
    res.check(f'{area}: ...Undo brings the set back in place of its kept favorites',
              await state(page, f"s.generations.some((g) => g.id === {json.dumps(set_id)}) && !s.generations.some((g) => g.kept)"))
    await page.locator('.gen-list__open', has=page.get_by_text(name, exact=True)).click()
    await wait_state(page, f"s.mode === 'display' && s.activePathSetId === {json.dumps(set_id)}", 5000)
    await settle(page, 500)
    shown = await page.evaluate('() => window.__chk.favoritesShown()')
    res.check(f'{area}: reopened, its favorite is marked again', shown['routes'] == count and shown['cards'] == count, str(shown))


async def set_pins(page):
    """The start pins on the map: [{ label, x, y, lit, star, n }] (x, y: the middle of the pin)."""
    return await page.evaluate("""() => [...document.querySelectorAll('.leaflet-marker-icon.custom-marker-icon:not(.custom-marker-icon--pending)')]
        .map((el) => { const r = el.getBoundingClientRect();
          return { label: el.getAttribute('aria-label') || '', x: r.left + r.width / 2, y: r.top + r.height * 0.35,
                   lit: /--(favorite-)?highlight/.test(el.className), star: el.classList.contains('custom-marker-icon--star'),
                   n: Number(el.querySelector('.marker-badge')?.textContent || 0) }; })""")


async def faint_count(page):
    return sum(g['lines'] for g in await page.evaluate('() => window.__chk.faintLines()'))


async def pins_checks(page, area, res, shot):
    """The start pins while planning: the pointer resting on one previews its routes (the
    other pins hidden, a label of what starts there); a click opens them (all routes from
    here, with a chip per set; a chip narrows the list, one under the pointer shows only its
    routes); a set in its menu (a right-click) under the pointer previews that set; with a
    set open only its pin shows; the Favorites switch: only starts with favorites, a star
    pin counting them, Your loops and the lists only favorites, remembered after a reload."""
    if await state(page, 's.mode') == 'display':
        await page.keyboard.press('Backspace')
        await settle(page, 400)
    if await state(page, 's.favoritesOnly'):
        await page.locator('.panel-section .fav-toggle').click()
        await settle(page, 300)
    await page.mouse.move(10, 10)
    await settle(page, 300)
    pins = await set_pins(page)
    shared = next((p for p in pins if re.match(r'^\d+ sets · ', p['label'])), None)
    res.check(f'{area}: pins: a start of several sets has a pin', shared is not None, str([p['label'] for p in pins]))
    if not shared:
        return
    at = await page.evaluate("""([x, y]) => { const m = window.__loopMap;
        const ll = m.containerPointToLatLng(m.mouseEventToContainerPoint({ clientX: x, clientY: y }));
        return { lat: ll.lat, lng: ll.lng }; }""", [shared['x'], shared['y']])
    here = await page.evaluate("""() => { const s = window.__loopState, key = window.__routeKey, sets = window.__pathSets;
        return s.generations.map((g) => ({ id: g.id, name: g.name, n: g.pathCount, at: g.markerPosition,
          keys: sets[g.id].paths.map(key) })); }""")
    # (the pin's tip is its start: within a few hundred metres of where the pin is drawn at this zoom)
    mine = [g for g in here if abs(g['at']['lat'] - at['lat']) < 0.01 and abs(g['at']['lng'] - at['lng']) < 0.01]
    mine.sort(key=lambda g: g['name'])
    unique = len({k for g in mine for k in g['keys']})

    # the pointer resting on it: orange, its routes (a route two sets found once), the other pins hidden
    await page.mouse.move(shared['x'], shared['y'])
    await settle(page, 500)
    after = await set_pins(page)
    drawn = await faint_count(page)
    tip = page.locator('.leaflet-tooltip.pin-label')
    label = await tip.inner_text() if await tip.count() else ''
    res.check(f'{area}: pins: the pointer on a pin previews its routes and hides the other pins (it stays as it is)',
              len(after) == 1 and not after[0]['lit'] and drawn == unique and 'sets' in label
              and await page.locator('.custom-marker-icon--pending').count() == 0,
              f'{len(after)} pins, {drawn} faint routes of {unique}, label {label!r}')
    await shot('pin_preview')
    await page.mouse.move(10, 10)
    await settle(page, 300)
    res.check(f'{area}: pins: ...moving off brings the pins back and the preview goes',
              len(await set_pins(page)) == len(pins) and await faint_count(page) == 0)

    # a right-click: its menu; a set there under the pointer previews only that set
    await page.mouse.click(shared['x'], shared['y'], button='right')
    await page.locator('.set-menu__item').first.wait_for(state='visible', timeout=5000)
    item = page.locator('.set-menu__item').nth(1)
    name = (await item.locator('.set-menu__name').inner_text()).strip()
    await item.hover()
    await settle(page, 300)
    one = next((g for g in mine if g['name'] == name), None)
    drawn = await faint_count(page)
    res.check(f'{area}: pins: a right-click opens its menu (not the set); a set there under the pointer previews only it',
              await state(page, 's.mode') == 'input' and one is not None and drawn == one['n'],
              f'{name}: {drawn} faint routes of {one and one["n"]}')
    await page.keyboard.press('Escape')
    await settle(page, 300)

    # a click: all routes from here, a chip per set
    await page.mouse.move(10, 10)
    await page.mouse.click(shared['x'], shared['y'])
    await wait_state(page, "s.mode === 'display' && !!s.combinedKey", 5000)
    await settle(page, 500)
    chips = await page.locator('.set-chip').count()
    pins_open = await set_pins(page)
    res.check(f'{area}: pins: a click on a pin of several sets opens all routes from there, with a chip per set (and All)',
              chips == len(mine) + 1 and await page.locator('.set-chip.is-on').count() == 1, f'{chips} chips for {len(mine)} sets')
    res.check(f'{area}: pins: ...with a set open, only its start\'s pin shows', len(pins_open) == 1, str(len(pins_open)))
    total = await state(page, 's.paths.length')
    some = mine[0]
    chip = page.get_by_role('button', name=f'Only the routes of “{some["name"]}”', exact=True)
    await chip.hover()
    await settle(page, 300)
    hovered = await faint_count(page)
    await chip.click()
    await settle(page, 400)
    st = await page.evaluate("""(id) => { const s = window.__loopState, sets = window.__pathSets, key = window.__routeKey;
        const mine = new Set(sets[id].paths.map(key));
        return { n: s.paths.length, all: s.paths.every((p) => mine.has(key(p))), target: s.activePathSetId }; }""", some['id'])
    res.check(f'{area}: pins: ...a chip under the pointer shows only its set\'s routes; clicked, the list is only them '
              f'(More routes adds to it)',
              hovered <= total and st['all'] and st['n'] <= total and st['target'] == some['id']
              and 'is-on' in (await chip.get_attribute('class') or ''),
              f'{hovered} faint while hovered, {st} of {total}')
    await page.locator('.set-chip').first.click()  # All
    await settle(page, 300)
    res.check(f'{area}: pins: ...All lists every route again', await state(page, 's.paths.length') == total)
    await shot('pin_chips')
    await page.keyboard.press('Escape')
    await wait_state(page, "s.mode === 'input'", 5000)
    await page.mouse.move(10, 10)
    await settle(page, 300)
    res.check(f'{area}: pins: Esc closes it, back to the plan with every pin', len(await set_pins(page)) == len(pins))

    # Favorites only: only starts with favorites, a star pin counting them; Your loops the same
    favs = await page.evaluate("""() => { const s = window.__loopState, key = window.__routeKey, fav = new Set(s.favoriteKeys);
        return s.generations.map((g) => ({ id: g.id, n: window.__pathSets[g.id].paths.filter((p) => fav.has(key(p))).length })); }""")
    with_favs = [g for g in favs if g['n'] > 0]
    await page.mouse.move(10, 10)
    await page.keyboard.press('v')
    await settle(page, 400)
    star_pins = await set_pins(page)
    rows = await page.locator('.gen-list__row').count()
    res.check(f'{area}: pins: Favorites (V) shows only the starts with favorites, their usual pins counting them, '
              f'and Your loops only the sets with favorites',
              await state(page, 's.favoritesOnly') and len(star_pins) >= 1 and all(not p['star'] and p['n'] > 0 for p in star_pins)
              and len(star_pins) <= len(pins) and rows == len(with_favs),
              f"{[(p['label'], p['n']) for p in star_pins]}, {rows} rows for {len(with_favs)} sets with favorites")
    await shot('favorites_pins')
    if star_pins:
        await page.mouse.click(star_pins[0]['x'], star_pins[0]['y'])
        await wait_state(page, "s.mode === 'display'", 5000)
        await settle(page, 400)
        st = await page.evaluate("""() => { const s = window.__loopState, fav = new Set(s.favoriteKeys);
            return { n: s.paths.length, all: s.paths.every((p) => fav.has(window.__routeKey(p))), only: s.favoritesOnly }; }""")
        res.check(f'{area}: pins: ...a click on one opens only its favorites', st['n'] >= 1 and st['all'] and st['only'], str(st))
        await page.keyboard.press('Escape')
        await wait_state(page, "s.mode === 'input'", 5000)
    await page.reload()
    await page.wait_for_function('() => !!window.__loopMap && !!window.__loopState')
    await helpers(page)
    res.check(f'{area}: pins: ...and the switch is remembered after a reload', await state(page, 's.favoritesOnly'))
    await page.locator('.panel-section .fav-toggle').click()
    await settle(page, 300)


async def drag(page, a, b, steps=8):
    await page.mouse.move(a['x'], a['y'])
    await page.mouse.down()
    await page.mouse.move(b['x'], b['y'], steps=steps)
    await page.mouse.up()


async def boundary_checks(page, area, res, shot):
    """A custom search boundary: drawn with shapes and handles, saved and used by
    the plan (the pin's area is rebuilt inside it), every route stays inside it,
    the generation shows it (a display option hides it), and it can be deleted."""
    first = None
    if await state(page, 's.mode') == 'display':
        first = await state(page, '{ id: s.activePathSetId, name: s.generations.find((g) => g.id === s.activePathSetId).name }')
        await page.keyboard.press('Backspace')
        await settle(page, 400)
    if first is None:  # the first generation of the area (made without a boundary)
        first = await state(page, '(() => { const g = s.generations[s.generations.length - 1]; return g ? { id: g.id, name: g.name } : null; })()')
    cfg = AREAS[area]
    await page.evaluate('(c) => { window.__loopMap.setView([c.lat, c.lng], c.zoom, { animate: false }); }', cfg)
    await settle(page, 400)
    centre = await page.evaluate('([a, b]) => window.__chk.screen(a, b)', [cfg['lat'], cfg['lng']])
    await page.mouse.click(centre['x'] + 30, centre['y'] + 30)  # beside the generations' pins there
    await page.get_by_text('Map ready').wait_for(timeout=90000)
    await settle(page, 800)
    await page.evaluate('(c) => { window.__loopMap.setZoom(c.zoom - 1, { animate: false }); }', cfg)
    await settle(page, 400)

    # draw: a box around the start, one corner dragged out, a circle added then removed
    await page.locator('.search-area select').select_option('__new')
    await settle(page, 300)
    res.check(f'{area}: New boundary opens the editor, the box tool ready',
              await page.locator('.boundary-editor').is_visible()
              and await state(page, "s.boundaryDraft && s.boundaryDraft.tool === 'box'"))
    pin = await state(page, 's.pendingMarker')
    p = await page.evaluate('([a, b]) => window.__chk.screen(a, b)', [pin['lat'], pin['lng']])
    await drag(page, {'x': p['x'] - 160, 'y': p['y'] - 130}, {'x': p['x'] + 140, 'y': p['y'] + 130})
    await settle(page, 300)
    draft = await state(page, 's.boundaryDraft')
    handles = await page.locator('.boundary-handle').count()
    res.check(f'{area}: a dragged box joins the boundary, with handles to adjust it',
              len(draft['shapes']) == 1 and draft['shapes'][0]['shape'] == 'box' and handles == 5 and draft['tool'] is None,
              f"{len(draft['shapes'])} shapes, {handles} handles")
    box = draft['shapes'][0]
    ne = await page.evaluate('([a, b]) => window.__chk.screen(a, b)', [box['north'], box['east']])
    await drag(page, ne, {'x': ne['x'] + 50, 'y': ne['y'] - 30})
    await settle(page, 300)
    grown = (await state(page, 's.boundaryDraft'))['shapes'][0]
    res.check(f'{area}: dragging a corner handle resizes the box',
              grown['east'] > box['east'] and grown['north'] > box['north'] and grown['south'] == box['south'],
              f"east {box['east']:.4f} -> {grown['east']:.4f}")
    # a freeform shape: drawn freehand, simplified to a few points to drag
    await page.keyboard.press('f')
    cx, cy = p['x'] - 300, p['y']
    await page.mouse.move(cx + 60, cy)
    await page.mouse.down()
    for k in range(1, 121):
        t = 2 * Math.pi * k / 120
        await page.mouse.move(cx + 60 * Math.cos(t) + 3 * Math.sin(9 * t), cy + 60 * Math.sin(t))
    await page.mouse.up()
    await settle(page, 300)
    ff = (await state(page, 's.boundaryDraft'))['shapes'][-1]
    res.check(f'{area}: a freehand shape is simplified to a few points',
              ff['shape'] == 'freeform' and 3 <= len(ff['coordinates']) <= 40, f"{len(ff['coordinates'])} points")
    v = await page.evaluate('([a, b]) => window.__chk.screen(a, b)', ff['coordinates'][0])
    await drag(page, v, {'x': v['x'] - 40, 'y': v['y'] - 20})
    await settle(page, 300)
    moved = (await state(page, 's.boundaryDraft'))['shapes'][-1]['coordinates']
    res.check(f'{area}: ...its points can be dragged', moved[0] != ff['coordinates'][0] and len(moved) == len(ff['coordinates']))
    v = await page.evaluate('([a, b]) => window.__chk.screen(a, b)', moved[1])
    await page.mouse.dblclick(v['x'], v['y'])
    await settle(page, 300)
    res.check(f'{area}: ...and double-clicking a point removes it',
              len((await state(page, 's.boundaryDraft'))['shapes'][-1]['coordinates']) == len(moved) - 1)
    await page.keyboard.press('c')
    await drag(page, {'x': p['x'] + 260, 'y': p['y']}, {'x': p['x'] + 290, 'y': p['y']})
    await settle(page, 300)
    three = await state(page, 's.boundaryDraft.shapes.length')
    await page.get_by_role('button', name='Remove shape 3').click()
    await page.get_by_role('button', name='Remove shape 2').click()
    await settle(page, 200)
    res.check(f'{area}: shapes can be added and removed',
              three == 3 and await state(page, 's.boundaryDraft.shapes.length') == 1)
    await shot('boundary_editor')
    await page.locator('.boundary-editor__name input').fill('Test area')
    await page.keyboard.press('Enter')
    await settle(page, 400)
    st = await state(page, '{ draft: s.boundaryDraft, name: s.boundary && s.boundary.name, saved: s.boundaries.length }')
    res.check(f'{area}: Enter saves the boundary and the plan uses it',
              st['draft'] is None and st['name'] == 'Test area' and st['saved'] >= 1, str(st))
    res.check(f'{area}: ...drawn as a grey dotted outline', await page.evaluate('() => window.__chk.boundaryOutlines()') == 1)
    fit = await page.evaluate('() => window.__chk.panelFits()')
    res.check(f'{area}: ...and the plan still fits', fit['fits'] and not fit['pageScroll'], str(fit))

    # generate inside it
    await page.get_by_text('Map ready').wait_for(timeout=90000)
    await settle(page, 800)
    made = await state(page, 's.generations.length')
    button = page.get_by_role('button', name='Find loops')
    if not await button.is_visible():
        await page.locator('.start-choice__row', has_text='New set').click()
    await page.get_by_role('button', name='Find loops').click()
    await wait_state(page, f"s.mode === 'display' && s.generations.length > {made} && !s.isGenerating && s.totalCount > 0", 120000)
    await settle(page, 500)
    b = grown
    outside = await page.evaluate("""(b) => window.__loopState.paths.filter((p) => p.geometry.coordinates
        .some(([x, y]) => y > b.north + 1e-6 || y < b.south - 1e-6 || x > b.east + 1e-6 || x < b.west - 1e-6)).length""", b)
    n = await state(page, 's.totalCount')
    res.check(f'{area}: every route stays inside the boundary', n > 0 and outside == 0, f'{n} routes, {outside} leave it')
    res.check(f'{area}: the generation keeps its boundary and shows it',
              await state(page, "s.setBoundary && s.setBoundary.name === 'Test area'")
              and await page.evaluate('() => window.__chk.boundaryOutlines()') == 1)
    await toggle_view_option(page, 'Search boundary')
    res.check(f'{area}: ...the Search boundary display option hides it', await page.evaluate('() => window.__chk.boundaryOutlines()') == 0)
    await toggle_view_option(page, 'Search boundary')
    await shot('boundary_routes')

    # adding to a generation made without it, with it: the generation takes the boundary
    if first:
        await page.keyboard.press('Backspace')
        await settle(page, 400)
        await page.locator('.gen-list__open').filter(has=page.get_by_text(first['name'], exact=True)).click()
        await wait_state(page, f"s.mode === 'display' && s.activePathSetId === {json.dumps(first['id'])}", 5000)
        before = await state(page, 's.totalCount')
        await plan_again_here(page)
        res.check(f'{area}: Plan again from a generation without a boundary: automatic',
                  await state(page, 's.boundary') is None)
        await page.locator('.search-area select').select_option(label='Test area')
        await page.get_by_text('Map ready').wait_for(timeout=90000)
        await settle(page, 800)
        await page.locator('.start-choice__row').filter(has=page.get_by_text(first['name'], exact=True)).click()
        await page.get_by_role('button', name='Add loops').click()
        await wait_state(page, f"s.mode === 'display' && s.activePathSetId === {json.dumps(first['id'])}", 10000)
        await settle(page, 500)
        await wait_state(page, '!s.isGenerating', 120000)
        await settle(page, 300)
        st = await page.evaluate("""([b, before]) => { const s = window.__loopState;
            const added = s.sortBy === 'found' ? s.paths.slice(before) : [];  // found order: the new ones last
            return { boundary: s.setBoundary && s.setBoundary.name, total: s.totalCount, added: added.length,
                     out: added.filter((p) => p.geometry.coordinates.some(([x, y]) =>
                        y > b.north + 1e-6 || y < b.south - 1e-6 || x > b.east + 1e-6 || x < b.west - 1e-6)).length }; }""", [b, before])
        # (a sparse area may have no loop inside the boundary the generation does not have yet)
        res.check(f'{area}: adding to it with a boundary gives it the boundary, and the new routes stay inside',
                  st['boundary'] == 'Test area' and st['added'] == st['total'] - before and st['out'] == 0,
                  str(st))

    # back in the plan: edit it, then delete it (the plan goes back to automatic)
    await page.keyboard.press('Backspace')
    await settle(page, 400)
    if not await state(page, 's.boundary'):
        await page.locator('.search-area select').select_option(label='Test area')
        await settle(page, 300)
    await page.get_by_role('button', name='Edit the boundary').click()
    await settle(page, 300)
    res.check(f'{area}: the pencil edits the boundary in use',
              await state(page, "s.boundaryDraft && s.boundaryDraft.name === 'Test area' && s.boundaryDraft.shapes.length === 1"))
    await page.get_by_role('button', name='Delete boundary').click()
    await settle(page, 300)
    st = await state(page, '{ b: s.boundary, draft: s.boundaryDraft }')
    res.check(f'{area}: ...deleting it puts the plan back on the automatic area',
              st['b'] is None and st['draft'] is None
              and await page.locator('.search-area select').input_value() == '', str(st))


async def sets_checks(page, area, res, shot, received):
    """Generations that share a start: add to one from the plan, or make a new one;
    one pin for both with a menu; Your loops highlights and centres on a pin; rename."""
    first = await state(page, '{ id: s.activePathSetId, count: s.totalCount, '
                              'name: s.generations.find((g) => g.id === s.activePathSetId).name }')
    res.check(f'{area}: a generation is named after its place only (no length)',
              not re.search(r'\d\s*[–-]\s*\d+\s*(mi|km)', first['name']), first['name'])

    # Plan again from here: the plan at its start with New set chosen; picking it there adds to it
    await plan_again_here(page)
    choice = await page.locator('.start-choice__row.is-active .start-choice__name').all_inner_texts()
    rows = await page.locator('.start-choice__name').all_inner_texts()
    res.check(f'{area}: Plan again from here: New set chosen (Find loops), the set listed to pick',
              choice == ['New set'] and first['name'] in rows
              and await page.get_by_role('button', name='Find loops').is_visible(), f'{choice} of {rows}')
    fit = await page.evaluate('() => window.__chk.panelFits()')
    res.check(f'{area}: ...and the plan still fits', fit['fits'] and not fit['pageScroll'], str(fit))
    await page.locator('.start-choice__row').filter(has=page.get_by_text(first['name'], exact=True)).click()
    await page.get_by_role('button', name='Add loops').wait_for(state='visible', timeout=5000)
    await shot('start_choice')
    created = received.count('PATHSET_CREATED')
    resumed = received.count('GENERATION_RESUMED')
    await page.get_by_role('button', name='Add loops').click()
    await wait_state(page, f"s.mode === 'display' && s.activePathSetId === {json.dumps(first['id'])}", 20000)
    await settle(page, 500)
    await wait_state(page, '!s.isGenerating', 120000)
    await settle(page, 300)
    after = await state(page, '{ count: s.totalCount, sets: s.generations.length }')
    # (a start whose routes were all found already gets none: the batch still ran on it)
    res.check(f'{area}: Add loops continues the same generation (no new one)',
              received.count('PATHSET_CREATED') == created and received.count('GENERATION_RESUMED') > resumed
              and after['count'] >= first['count'],
              f"{first['count']} -> {after['count']} routes")

    # ...or a new one from the same start: named "<place> 2", one pin for both.
    # (Its first route is a favorite: the same search finds it again in the new one.)
    if not await state(page, 's.currentFavorite'):
        await page.mouse.move(10, 10)
        await page.locator('.route-card').first.click()
        await settle(page, 200)
        if not await state(page, 's.currentFavorite'):
            await page.keyboard.press('s')
        await settle(page, 200)
    start = await state(page, f"s.generations.find((g) => g.id === {json.dumps(first['id'])}).markerPosition")
    await page.keyboard.press('Backspace')  # back to the plan (Add loops took the start pin away)
    await settle(page, 500)

    # A start pin placed by hand on the start of a set: New set is chosen, not the set.
    # (Zoomed in to street level, so a click just off the pin is a few metres from it.)
    view_before = await page.evaluate('() => { const c = window.__loopMap.getCenter(); return [c.lat, c.lng, window.__loopMap.getZoom()]; }')
    await page.evaluate('([a, b]) => { window.__loopMap.setView([a, b], 17, { animate: false }); }', [start['lat'], start['lng']])
    await settle(page, 400)
    tip = await page.evaluate('([a, b]) => window.__chk.screen(a, b)', [start['lat'], start['lng']])
    await page.mouse.click(tip['x'], tip['y'] + 3)  # just below the grey pin's tip: the map, a few metres away
    await wait_state(page, '!!s.pendingMarker', 5000)
    # (read at once, and the set picked at once below: before the server snaps the pin, 0.4 s or more)
    choice = await page.locator('.start-choice__row.is-active .start-choice__name').all_inner_texts()
    button = await page.locator('.btn-primary--big').inner_text()
    res.check(f'{area}: a start pin placed by hand on a set\'s start chooses New set (Find loops)',
              choice == ['New set'] and await page.get_by_role('button', name='Find loops').is_visible(), f'{choice} {button}')
    async def shows(name):  # the big button reads `name` (within a few seconds: the pin's area may be loading)
        try:
            await page.get_by_role('button', name=name).wait_for(state='visible', timeout=5000)
            return True
        except Exception:
            return False
    # Picked at once (before the server snaps the pin onto the road): it stays picked after the snap.
    await page.locator('.start-choice__row').filter(has=page.get_by_text(first['name'], exact=True)).click()
    snapped_before = await state(page, f"Math.abs(s.pendingMarker.lat - {start['lat']}) < 1e-9 && Math.abs(s.pendingMarker.lng - {start['lng']}) < 1e-9")
    picked = await shows('Add loops')
    await page.get_by_text('Map ready').wait_for(timeout=90000)
    await settle(page, 500)
    kept = await page.get_by_role('button', name='Add loops').is_visible()
    await page.locator('.start-choice__row', has_text='New set').click()
    res.check(f'{area}: picking the set turns it into Add loops (still after the pin snaps onto the road), '
              f'and New set back into Find loops',
              picked and kept and await shows('Find loops'), f'picked {picked}, kept {kept}, snapped before the pick {snapped_before}')

    # The grey pin of one set: a click opens the set; a right-click its menu (open it, or New set from here).
    await page.mouse.click(tip['x'] - 160, tip['y'] + 40)  # the start pin elsewhere, off the grey pin
    await settle(page, 400)
    single = page.locator(f'.leaflet-marker-icon[aria-label^={json.dumps(first["name"] + " · ")}]')
    await single.click()
    await wait_state(page, f"s.mode === 'display' && s.activePathSetId === {json.dumps(first['id'])} && !s.combinedKey", 5000)
    res.check(f'{area}: clicking a pin with one set opens that set', True)
    await page.keyboard.press('Backspace')
    await wait_state(page, "s.mode === 'input'", 5000)
    await page.mouse.click(tip['x'] - 160, tip['y'] + 40)  # the start pin again (the plan came back without one)
    await settle(page, 400)
    await single.click(button='right')
    await page.locator('.set-menu__name').first.wait_for(state='visible', timeout=5000)
    await settle(page, 200)
    items = await page.locator('.set-menu__name').all_inner_texts()
    res.check(f'{area}: right-clicking a pin with one set opens its menu (not the set)',
              items == [first['name']] and await state(page, "s.mode") == 'input'
              and await page.locator('.set-menu__action', has_text='New set from here').is_visible(), str(items))
    res.check(f'{area}: ...with no Show all routes from here (one set)',
              await page.locator('.set-menu__action', has_text='Show all routes from here').count() == 0)
    await shot('set_menu_one')
    await page.locator('.set-menu__action', has_text='New set from here').click()
    await settle(page, 300)
    st = await state(page, '{ mode: s.mode, pin: s.pendingMarker, open: s.activePathSetId }')
    on_start = bool(st['pin']) and abs(st['pin']['lat'] - start['lat']) < 1e-9 and abs(st['pin']['lng'] - start['lng']) < 1e-9
    choice = await page.locator('.start-choice__row.is-active .start-choice__name').all_inner_texts()
    res.check(f'{area}: New set from here: the plan, the start pin on the set\'s start, New set chosen, no search yet',
              st['mode'] == 'input' and on_start and choice == ['New set'] and not await state(page, 's.isGenerating')
              and await page.get_by_role('button', name='Find loops').is_visible()
              and await page.locator('.set-menu').count() == 0, f"{st}, {choice}")
    await page.evaluate('([a, b, z]) => { window.__loopMap.setView([a, b], z, { animate: false }); }', view_before)
    await page.get_by_text('Map ready').wait_for(timeout=90000)
    await settle(page, 300)
    await page.get_by_role('button', name='Find loops').click()
    await wait_state(page, f"s.mode === 'display' && s.activePathSetId && s.activePathSetId !== {json.dumps(first['id'])}", 30000)
    await wait_state(page, '!s.isGenerating && s.totalCount >= 1', 120000)
    second = await state(page, '{ id: s.activePathSetId, name: s.generations.find((g) => g.id === s.activePathSetId).name }')
    res.check(f'{area}: a second generation from the same start is "<place> #2"',
              second['name'] == f"{first['name']} #2", second['name'])
    await settle(page, 500)
    shown = await page.evaluate('() => window.__chk.favoritesShown()')
    res.check(f'{area}: routes favorited in the first are favorites in the second (found again there)',
              shown['routes'] >= 1 and shown['cards'] == shown['routes'], str(shown))
    await page.keyboard.press('Backspace')  # back to the plan
    await settle(page, 500)
    pins = await page.evaluate("""() => [...document.querySelectorAll('.leaflet-marker-icon.custom-marker-icon')]
        .map((el) => el.getAttribute('aria-label') || '').filter((t) => /^\d+ sets · /.test(t))""")
    res.check(f'{area}: both share one pin', len(pins) == 1, pins[0][:60] if pins else 'none')
    if pins:
        shared = page.locator('.leaflet-marker-icon[aria-label*=" sets · "]')
        await shared.click(button='right')
        await page.locator('.set-menu__name').first.wait_for(state='visible', timeout=5000)
        await settle(page, 200)
        items = await page.locator('.set-menu__name').all_inner_texts()
        res.check(f'{area}: right-clicking it lists both, newest first', items == [second['name'], first['name']], str(items))
        await shot('set_menu')
        # A long list scrolls in its own box, and the wheel there scrolls it instead of zooming the map
        # (squeezed to one set's height here, as if there were many).
        await page.evaluate("() => { document.querySelector('.set-menu__list').style.maxHeight = '40px'; }")
        box = await page.locator('.set-menu__list').bounding_box()
        zoom = await page.evaluate('() => window.__loopMap.getZoom()')
        await page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
        await page.mouse.wheel(0, 120)
        await settle(page, 600)
        scrolled = await page.evaluate("() => document.querySelector('.set-menu__list').scrollTop")
        res.check(f'{area}: ...a long list scrolls in the menu, and the wheel there does not zoom the map',
                  scrolled > 0 and await page.evaluate('() => window.__loopMap.getZoom()') == zoom,
                  f'scrolled {scrolled}px, zoom {zoom}')
        await page.evaluate("() => { document.querySelector('.set-menu__list').style.maxHeight = ''; }")

        # The menu closes at a click anywhere else; on the map that click does nothing more.
        async def open_menu():
            await shared.click(button='right')
            await page.locator('.set-menu__name').first.wait_for(state='visible', timeout=5000)
            await settle(page, 200)
        async def menu_closed():
            try:
                await page.locator('.set-menu').wait_for(state='detached', timeout=3000)
                return True
            except Exception:
                return False
        pin_box = await shared.bounding_box()
        before = await state(page, '{ pin: s.pendingMarker, mode: s.mode }')
        spot = {'x': pin_box['x'] - 220, 'y': pin_box['y'] + 160}
        on_map = await page.evaluate('([x, y]) => window.__chk.onMap(x, y)', [spot['x'], spot['y']])
        await page.mouse.click(spot['x'], spot['y'])
        closed = await menu_closed()
        await settle(page, 300)
        after = await state(page, '{ pin: s.pendingMarker, mode: s.mode }')
        res.check(f'{area}: a click on the map closes the menu, and does not place the start pin',
                  on_map and closed and after == before, f'closed {closed}, {before} -> {after}')
        await page.mouse.click(spot['x'], spot['y'])  # the next click does
        await settle(page, 300)
        placed = await state(page, '!!s.pendingMarker')
        res.check(f'{area}: ...the next click there places it as usual', placed)
        await open_menu()
        await page.locator('.panel-title').click()
        res.check(f'{area}: a click on the panel closes the menu', await menu_closed())
        await open_menu()
        only = await state(page, 's.favoritesOnly')
        await page.locator('.panel-section .fav-toggle').click()
        closed = await menu_closed()
        res.check(f'{area}: a button in the panel closes the menu and does what it does',
                  closed and await state(page, 's.favoritesOnly') != only, f'closed {closed}')
        await page.locator('.panel-section .fav-toggle').click()
        await settle(page, 300)
        await open_menu()
        zoom = await page.evaluate('() => window.__loopMap.getZoom()')
        await page.locator('.leaflet-control-zoom-in').click()
        closed = await menu_closed()
        await settle(page, 500)
        res.check(f'{area}: ...and so does one of the map\'s buttons (zoom in)',
                  closed and await page.evaluate('() => window.__loopMap.getZoom()') > zoom, f'closed {closed}')
        await page.evaluate('(z) => { window.__loopMap.setZoom(z, { animate: false }); }', zoom)
        await settle(page, 300)
        await open_menu()
        await page.keyboard.press('Escape')
        res.check(f'{area}: Esc closes the menu', await menu_closed())
        await open_menu()
        await shared.click()
        closed = await menu_closed()
        await wait_state(page, "s.mode === 'display' && !!s.combinedKey", 5000)
        res.check(f'{area}: a click on its pin closes the menu and opens the pin\'s routes', closed)
        await page.keyboard.press('Backspace')
        await wait_state(page, "s.mode === 'input'", 5000)
        await settle(page, 300)
        await open_menu()
        await page.locator('.set-menu__item', has_text=second['name']).click()
        await wait_state(page, f"s.mode === 'display' && s.activePathSetId === {json.dumps(second['id'])}", 5000)
        await settle(page, 300)
        title = await page.locator('.gen-panel__name').inner_text()
        chosen = await page.locator('.set-chip.is-on').inner_text()
        res.check(f'{area}: ...and picking one opens all routes from there with its chip chosen, its name above',
                  await state(page, '!!s.combinedKey') and title.strip() == second['name'] and second['name'] in chosen,
                  f'{title!r}, chip {chosen!r}')
        # With a set open, a click on another route only closes the menu (the next one shows that route).
        # (The spot is picked with the menu open, away from it and from the pin.)
        await settle(page, 500)
        await open_menu()
        other = await page.evaluate("() => window.__chk.otherRouteSpot(40, '.leaflet-popup')")
        if not other:
            await page.keyboard.press('Escape')
            await menu_closed()
        if other:
            shown = await state(page, '{ id: s.currentPath.id, set: s.activePathSetId }')
            await page.mouse.click(other['x'], other['y'])
            closed = await menu_closed()
            await settle(page, 300)
            now = await state(page, '{ id: s.currentPath.id, set: s.activePathSetId }')
            res.check(f'{area}: ...with a set open, a click on a route closes the menu and shows nothing else',
                      closed and now == shown, f'closed {closed}, {shown} -> {now}')
            shown = shown['id']
            await page.mouse.click(other['x'], other['y'])
            await settle(page, 300)
            res.check(f'{area}: ...the next click there shows that route',
                      await state(page, 's.currentPath.id') != shown)

        # Show all routes from here (two sets): one list, a route both found once, Best taking turns.
        await open_menu()
        show_all = page.locator('.set-menu__action', has_text='Show all routes from here')
        res.check(f'{area}: a pin with two sets offers Show all routes from here', await show_all.is_visible())
        await show_all.click()
        await wait_state(page, "s.mode === 'display' && !!s.combinedKey", 5000)
        if await state(page, 's.sortBy') != 'found':
            await page.locator('#sort-by').select_option('found')
        if not await state(page, 's.sortAscending'):
            await page.get_by_role('button', name=re.compile('^Reverse the order')).click()
        await settle(page, 500)
        ids = [first['id'], second['id']]
        st = await page.evaluate("""([a, b]) => { const s = window.__loopState, sets = window.__pathSets, key = window.__routeKey;
            // what Best should be: every set's 1st route (newest set first), then every 2nd, ...; a route once
            const order = [], seen = new Set(), lists = [sets[b].paths, sets[a].paths];
            for (let i = 0; i < Math.max(...lists.map((l) => l.length)); i++) lists.forEach((l) => {
              const p = l[i]; if (!p || seen.has(key(p))) return; seen.add(key(p)); order.push(p.id); });
            return { total: s.totalCount, shown: s.paths.length, sum: sets[a].paths.length + sets[b].paths.length,
                     unique: order.length, best: s.paths.map((p) => p.id).join() === order.join(),
                     target: s.activePathSetId, sets: s.combinedSets }; }""", ids)
        title = await page.locator('.gen-panel__name').inner_text()
        sub = await page.locator('.gen-panel__sub').inner_text()
        res.check(f'{area}: Show all routes from here lists every route of both sets, a route both found once',
                  title == 'All routes from here' and '2 sets' in sub and st['total'] == st['unique'] == st['shown']
                  and st['sets'] == [second['id'], first['id']],
                  f"{st['total']} routes ({st['sum']} in the sets, {st['sum'] - st['unique']} found by both); {sub}")
        res.check(f'{area}: ...Best takes turns between the sets, newest set first', st['best'])
        cards = await page.locator('.route-card').count()
        names = set(await page.locator('.route-card__from-name').all_inner_texts())
        res.check(f'{area}: ...every card names its set',
                  cards > 0 and await page.locator('.route-card__from').count() == cards
                  and names <= {first['name'], second['name']}, f'{cards} cards, {sorted(names)}')
        await page.get_by_role('button', name='More', exact=True).click()
        menu = await page.locator('.gen-menu .menu button').all_inner_texts()
        await page.get_by_role('button', name='More', exact=True).click()
        res.check(f'{area}: ...its menu has no Rename, Settings used or Delete',
                  not any(x.strip() in ('Rename', 'Settings used', 'Delete') for x in menu), str(menu))
        await shot('all_from_here')

        # More routes: to the newest set, or the one chosen in its options
        await page.locator('.gen-more__settings').click()
        select = page.locator('.gen-more__target select')
        values = await select.evaluate('(s) => [...s.options].map((o) => o.value)')
        default = await select.input_value()
        await select.select_option(first['id'])
        await settle(page, 300)
        chip = await page.locator('.gen-more__to').inner_text()
        res.check(f'{area}: ...More routes adds to the newest set, or the one chosen in its options',
                  values == [second['id'], first['id']] and default == second['id']
                  and await state(page, 's.activePathSetId') == first['id'] and await state(page, 's.combinedKey')
                  and first['name'].startswith(chip.lstrip('→ ').rstrip('…').strip()),
                  f'{values}, default {default}, chip {chip!r}')
        await shot('all_from_here_more')
        before = await page.evaluate('(a) => ({ n: window.__pathSets[a].paths.length, total: window.__loopState.totalCount })', first['id'])
        resumed = received.count('GENERATION_RESUMED')
        created = received.count('PATHSET_CREATED')
        await page.locator('.gen-more__go').click()
        await wait_state(page, '!s.isGenerating', 120000)
        await settle(page, 500)
        after = await page.evaluate('(a) => ({ n: window.__pathSets[a].paths.length, total: window.__loopState.totalCount, '
                                    'key: window.__loopState.combinedKey, target: window.__loopState.activePathSetId })', first['id'])
        res.check(f'{area}: ...which adds them to that set, and the list stays all routes from here',
                  received.count('GENERATION_RESUMED') > resumed and received.count('PATHSET_CREATED') == created
                  and after['n'] >= before['n'] and after['total'] >= before['total']
                  and after['key'] and after['target'] == first['id'],
                  f"{first['name']}: {before['n']} -> {after['n']} routes, all {before['total']} -> {after['total']}")
        if await page.locator('.gen-more__options').count():
            await page.locator('.gen-more__settings').click()

        # A card's set name chooses that set's chip (only its routes, its name above), on the same route
        card_set = await page.locator('.route-card.is-selected .route-card__from-name').inner_text()
        shown_key = await page.evaluate('() => window.__routeKey(window.__loopState.currentPath)')
        await page.locator('.route-card.is-selected .route-card__from').click()
        await settle(page, 400)
        st = await page.evaluate('() => ({ open: window.__loopState.activePathSetId, all: !!window.__loopState.combinedKey, '
                                 'key: window.__routeKey(window.__loopState.currentPath) })')
        title = await page.locator('.gen-panel__name').inner_text()
        owner = first['id'] if card_set == first['name'] else second['id']
        res.check(f'{area}: ...a card\'s set name chooses that set\'s chip, its name above, on the same route',
                  st['all'] and st['open'] == owner and st['key'] == shown_key and title.strip() == card_set.strip(),
                  f'{card_set}: {st}, {title!r}')
        # From an open set, the pin's New set from here goes back to the plan at that start.
        await settle(page, 300)
        await shared.click(button='right')
        await page.locator('.set-menu__action', has_text='New set from here').click()
        await wait_state(page, "s.mode === 'input' && !!s.pendingMarker", 5000)
        await settle(page, 300)
        st = await state(page, '{ mode: s.mode, pin: s.pendingMarker }')
        choice = await page.locator('.start-choice__row.is-active .start-choice__name').all_inner_texts()
        res.check(f'{area}: ...from an open set, New set from here goes back to the plan at that start',
                  st['mode'] == 'input' and bool(st['pin']) and choice == ['New set'], f"{st}, {choice}")
        # (the start pin's area loads and its roads are drawn: let that finish before the next checks)
        await page.get_by_text('Map ready').wait_for(timeout=90000)
        await settle(page, 800)

    # Your loops: hovering a row shows only its pin and previews its routes;
    # clicking it opens it and centres the map on it
    pos = await state(page, f"s.generations.find((g) => g.id === {json.dumps(first['id'])}).markerPosition")
    await page.evaluate('([a, b]) => { window.__loopMap.setView([a + 0.03, b - 0.05], window.__loopMap.getZoom(), { animate: false }); }',
                        [pos['lat'], pos['lng']])
    await settle(page, 300)
    view = await page.evaluate('() => { const c = window.__loopMap.getCenter(); return [c.lat, c.lng]; }')
    row = page.locator('.gen-list__row', has_text=first['name']).filter(has_not_text=second['name'])
    await row.hover()
    await settle(page, 800)
    shown_pins = len(await set_pins(page))
    drawn = await faint_count(page)
    n_first = await state(page, f"s.generations.find((g) => g.id === {json.dumps(first['id'])}).pathCount")
    still = await page.evaluate('() => { const c = window.__loopMap.getCenter(); return [c.lat, c.lng]; }')
    res.check(f'{area}: hovering a row in Your loops shows only its pin and previews its routes',
              shown_pins == 1 and drawn == n_first, f'{shown_pins} pins, {drawn} of {n_first} routes')
    res.check(f'{area}: ...without moving the map', still == view)
    await page.mouse.move(10, 10)
    await settle(page, 300)
    res.check(f'{area}: ...leaving the list ends it', len(await set_pins(page)) > 1 and await faint_count(page) == 0)

    # rename from the list
    await row.hover()
    await page.get_by_role('button', name=f"Rename {first['name']}", exact=True).click()
    await page.locator('.gen-list__input').fill('Loop test')
    await page.keyboard.press('Enter')
    await settle(page, 300)
    names = await page.locator('.gen-list__name').all_inner_texts()
    res.check(f'{area}: a generation can be renamed in Your loops', 'Loop test' in names, str(names))

    # clicking the row opens it and centres the map on its pin (beside the panel)
    await page.locator('.gen-list__open', has_text='Loop test').click()
    await wait_state(page, f"s.mode === 'display' && s.activePathSetId === {json.dumps(first['id'])}", 5000)
    await settle(page, 900)
    pin = await page.evaluate('([a, b]) => window.__chk.screen(a, b)', [pos['lat'], pos['lng']])
    box = await page.evaluate("""() => { const m = window.__loopMap.getContainer().getBoundingClientRect();
        const p = document.querySelector('.control-panel').getBoundingClientRect();
        return { x: m.left + (p.left - m.left) / 2, y: m.top + m.height / 2 }; }""")
    res.check(f'{area}: clicking a row opens it and centres the map on its pin (beside the panel)',
              abs(pin['x'] - box['x']) < 30 and abs(pin['y'] - box['y']) < 30,
              f"pin {pin['x']:.0f},{pin['y']:.0f}, centre of the free map {box['x']:.0f},{box['y']:.0f}")
    await shot('your_loops_open')


async def sidebar_checks(page, area, res, shot):
    """The route view: layout, filters, sort, cards."""
    fit = await page.evaluate('() => window.__chk.panelFits()')
    res.check(f'{area}: route panel fits without scrolling', fit['fits'] and not fit['pageScroll'], str(fit))
    res.check(f'{area}: through / avoid tools are always visible', await page.locator('.gen-panel .tools').is_visible())
    labels = await page.locator('.filter__label').all_inner_texts()
    res.check(f'{area}: filters start with Length only', labels == ['Length'], str(labels))
    options = await page.locator('#sort-by option').all_inner_texts()
    res.check(f'{area}: sort offers every variable',
              all(o in options for o in ['Best', 'Length', 'Climb rate', 'Total climb', 'Difficulty', 'Loop share', '% Unpaved', 'Discomfort', 'Similar'])
              and 'Turns' not in options,
              ', '.join(options))
    res.check(f'{area}: cards do not show turns',
              not any('turn' in t.lower() for t in await page.locator('.route-card').all_inner_texts()))

    # cards: own scroll box, selected one in the middle, arrows step
    await page.locator('.route-card').nth(0).click()
    for _ in range(5):
        await page.get_by_role('button', name='Next route').click()
    await settle(page, 700)
    idx = await state(page, 's.paths.findIndex((p) => p.id === s.currentPath.id)')
    res.check(f'{area}: the arrows step through routes', idx == 5, f'index {idx}')
    off = await page.evaluate('() => window.__chk.cardOffset()')
    centred = off and (abs(off['offset']) <= 12 or off['atTop'] or off['atBottom'])
    res.check(f'{area}: the selected card sits in the middle of the list', centred and off['scrolls'], str(off))
    cards = await page.locator('.route-card').count()
    clicked = min(cards - 1, 9)
    card = page.locator('.route-card').nth(clicked)
    await card.scroll_into_view_if_needed()
    box = await card.bounding_box()
    at = (box['x'] + box['width'] / 2, box['y'] + min(20, box['height'] / 2))
    await page.mouse.move(*at, steps=3)
    await page.mouse.click(*at)
    await settle(page, 700)
    under = await page.evaluate('([x, y]) => window.__chk.cardAt(x, y)', list(at))
    whole = await page.evaluate('() => window.__chk.selectedCardWhole()')
    res.check(f'{area}: a clicked card stays under the pointer (the list does not centre it)',
              under == clicked and await state(page, 's.paths.findIndex((p) => p.id === s.currentPath.id)') == clicked,
              f'card {under} under the pointer')
    res.check(f'{area}: ...and shows whole, its details too', whole and whole['whole'], str(whole))
    await page.get_by_role('button', name='Previous route').click()
    await settle(page, 300)
    res.check(f'{area}: the back arrow steps back',
              await state(page, 's.paths.findIndex((p) => p.id === s.currentPath.id)') == min(cards - 1, 9) - 1)
    await shot('sidebar')

    # GPX: the selected card's button and the header icon download the shown route as one track with elevation
    n_shown = await state(page, 's.paths.findIndex((p) => p.id === s.currentPath.id)') + 1
    async with page.expect_download() as dl_info:
        await page.locator('.route-card.is-selected .route-card__gpx').click()
    dl = await dl_info.value
    with open(await dl.path(), encoding='utf-8') as fh:
        gpx = fh.read()
    res.check(f"{area}: the selected card's GPX button downloads it (track points with elevation, no times)",
              dl.suggested_filename.endswith(f'route {n_shown} - ' + dl.suggested_filename.split(' - ')[-1])
              and gpx.count('<trkpt') > 10 and gpx.count('<ele>') == gpx.count('<trkpt') and '<time>' not in gpx,
              dl.suggested_filename)
    async with page.expect_download() as dl_info:
        await page.locator('.route-nav__gpx').click()
    res.check(f'{area}: the download icon by "Route n of m" downloads it too',
              (await dl_info.value).suggested_filename == dl.suggested_filename)

    # surfaces: every route carries its unpaved stretches; one that has some is dashed on the
    # map and has theme-colour and white bars on the chart
    res.check(f'{area}: every route carries its unpaved stretches',
              await state(page, 's.paths.every((p) => Array.isArray(p.properties.unpaved))'))
    gravel = await state(page, 's.paths.findIndex((p) => (p.properties.unpaved || []).length > 0)')
    if gravel >= 0:
        card = page.locator('.route-card').nth(gravel)
        await card.scroll_into_view_if_needed()
        await card.click()
        await settle(page, 500)
        dashed = await page.evaluate(
            "() => [...document.querySelectorAll('.leaflet-activePath-pane path')]"
            ".filter((p) => (p.getAttribute('stroke-dasharray') || '') !== '').length")
        bars = await page.locator('.elevation-window path[fill="url(#unpavedBars)"]').count()
        unpaved_text = await page.locator('.route-card.is-selected .route-card__details').inner_text()
        res.check(f'{area}: a route with gravel is dashed there on the map, with bars on the chart and its % unpaved on the card',
                  dashed > 0 and bars > 0 and re.search(r'UNPAVED\s+(<1|\d+)%', unpaved_text, re.I) is not None,
                  f'dashed lines {dashed}, chart bars {bars}')
        summary = await page.locator('.elevation-window__summary').inner_text()
        res.check(f'{area}: the chart sums up the route (length +climb / -descent)',
                  re.match(r'^[\d.]+ (mi|km) \+[\d,]+ (ft|m) / −[\d,]+ (ft|m)$', summary.strip()) is not None, summary)
        await shot('surface')
    else:
        print(f'  ({area}: no route with an unpaved stretch; surface drawing not checked)')

    # sort: a new variable keeps the route; flipping shows the new first one
    cur = await state(page, 's.currentPath.id')
    await page.select_option('#sort-by', 'climb_rate')
    await settle(page, 300)
    res.check(f'{area}: choosing a sort keeps the shown route',
              await state(page, "s.sortBy === 'climb_rate' && s.currentPath.id") == cur)
    await page.select_option('#sort-by', 'total_miles')
    await settle(page, 300)
    asc = await state(page, 's.sortAscending')
    await page.get_by_role('button', name='Reverse the order', exact=False).click()
    await settle(page, 500)
    flipped = await state(page, '{ asc: s.sortAscending, first: s.paths[0].id === s.currentPath.id, '
                                'desc: s.paths.every((p, i) => i === 0 || p.properties.total_miles <= s.paths[i - 1].properties.total_miles) }')
    res.check(f'{area}: flipping the order selects the first route', flipped['asc'] != asc and flipped['first'], str(flipped))
    res.check(f'{area}: ...and the list really is longest first', flipped['desc'])
    off = await page.evaluate('() => window.__chk.cardOffset()')
    res.check(f'{area}: ...scrolled to the top', off and off['atTop'], str(off))
    await page.get_by_role('button', name='Reverse the order', exact=False).click()
    await page.select_option('#sort-by', 'found')
    await settle(page, 300)

    # + Filter adds a slider, x removes it
    await page.select_option('.add-filter select', 'climb_rate')
    await settle(page, 200)
    labels = await page.locator('.filter__label').all_inner_texts()
    res.check(f'{area}: + Filter adds a filter', labels == ['Length', 'Climb rate'], str(labels))
    await page.get_by_role('button', name='Remove the Climb rate filter').click()
    await settle(page, 200)
    res.check(f'{area}: a filter can be removed', await page.locator('.filter__label').count() == 1)

    # More routes options open above the button
    await page.locator('.gen-more__settings').click()
    await settle(page, 200)
    res.check(f'{area}: More routes length and roads open', await page.locator('.gen-more__options').is_visible())
    fit = await page.evaluate('() => window.__chk.panelFits()')
    res.check(f'{area}: ...and the panel still fits', fit['fits'], str(fit))
    await page.locator('.gen-more__settings').click()

    # a smaller screen
    await page.set_viewport_size({'width': 1366, 'height': 768})
    await settle(page, 400)
    fit = await page.evaluate('() => window.__chk.panelFits()')
    res.check(f'{area}: at 1366 x 768 the route panel still fits', fit['fits'] and not fit['pageScroll'], str(fit))
    el = await page.locator('.elevation-window').bounding_box()
    panel = await page.locator('.control-panel').bounding_box()
    res.check(f'{area}: the elevation chart stays clear of the panel', el is None or el['x'] + el['width'] <= panel['x'] + 1)
    await shot('sidebar_768')
    await page.set_viewport_size({'width': 1400, 'height': 900})
    await settle(page, 400)


# (seconds, 'sent' | 'received', message type) of the page's WebSocket frames, for
# explaining a failed check (reset for each area).
FRAMES = []


def frame_timeline(types, since):
    """"MAP_INFO in 0.4 s, GET_TILE_ROADS sent 0.5 s, ..." for the given message types."""
    rows = [f"{t} {d} {at - since:.1f}s" for at, d, t in FRAMES if t in types and at >= since]
    return ', '.join(rows[:12]) or 'none'


async def offline_map_checks(page, area, res, received, shot):
    """The offline basemap: roads from the downloaded tiles before any start, a way back to
    the data from elsewhere, and a warning for a start that needs tiles that are missing."""
    cfg = AREAS[area]
    since = time.time()
    # 45 s: the server answers within ~2 s, but late in a long run, on a busy machine, the
    # browser can take over 15 s to take in the ~1.4 MB of road lines of a city's tiles (the
    # check also copies every WebSocket frame back to Python); the roads do get drawn.
    try:
        await page.wait_for_function(
            "() => !!document.querySelector('.leaflet-basemap-pane canvas')", timeout=45000)
        drawn = True
    except Exception:
        drawn = False
    await settle(page, 500)
    ok = drawn and received.count('TILE_ROADS') > 0
    detail = f"{received.count('TILE_ROADS')} tiles of roads"
    if not ok:  # where the time went (the page was reloaded just before `since`)
        detail += '; ' + frame_timeline({'MAP_INFO', 'GET_TILE_ROADS', 'TILE_ROADS'}, since - 20)
    res.check(f'{area}: offline map draws the downloaded roads before any start', ok, detail)
    await shot('offline_map')
    await page.evaluate('() => { window.__loopMap.setView([40.0, -100.0], 10, { animate: false }); }')
    await settle(page, 400)
    button = page.get_by_text('Go to the nearest')
    res.check(f'{area}: away from the map data, a button offers to go there', await button.is_visible())
    await button.click()
    try:
        await page.wait_for_function("() => !document.querySelector('.map-view__goto-data')", timeout=5000)
        back = True
    except Exception:
        back = False
    res.check(f'{area}: ...and takes the map to the downloaded area', back)
    # A start near the edge of the downloaded tiles (found each run: the map data grows)
    edge = await page.evaluate('([a, b, m]) => window.__chk.edgeStart(a, b, m)', [cfg['lat'], cfg['lng'], cfg['max']])
    res.check(f'{area}: (a start near the edge of the map data to try)', edge is not None,
              f"{edge['lat']:.3f}, {edge['lng']:.3f}" if edge else 'none within 0.6 deg')
    if edge:
        lat, lng = edge['lat'], edge['lng']
        await page.evaluate('([a, b]) => { window.__loopMap.setView([a, b], 12, { animate: false }); }', [lat, lng])
        await settle(page, 400)
        pt = await page.evaluate('([a, b]) => window.__chk.screen(a, b)', [lat, lng])
        await page.mouse.click(pt['x'], pt['y'])
        await settle(page, 600)
        hint = await page.locator('.map-view__hint').inner_text()
        res.check(f'{area}: a start that needs missing tiles says so', 'not downloaded' in hint, hint[:90])
        await shot('offline_edge_pin')
    await page.evaluate('(c) => { window.__loopMap.setView([c.lat, c.lng], c.zoom, { animate: false }); }', cfg)
    await settle(page, 400)


async def open_area(page, area, sent, res=None, checks=False, received=None, offline_checks=False, shot=None,
                    draw_checks=False):
    cfg = AREAS[area]
    await page.goto(f'http://localhost:{UI_PORT}/')
    await page.evaluate("""(cfg) => {
        localStorage.clear();
        localStorage.setItem('mapStyle', 'offline');
        localStorage.setItem('lastMapPosition', JSON.stringify({ center: [cfg.lat, cfg.lng], zoom: cfg.zoom }));
        localStorage.setItem('generatorSettings', JSON.stringify({ min_path_len: cfg.min, max_path_len: cfg.max, num_paths: 20 }));
    }""", cfg)
    await page.reload()
    await page.wait_for_function('() => !!window.__loopMap && !!window.__loopState')
    await helpers(page)
    if offline_checks:
        await offline_map_checks(page, area, res, received, shot)
    pt = await page.evaluate('([a, b]) => window.__chk.screen(a, b)', [cfg['lat'], cfg['lng']])
    await page.mouse.click(pt['x'], pt['y'])
    await page.get_by_text('Map ready').wait_for(timeout=90000)
    if checks:
        await plan_checks(page, area, res)
    if draw_checks:
        await plan_draw_checks(page, area, res)
        await page.get_by_text('Map ready').wait_for(timeout=90000)
    if checks:
        # Enter on the Advanced page starts it; going back from it shows the plan, not Advanced
        await page.get_by_text('Advanced settings').click()
        await settle(page, 200)
        await page.keyboard.press('Enter')
        await wait_state(page, "s.mode === 'display' && s.totalCount >= 3 && !s.isGenerating", 120000)
        await page.keyboard.press('Backspace')
        await settle(page, 400)
        res.check(f'{area}: back from a generation started on the Advanced page shows the plan',
                  await page.locator('.advanced').count() == 0
                  and await page.locator('.plan-lists__head').is_visible())
        await page.locator('.gen-list__open').first.click()
    else:
        await page.get_by_role('button', name='Find loops').click()
    await wait_state(page, "s.mode === 'display' && s.totalCount >= 3 && !s.isGenerating", 120000)
    await settle(page, 500)


async def run_area(page, area, res, only, sent, received):
    def want(name):
        return not only or name in only

    shot = lambda name: page.screenshot(path=os.path.join(OUT, f'{area}_{name}.png'))
    print(f'\n== {area}')
    await open_area(page, area, sent, res, checks=want('sidebar'), received=received,
                    offline_checks=want('offline_map'), shot=shot, draw_checks=want('areas'))
    count = await state(page, 's.totalCount')
    res.check(f'{area}: loops generated', count >= 3, f'{count} routes')

    if want('sidebar'):
        await sidebar_checks(page, area, res, shot)

    # ---- hover marker follows the pointer near the route, without flicker
    if want('hover'):
        for off in (14, 40):
            pts = await page.evaluate(f'() => window.__chk.along(null, 0.05, 0.95, 90, {off})')
            kept = [p for p in pts if await page.evaluate('([x, y]) => window.__chk.onMap(x, y)', [p['x'], p['y']])]
            misses = 0
            for p in kept:
                await page.mouse.move(p['x'], p['y'])
                await settle(page, 25)
                if not await marker_shown(page):
                    misses += 1
            res.check(f'{area}: hover {off} px beside the route shows the marker every time',
                      kept and misses == 0, f'{len(kept) - misses}/{len(kept)} positions')
        dist_text = await page.locator('.elevation-window__stat-value').first.inner_text()
        res.check(f'{area}: elevation chart follows the map hover', '-.--' not in dist_text, dist_text)
        await shot('hover')
        spot = await page.evaluate('() => window.__chk.emptySpot(90)')  # beyond the 64 px keep reach
        if spot:
            await page.mouse.move(spot['x'], spot['y'], steps=4)
            await settle(page, 80)
            res.check(f'{area}: marker hides away from the route', not await marker_shown(page))
        panel = await page.locator('.control-panel').bounding_box()
        await page.mouse.move(panel['x'] + 20, panel['y'] + 20)
        await settle(page, 80)
        res.check(f'{area}: marker hides when the pointer leaves the map', not await marker_shown(page))

        # hovering a route card shows that route instead of the selected one
        before = await page.evaluate('() => window.__chk.activeLines()')
        chart = await page.evaluate('() => window.__chk.chartLines()')
        await page.locator('.route-card:not(.is-selected)').first.hover()
        await settle(page, 300)
        during = await page.evaluate('() => window.__chk.activeLines()')
        await shot('card_preview')
        res.check(f'{area}: hovering a card shows only that route in bold',
                  len(before) == 1 and len(during) == 1 and during[0] != before[0],
                  f'{len(before)} -> {len(during)} bold lines')
        res.check(f'{area}: ...the elevation chart stays on the selected route',
                  chart and await page.evaluate('() => window.__chk.chartLines()') == chart)
        await page.mouse.move(panel['x'] + 20, panel['y'] + 20)
        await settle(page, 300)
        res.check(f'{area}: ...and leaving the card brings the selected route back',
                  await page.evaluate('() => window.__chk.activeLines()') == before)

        # the mouse wheel scrolls one card per notch
        await page.mouse.move(panel['x'] + 20, panel['y'] + 20)
        await page.evaluate("() => { document.querySelector('.route-list').scrollTop = 0; }")
        await settle(page, 300)
        list_box = await page.locator('.route-list').bounding_box()
        await page.mouse.move(list_box['x'] + list_box['width'] / 2, list_box['y'] + list_box['height'] / 2, steps=3)
        await settle(page, 150)
        start = await page.evaluate('() => window.__chk.topCard()')
        await page.mouse.wheel(0, 100)
        await settle(page, 800)
        one = await page.evaluate('() => window.__chk.topCard()')
        res.check(f'{area}: one wheel notch scrolls the list one card', one['i'] == start['i'] + 1,
                  f"top card {start['i']} -> {one['i']}, {one['below']} px below the top")
        under = await page.evaluate('([x, y]) => window.__chk.cardAt(x, y)',
                                    [list_box['x'] + list_box['width'] / 2, list_box['y'] + list_box['height'] / 2])
        hovered = await state(page, 's.hoveredPathId && s.paths.findIndex((p) => p.id === s.hoveredPathId)')
        res.check(f'{area}: ...and the card the wheel brought under the pointer is previewed',
                  under < 0 or hovered == under, f'preview {hovered}, under the pointer {under}')
        for _ in range(3):
            await page.mouse.wheel(0, 100)
            await settle(page, 60)
        await settle(page, 900)
        four = await page.evaluate('() => window.__chk.topCard()')
        res.check(f'{area}: three quick notches scroll three more cards (or to the end of the list)',
                  four['i'] == min(one['i'] + 3, one['last']), f"top card {one['i']} -> {four['i']}, last {one['last']}")
        for _ in range(10):  # a trackpad: many small moves
            await page.mouse.wheel(0, 12)
            await settle(page, 16)
        await settle(page, 900)
        pad = await page.evaluate('() => window.__chk.topCard()')
        res.check(f'{area}: a trackpad swipe of about a card scrolls one card (or to the end of the list)',
                  pad['i'] == min(four['i'] + 1, four['last']), f"top card {four['i']} -> {pad['i']}, last {four['last']}")
        await page.mouse.wheel(0, -100)
        await settle(page, 800)
        back = await page.evaluate('() => window.__chk.topCard()')
        res.check(f'{area}: a notch up scrolls one card back', back['i'] == max(pad['i'] - 1, 0),
                  f"top card {pad['i']} -> {back['i']}")
        await page.mouse.move(panel['x'] + 20, panel['y'] + 20)
        await settle(page, 200)

        # moving from card to card, 1 px at a time: the gap between them keeps
        # the preview (no flicker back to the selected route)
        await page.evaluate('''() => { window.__hov = []; let last;
            clearInterval(window.__hovTimer);
            window.__hovTimer = setInterval(() => {
                const st = window.__loopState, h = st.hoveredPathId;
                if (h === last) return;
                last = h;
                window.__hov.push(h ? st.paths.findIndex((p) => p.id === h) : null);
            }, 4); }''')
        pair = await page.evaluate('() => window.__chk.cardPair()')
        if pair is None:
            res.check(f'{area}: two neighbouring cards to hover', False, 'none fully visible')
        else:
            await page.mouse.move(pair['x'], pair['ay'], steps=4)
            await settle(page, 150)
            await page.evaluate('() => { window.__hov = []; }')
            y = pair['ay']
            while y < pair['by']:
                y = min(pair['by'], y + 1)
                await page.mouse.move(pair['x'], y)
                await settle(page, 8)
            await settle(page, 150)
            seq = await page.evaluate('() => window.__hov')
            res.check(f'{area}: moving from one card to the next never drops the preview (no flicker)',
                      None not in seq and seq[-1:] == [pair['i'] + 1],
                      f"gap {pair['gap']:.0f} px, previews {seq}")

        # clicking a card low in the list: it opens up in place, under the pointer,
        # so no other card slides there and nothing else is previewed. The last
        # route is selected first (its card out of view below), so the clicked card
        # is a new selection and no card above it closes.
        await page.locator('.route-card').last.click()
        await settle(page, 600)
        await page.mouse.move(panel['x'] + 20, panel['y'] + 20)
        await page.evaluate("() => { document.querySelector('.route-list').scrollTop = 0; }")
        await settle(page, 300)
        list_box = await page.locator('.route-list').bounding_box()
        low = await page.evaluate('() => window.__chk.lowCard(60)')  # room to open it under the pointer
        x, y = low['x'], low['y']
        await page.mouse.move(x, y, steps=4)
        await settle(page, 150)
        under = await page.evaluate('([x, y]) => window.__chk.cardAt(x, y)', [x, y])
        await page.mouse.click(x, y)
        await settle(page, 900)
        now_under = await page.evaluate('([x, y]) => window.__chk.cardAt(x, y)', [x, y])
        shown = await page.evaluate('() => window.__chk.activeLines()')
        cur = await state(page, '{ i: s.paths.findIndex((p) => p.id === s.currentPath.id), '
                                'line: s.currentPath.id }')
        whole = await page.evaluate('() => window.__chk.selectedCardWhole()')
        res.check(f'{area}: a card clicked low in the list stays under the pointer',
                  under >= 0 and cur['i'] == under and now_under == under,
                  f'clicked card {under}, under the pointer now {now_under}')
        res.check(f'{area}: ...shows whole (the list scrolls just enough)', whole and whole['whole'], str(whole))
        # the first moves after the click are still on the clicked card: its own
        # route stays shown, no other card flashes up
        await page.evaluate('() => { window.__hov = []; }')
        for d in (2, 4, 6, 3, 0):
            await page.mouse.move(x + d, y - d)
            await settle(page, 40)
        seq = await page.evaluate('() => window.__hov')
        res.check(f'{area}: ...moving the pointer a little previews no other card',
                  all(v is None or v == cur['i'] for v in seq)
                  and await page.evaluate('() => window.__chk.activeLines()') == shown and len(shown) == 1,
                  f'previews {seq}')
        # a card below it still previews when the pointer gets there
        nxt = await page.evaluate('(i) => { const c = document.querySelectorAll(".route-list .route-card")[i + 1];'
                                  ' if (!c) return null; const r = c.getBoundingClientRect(); return { y: r.top + r.height / 2 }; }',
                                  cur['i'])
        if nxt and nxt['y'] < list_box['y'] + list_box['height'] - 10:
            await page.mouse.move(x, nxt['y'], steps=5)
            await settle(page, 200)
            res.check(f'{area}: ...and the next card previews when the pointer moves onto it',
                      await state(page, 's.hoveredPathId && s.paths.findIndex((p) => p.id === s.hoveredPathId)') == cur['i'] + 1)
        await page.evaluate('() => clearInterval(window.__hovTimer)')
        await page.mouse.move(panel['x'] + 20, panel['y'] + 20)
        await settle(page, 200)

        # clicking the selected card when it is partly hidden at the bottom brings it into view
        await page.evaluate('''() => { const list = document.querySelector('.route-list');
            const card = list.querySelector('.route-card.is-selected');
            list.scrollTop = card.offsetTop - list.clientHeight + 70; }''')
        await settle(page, 300)
        part = await page.evaluate('() => window.__chk.selectedCardWhole()')
        sel = await state(page, 's.currentPath.id')
        box = await page.locator('.route-card.is-selected').bounding_box()
        list_box = await page.locator('.route-list').bounding_box()
        px, py = box['x'] + box['width'] / 2, (box['y'] + list_box['y'] + list_box['height']) / 2
        await page.mouse.move(px, py, steps=3)
        await page.mouse.click(px, py)
        await settle(page, 900)
        whole = await page.evaluate('() => window.__chk.selectedCardWhole()')
        res.check(f'{area}: clicking the selected card when it is partly hidden shows it whole',
                  part and not part['whole'] and whole and whole['whole'] and await state(page, 's.currentPath.id') == sel,
                  f'before {part}, after {whole}')
        await page.mouse.move(panel['x'] + 20, panel['y'] + 20)
        await settle(page, 200)

    # ---- click near a route shows it; nothing is filtered or sent
    if want('click'):
        sent.clear()
        before = await state(page, '{ id: s.currentPath.id, sel: s.selections.length }')
        spot = await page.evaluate('() => window.__chk.otherRouteSpot(40)')
        if spot is None:
            res.check(f'{area}: click near another route shows it', False, 'no separate route to click')
        else:
            await page.mouse.click(spot['x'], spot['y'] + 10)
            await settle(page, 350)
            near = await page.evaluate('([x, y]) => window.__chk.routesNear(x, y, 24)', [spot['x'], spot['y'] + 10])
            after = await state(page, '{ id: s.currentPath.id, sel: s.selections.length }')
            res.check(f'{area}: click 10 px from another route shows it',
                      after['id'] != before['id'] and after['id'] in near, f'{len(near)} routes there')
            res.check(f'{area}: the click added no pin or filter', after['sel'] == before['sel'])
            if len(near) >= 2:
                await page.mouse.click(spot['x'], spot['y'] + 10)
                await settle(page, 350)
                again = await state(page, 's.currentPath.id')
                res.check(f'{area}: clicking again cycles to another route there',
                          again != after['id'] and again in near)
            zoom = await page.evaluate('() => window.__loopMap.getZoom()')
            await page.mouse.dblclick(spot['x'], spot['y'] + 10)
            await settle(page, 600)
            res.check(f'{area}: quick clicks on routes never zoom',
                      await page.evaluate('() => window.__loopMap.getZoom()') == zoom
                      and await state(page, 's.selections.length') == before['sel'])
            await shot('click')
        spot = await page.evaluate('() => window.__chk.emptySpot(70)')
        if spot:
            cur = await state(page, 's.currentPath.id')
            await page.mouse.click(spot['x'], spot['y'])
            await settle(page, 350)
            res.check(f'{area}: a click away from routes changes nothing',
                      await state(page, 's.currentPath.id') == cur
                      and await state(page, 's.selections.length') == before['sel'])
        res.check(f'{area}: clicks sent nothing to the server', not any(m in sent for m in (
            'CONTINUE_GENERATION', 'START_GENERATION')), ', '.join(sorted(set(sent))) or 'nothing')

    # ---- Road tool: paint, clear in either mode, double-click to remove in pan
    if want('road_tool'):
        p = await page.evaluate('() => window.__chk.visibleOnRoute(30)')
        await page.keyboard.press('r')
        await page.mouse.move(p['x'], p['y'] + 8)
        await settle(page, 120)
        sent.clear()
        await page.mouse.click(p['x'], p['y'] + 8)
        await settle(page, 200)
        sel = await state(page, 's.selections.map((x) => x.type)')
        res.check(f'{area}: road tool click paints green', sel == ['include'], str(sel))
        # Advanced "Find more routes when I add a road or area to include" is off by default
        await settle(page, 800)
        res.check(f'{area}: painting green asks for no routes (the option is off by default)',
                  'CONTINUE_GENERATION' not in sent and not await state(page, 's.isGenerating'),
                  ', '.join(sorted(set(sent))) or 'nothing')
        await page.keyboard.press('m')
        await settle(page, 300)
        res.check(f'{area}: ...M asks for routes through it', sent.count('CONTINUE_GENERATION') == 1,
                  f"{sent.count('CONTINUE_GENERATION')} requests")
        await wait_state(page, '!s.isGenerating', 60000)
        await page.keyboard.press('d')  # exclude mode
        await page.mouse.click(p['x'], p['y'] + 8)
        await settle(page, 200)
        sel = await state(page, 's.selections.length')
        res.check(f'{area}: clicking a green road in exclude mode clears it', sel == 0, f'{sel} selections')
        sent.clear()
        await page.mouse.click(p['x'], p['y'] + 8)
        await settle(page, 200)
        sel = await state(page, 's.selections.map((x) => x.type)')
        res.check(f'{area}: exclude mode paints red', sel == ['exclude'], str(sel))
        res.check(f'{area}: painting red asks for no routes', 'CONTINUE_GENERATION' not in sent)
        await page.keyboard.press('d')
        await page.mouse.click(p['x'], p['y'] + 8)
        await settle(page, 200)
        res.check(f'{area}: clicking a red road in include mode clears it', await state(page, 's.selections.length') == 0)
        # paint a whole road (Ctrl) red, then double-click it in pan mode
        await page.keyboard.down('Control')
        await page.keyboard.down('Shift')
        await page.mouse.click(p['x'], p['y'] + 8)
        await page.keyboard.up('Shift')
        await page.keyboard.up('Control')
        await settle(page, 200)
        kinds = await state(page, 's.selections.map((x) => x.kind)')
        res.check(f'{area}: Ctrl+Shift click paints a whole road red', kinds == ['road'], str(kinds))
        await page.keyboard.press('k')
        view = await page.evaluate('() => { const m = window.__loopMap; const c = m.getCenter(); return { lat: c.lat, lng: c.lng, zoom: m.getZoom() }; }')
        zoom = view['zoom']
        await page.mouse.dblclick(p['x'], p['y'] + 8)
        await settle(page, 500)
        res.check(f'{area}: double-click a painted road in pan mode removes the whole road',
                  await state(page, 's.selections.length') == 0)
        res.check(f'{area}: ...without zooming', await page.evaluate('() => window.__loopMap.getZoom()') == zoom)
        spot = await page.evaluate('() => window.__chk.emptySpot(40)')
        if spot:
            await page.mouse.dblclick(spot['x'], spot['y'])
            await settle(page, 600)
            res.check(f'{area}: double-click elsewhere does not zoom',
                      await page.evaluate('() => window.__loopMap.getZoom()') == zoom)
            await page.evaluate('(v) => { window.__loopMap.setView([v.lat, v.lng], v.zoom, { animate: false }); }', view)
            await settle(page, 300)

    # ---- excluded area: dotted outline, roads shown only with the Road tool inside it
    if want('areas'):
        p = await page.evaluate('() => window.__chk.visibleOnRoute(70)')
        await page.keyboard.press('b')
        await page.keyboard.press('d')
        await page.mouse.move(p['x'] - 45, p['y'] - 45)
        await page.mouse.down()
        await page.mouse.move(p['x'] + 45, p['y'] + 45, steps=8)
        await page.mouse.up()
        await page.keyboard.press('d')
        await settle(page, 300)
        sels = await state(page, 's.selections.map((x) => ({ kind: x.kind, keys: (x.keys || []).length, outline: !!x.outline }))')
        res.check(f'{area}: an excluded box becomes one area with its outline',
                  len(sels) == 1 and sels[0]['kind'] == 'area' and sels[0]['outline'] and sels[0]['keys'] > 0, str(sels))
        paths = await page.evaluate('() => window.__chk.toolsPaths()')
        solid_red = [x for x in paths if x['stroke'] == RED and not x['dash']]
        dotted_red = [x for x in paths if x['stroke'] == RED and x['dash']]
        res.check(f'{area}: it is drawn as a dotted red outline, not red roads',
                  len(dotted_red) == 1 and not solid_red, f'{len(dotted_red)} dotted, {len(solid_red)} solid')
        await shot('excluded_area')
        await page.keyboard.press('r')
        await settle(page, 100)
        await page.mouse.move(p['x'] + 3, p['y'] + 3, steps=3)
        revealed = False
        # (late in a long run the page can be slow: the pointer moves once more before giving up)
        for nudge in (0, 1):
            if nudge:
                await page.mouse.move(p['x'] + 4, p['y'] + 4, steps=2)
            try:
                await page.wait_for_function(
                    '(red) => window.__chk.toolsPaths().some((x) => x.stroke === red && !x.dash)', arg=RED, timeout=4000)
                revealed = True
                break
            except Exception:
                pass
        if not revealed:
            await shot('area_not_revealed')
        res.check(f'{area}: Road tool inside the area shows its red roads', revealed)
        await shot('area_revealed')
        keys_before = sels[0]['keys']
        await page.mouse.click(p['x'], p['y'])
        await settle(page, 250)
        keys_after = await state(page, 's.selections[0].keys.length')
        res.check(f'{area}: clicking a road inside turns it back on', keys_after < keys_before,
                  f'{keys_before} -> {keys_after} red roads')
        await page.mouse.click(p['x'], p['y'])
        await settle(page, 250)
        res.check(f'{area}: clicking it again excludes it again',
                  await state(page, 's.selections[0].keys.length') == keys_before)
        spot = await page.evaluate('() => window.__chk.emptySpot(120)')
        if spot:
            await page.mouse.move(spot['x'], spot['y'], steps=4)
            try:  # (late in a long run the page can be slow to redraw)
                await page.wait_for_function(
                    '(red) => !window.__chk.toolsPaths().some((x) => x.stroke === red && !x.dash)', arg=RED, timeout=4000)
            except Exception:
                pass
            paths = await page.evaluate('() => window.__chk.toolsPaths()')
            res.check(f'{area}: leaving the area hides its roads again',
                      not any(x['stroke'] == RED and not x['dash'] for x in paths))
        # "Painted roads & areas" off: hidden in pan mode, back with a tool, not removable hidden
        await page.keyboard.press('k')
        await toggle_view_option(page, 'Painted roads & areas')
        if spot:
            await page.mouse.move(spot['x'], spot['y'])
        await settle(page, 200)
        dotted = lambda paths: [x for x in paths if x['stroke'] == RED and x['dash']]
        res.check(f'{area}: switched off, painted roads and areas are hidden in pan mode',
                  not dotted(await page.evaluate('() => window.__chk.toolsPaths()')))
        summary = await page.locator('.tools__summary').inner_text()
        res.check(f'{area}: ...the tools summary says they are hidden', 'hidden' in summary, summary)
        await page.mouse.dblclick(p['x'] + 45, p['y'])
        await settle(page, 500)
        res.check(f'{area}: ...a hidden area cannot be double-clicked away',
                  await state(page, 's.selections.length') == 1)
        await page.keyboard.press('r')
        await settle(page, 200)
        res.check(f'{area}: ...a tool shows them again',
                  len(dotted(await page.evaluate('() => window.__chk.toolsPaths()'))) == 1)
        await page.keyboard.press('k')
        await settle(page, 200)
        res.check(f'{area}: ...and back in pan mode they hide again',
                  not dotted(await page.evaluate('() => window.__chk.toolsPaths()')))
        await toggle_view_option(page, 'Painted roads & areas')
        await settle(page, 200)
        res.check(f'{area}: switched on again, they are shown in pan mode',
                  len(dotted(await page.evaluate('() => window.__chk.toolsPaths()'))) == 1)

        await page.keyboard.press('k')
        await page.mouse.dblclick(p['x'] + 45, p['y'])  # on the right edge of the box
        await settle(page, 500)
        res.check(f'{area}: double-click the outline removes the area', await state(page, 's.selections.length') == 0)

        # include area (green dotted) with a red road inside it
        await page.keyboard.press('c')
        await page.mouse.move(p['x'], p['y'])
        sent.clear()
        await page.mouse.down()
        await page.mouse.move(p['x'] + 60, p['y'], steps=8)
        await page.mouse.up()
        await settle(page, 800)
        res.check(f'{area}: drawing an include area asks for no routes (the option is off by default)',
                  'CONTINUE_GENERATION' not in sent and not await state(page, 's.isGenerating'),
                  ', '.join(sorted(set(sent))) or 'nothing')
        paths = await page.evaluate('() => window.__chk.toolsPaths()')
        green = [x for x in paths if x['stroke'] == GREEN_AREA and x['dash']]
        res.check(f'{area}: an include area is a dotted green outline', len(green) == 1)
        await page.keyboard.press('r')
        await page.mouse.move(p['x'] + 2, p['y'] + 2)
        await settle(page, 150)
        await page.keyboard.down('Shift')
        await page.mouse.click(p['x'], p['y'])
        await page.keyboard.up('Shift')
        await settle(page, 250)
        types = await state(page, 's.selections.map((x) => x.type + ":" + x.shape)')
        res.check(f'{area}: a red road can go inside a green area',
                  sorted(types) == ['exclude:edges', 'include:circle'], str(types))
        paths = await page.evaluate('() => window.__chk.toolsPaths()')
        green = [x for x in paths if x['stroke'] == GREEN_AREA and x['dash']]
        res.check(f'{area}: the green outline keeps its full strength',
                  len(green) == 1 and float(green[0]['opacity']) >= 0.9, str(green))
        bad = await state(page, """s.paths.filter((p) => {
            const prof = p.properties.elevation_profile;
            const c = s.selections.find((x) => x.shape === 'circle');
            const inside = prof.some((r) => Math.hypot((r[2] - c.lat) * 111320, (r[3] - c.lng) * 111320 * Math.cos(c.lat * Math.PI / 180)) <= c.radiusM);
            return !inside;
        }).length""")
        res.check(f'{area}: every listed route enters the green area', bad == 0, f'{bad} do not')
        await shot('include_area')
        await page.keyboard.press('k')
        await page.keyboard.press('Escape')

    # ---- favorite routes
    if want('favorites'):
        await favorites_checks(page, area, res, shot)

    # ---- a start at the end of a dead-end street
    if want('dead_end'):
        await dead_end_checks(page, area, res, shot)

    # ---- generations that share a start
    if want('sets'):
        await sets_checks(page, area, res, shot, received)

    # ---- the start pins while planning: hover, click, chips, the Favorites switch
    if want('pins'):
        await pins_checks(page, area, res, shot)

    # ---- a custom search boundary
    if want('boundary'):
        await boundary_checks(page, area, res, shot)

    # ---- back to the plan: Your loops in its own box
    if want('sidebar'):
        if await state(page, 's.mode') == 'display':
            await page.get_by_role('button', name='Back').click()
        await settle(page, 300)
        made = received.count('PATHSET_CREATED')
        rows = await page.locator('.gen-list__row').count()
        res.check(f'{area}: Your loops lists every generation', rows == made, f'{rows} of {made}')
        fit = await page.evaluate('() => window.__chk.panelFits()')
        res.check(f'{area}: plan with Your loops fits', fit['fits'], str(fit))
        await shot('plan_with_loops')


async def list_browsers(async_playwright, explicit):
    """--list-browsers: every candidate, in the order tried, and whether it starts."""
    print('Browsers the check tries, in order:')
    first = None
    async with async_playwright() as pw:
        for label, options in browser_candidates(explicit):
            try:
                browser = await pw.chromium.launch(headless=True, **options)
                status = f'starts ({browser.version})'
                await browser.close()
                first = first or label
            except Exception as exc:
                status = 'no: ' + str(exc).strip().splitlines()[0][:100]
            print(f'  {label}\n      {status}')
    print(f'\nThe check will use: {first}' if first else '\nNone starts. See TESTING.md ("A browser for the check").')
    return 0 if first else 2


async def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--area', choices=['rural', 'city', 'both'], default='both')
    ap.add_argument('--only', default='', help='comma-separated sections: offline_map, sidebar, hover, click, road_tool, areas, favorites, dead_end, sets, pins, boundary')
    ap.add_argument('--headed', action='store_true', help='show the browser')
    ap.add_argument('--browser', default=os.environ.get('CHECK_BROWSER'), help='path to a Chrome / Chromium binary')
    ap.add_argument('--list-browsers', action='store_true', help='show the browsers the check can find, and whether they start')
    args = ap.parse_args()
    only = {s.strip() for s in args.only.split(',') if s.strip()}

    try:
        from playwright.async_api import async_playwright
    except ImportError:
        in_venv = sys.prefix != getattr(sys, 'base_prefix', sys.prefix)
        print('Playwright is not installed for this Python (%s).' % sys.executable)
        if not in_venv:
            print('Run the check with the project\'s virtual environment, e.g. ../venv/bin/python tools/check_frontend.py')
        print('Setting it up is described in TESTING.md.')
        return 2
    if args.list_browsers:
        return await list_browsers(async_playwright, args.browser)

    os.makedirs(OUT, exist_ok=True)
    try:
        procs = start_servers(OUT)
    except RuntimeError as exc:
        print(f'Could not start the app: {exc}. Logs: {OUT}')
        return 2
    # Killed (not Ctrl-C): still stop both servers on the way out.
    import signal
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(1)))
    res = Results()
    try:
        async with async_playwright() as pw:
            try:
                browser = await launch_browser(pw, not args.headed, args.browser)
            except RuntimeError as exc:
                print(exc)
                return 2
            areas = ['rural', 'city'] if args.area == 'both' else [args.area]
            for area in areas:
                context = await browser.new_context(viewport={'width': 1400, 'height': 900})
                page = await context.new_page()
                sent, received = [], []

                def message_type(payload):
                    if isinstance(payload, str) and payload.startswith('{"type": "'):
                        return payload[10:payload.index('"', 10)]
                    if isinstance(payload, str) and payload.startswith('{'):
                        try:
                            return json.loads(payload).get('type')
                        except ValueError:
                            return ''
                    return ''

                FRAMES.clear()

                def watch(ws):
                    def on_sent(payload):
                        sent.append(message_type(payload))
                        FRAMES.append((time.time(), 'sent', sent[-1]))

                    def on_received(payload):
                        received.append(message_type(payload))
                        FRAMES.append((time.time(), 'received', received[-1]))
                    ws.on('framesent', on_sent)
                    ws.on('framereceived', on_received)
                page.on('websocket', watch)
                errors = []
                page.on('pageerror', lambda e: errors.append(str(e)))
                try:
                    await run_area(page, area, res, only, sent, received)
                except Exception as exc:  # a step timed out or the page broke
                    res.check(f'{area}: scenario ran to the end', False, f'{type(exc).__name__}: {exc}'.splitlines()[0])
                    await page.screenshot(path=os.path.join(OUT, f'{area}_error.png'))
                res.check(f'{area}: no page errors', not errors, '; '.join(errors[:3]))
                await context.close()
            await browser.close()
    finally:
        stop_servers(procs)

    print(f'\n{len(res.rows) - len(res.failed)} passed, {len(res.failed)} failed. Screenshots: {OUT}')
    return 1 if res.failed else 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
