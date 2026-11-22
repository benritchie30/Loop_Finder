"""
How long the UI takes to respond with many routes on the map: the main thread's
CPU time (Chrome's ThreadTime: scripts, layout, painting; unlike the tasks' wall
time it does not grow when other programs share the CPU) of each step, in
the real app in headless Chromium, with the same backend as check_frontend.py
(ports 8799 / 5199, the bundled map tiles, no downloads). Timed on the
production build (what the deployed site serves, built with VITE_EXPOSE_STATE=1
into bench_out/ui_dist and served by `vite preview`) and on the Vite dev server
(`npm run dev`: React's development build, several times slower); --ui picks one.
Headless Chromium has no GPU; by default it gets one in software (SwiftShader),
so canvases are handled off the main thread as on a machine with a GPU.
--no-gpu times a machine without one (every map canvas copied on each frame).

Steps timed, each many times after a few untimed ones (the mean, median, 90th
percentile and worst are printed):
  - the route view of one large generation: the next route (arrow key), and
    the pointer moving from one route card to another (a map preview);
  - the plan: the pointer coming onto the generation's start pin (its routes
    previewed on the map, the other pins hidden) after leaving it.

The routes are made once, by the app (Charlotte, the city area of the checks),
and kept in backend/bench_out/ui_bench_routes.json, so runs before and after a
change measure the same routes. --fresh makes them again.

    python tools/bench_ui.py                      # 240 routes, 150 of them favorites
    python tools/bench_ui.py --routes 300 --favorites 200 --steps 40
    python tools/bench_ui.py --label after --json bench_out/after.json
    python tools/bench_ui.py --profile             # also the functions that take the time, per step
    python tools/bench_ui.py --trace               # also the browser's own work (paint, canvas...), per step

BENCH_NO_MINIFY=1 builds the production UI unminified (readable names in --profile);
BENCH_VERBOSE=1 prints each step as it runs.
"""
import argparse
import asyncio
import json
import os
import shutil
import statistics
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import check_frontend as cf  # noqa: E402  (servers, browser, page helpers)

DATA = os.path.join(cf.BACKEND, 'bench_out', 'ui_bench_routes.json')
DIST = os.path.join(cf.BACKEND, 'bench_out', 'ui_dist')
CITY = cf.AREAS['city']
SETTLE_MS = 350  # after a step: long enough for React, effects and the canvas frame


def start_servers(ui):
    """The backend and the UI: 'dev' (the Vite dev server) or 'prod' (a production build, served)."""
    for port in (cf.WS_PORT, cf.UI_PORT):
        if cf._port_open(port):
            raise RuntimeError(f'port {port} is busy (a check still running?)')
    npx = shutil.which('npx') or shutil.which('npx.cmd')
    ui_env = dict(os.environ, VITE_WS_URL=f'ws://localhost:{cf.WS_PORT}', VITE_GEOCODER_URL='http://127.0.0.1:9',
                  VITE_EXPOSE_STATE='1', LOOP_PORT=str(cf.WS_PORT))
    log = open(os.path.join(cf.OUT, f'bench_{ui}.log'), 'w')
    if ui == 'prod':
        print('Building the UI (production)...')
        subprocess.run([npx, 'vite', 'build', '--outDir', DIST, '--emptyOutDir', '--logLevel', 'warn'] + (['--minify', 'false'] if os.environ.get('BENCH_NO_MINIFY') else []),
                       cwd=cf.UI, env=ui_env, check=True, stdout=log, stderr=subprocess.STDOUT)
        cmd = [npx, 'vite', 'preview', '--outDir', DIST, '--port', str(cf.UI_PORT), '--strictPort']
    else:
        cmd = [npx, 'vite', '--port', str(cf.UI_PORT), '--strictPort']
    env = dict(os.environ, LOOP_PORT=str(cf.WS_PORT), OVERPASS_URL='http://127.0.0.1:9/', PYTHONUNBUFFERED='1')
    backend = subprocess.Popen([sys.executable, 'server.py'], cwd=cf.BACKEND, env=env,
                               stdout=log, stderr=subprocess.STDOUT)
    group = ({'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == 'nt' else {'start_new_session': True})
    front = subprocess.Popen(cmd, cwd=cf.UI, env=ui_env, stdout=log, stderr=subprocess.STDOUT, **group)
    try:
        cf._wait(lambda: cf._port_open(cf.WS_PORT), 30, 'the backend')
        cf._wait(lambda: cf._http_ok(f'http://localhost:{cf.UI_PORT}/'), 60, 'the UI server')
    except Exception:
        cf.stop_servers([backend, front])
        raise
    return [backend, front]


PARTS = ('ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration')
BREAKDOWN = {}  # step name -> {part: [ms per step]}


async def task_ms(cdp, parts=None):
    metrics = {m['name']: m['value'] for m in (await cdp.send('Performance.getMetrics'))['metrics']}
    if parts is not None:
        parts.update({p: 1000 * metrics.get(p, 0.0) for p in PARTS})
    return 1000 * metrics['ThreadTime']  # CPU time of the page's main thread


PROFILE = {'on': False, 'tops': {}, 'trace': False, 'browser': None}


def trace_self_times(trace, n=12):
    """[(ms, event name)] with the most self time on the page's main thread (nested events not counted twice)."""
    events = trace.get('traceEvents', trace) if isinstance(trace, dict) else trace
    main = {(e['pid'], e['tid']) for e in events
            if e.get('name') == 'thread_name' and e.get('args', {}).get('name') == 'CrRendererMain'}
    by_thread = {}
    for e in events:
        if e.get('ph') == 'X' and (e['pid'], e['tid']) in main and 'dur' in e:
            by_thread.setdefault((e['pid'], e['tid']), []).append(e)
    totals = {}
    for evs in by_thread.values():
        evs.sort(key=lambda e: (e['ts'], -e['dur']))
        stack = []  # [end, event, child time]
        def close(item):
            own = item[1]['dur'] - item[2]
            totals[item[1]['name']] = totals.get(item[1]['name'], 0) + own / 1000
        for e in evs:
            while stack and stack[-1][0] <= e['ts']:
                close(stack.pop())
            if stack:
                stack[-1][2] += e['dur']
            stack.append([e['ts'] + e['dur'], e, 0])
        while stack:
            close(stack.pop())
    return sorted(((ms, k) for k, ms in totals.items()), reverse=True)[:n]


def top_functions(profile, n=10):
    """[(ms, 'function file:line')] with the most self time in a CPU profile."""
    nodes = {node['id']: node for node in profile['nodes']}
    self_us = {}
    samples, deltas = profile.get('samples', []), profile.get('timeDeltas', [])
    for sid, dt in zip(samples, deltas):
        self_us[sid] = self_us.get(sid, 0) + dt
    by_name = {}
    for sid, us in self_us.items():
        f = nodes[sid]['callFrame']
        if f['functionName'] in ('(idle)', '(root)'):
            continue
        where = os.path.basename(f['url'].split('?')[0]) or '-'
        key = f"{f['functionName'] or '(anonymous)'} {where}:{f['lineNumber'] + 1}"
        by_name[key] = by_name.get(key, 0) + us / 1000
    return sorted(((ms, k) for k, ms in by_name.items()), reverse=True)[:n]


async def measure(page, cdp, steps, act, name=''):
    """Main-thread CPU ms of each of `steps` runs of `act(i)` (idle time subtracted), after 3 untimed ones."""
    for i in range(3):  # warm up: the first runs compile code and set up the GPU's canvases
        await act(i)
        await page.wait_for_timeout(SETTLE_MS)
    if PROFILE['trace'] and PROFILE['browser']:
        path = os.path.join(cf.OUT, 'bench_trace.json')
        await PROFILE['browser'].start_tracing(page=page, path=path, categories=[
            'devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'cc', 'gpu'])
        for i in range(min(steps, 8)):
            await act(i)
            await page.wait_for_timeout(SETTLE_MS)
        await PROFILE['browser'].stop_tracing()
        with open(path) as f:
            PROFILE['tops'][name + ' (trace)'] = [(ms / min(steps, 8), k) for ms, k in trace_self_times(json.load(f))]
    if PROFILE['on']:
        await cdp.send('Profiler.enable')
        await cdp.send('Profiler.setSamplingInterval', {'interval': 200})
        await cdp.send('Profiler.start')
        for i in range(min(steps, 8)):
            await act(i)
            await page.wait_for_timeout(SETTLE_MS)
        prof = (await cdp.send('Profiler.stop'))['profile']
        PROFILE['tops'][name] = [(ms / min(steps, 8), k) for ms, k in top_functions(prof)]
    idle = []
    for _ in range(5):
        t0 = await task_ms(cdp)
        await page.wait_for_timeout(SETTLE_MS)
        idle.append(await task_ms(cdp) - t0)
    base = statistics.median(idle)
    out = []
    split = BREAKDOWN.setdefault(name, {p: [] for p in PARTS})
    for i in range(steps):
        if os.environ.get('BENCH_VERBOSE'):
            print(f'    {name} {i + 1}/{steps}', flush=True)
        before, after = {}, {}
        t0 = await task_ms(cdp, before)
        await act(i)
        await page.wait_for_timeout(SETTLE_MS)
        out.append(max(0.0, await task_ms(cdp, after) - t0 - base))
        for p in PARTS:
            split[p].append(after[p] - before[p])
    return out


def summary(values):
    values = sorted(values)
    p90 = values[min(len(values) - 1, int(round(0.9 * (len(values) - 1))))]
    return {'mean': statistics.mean(values), 'p90': p90, 'max': values[-1], 'n': len(values)}


async def make_routes(browser, want):
    """A large generation, made by the app: a first batch of 200, then More routes."""
    context = await browser.new_context(viewport={'width': 1400, 'height': 900})
    page = await context.new_page()
    await page.goto(f'http://localhost:{cf.UI_PORT}/')
    await page.evaluate("""([lat, lng, zoom, lo, hi]) => {
        localStorage.setItem('lastMapPosition', JSON.stringify({ center: [lat, lng], zoom }));
        localStorage.setItem('generatorSettings', JSON.stringify({ min_path_len: lo, max_path_len: hi,
            num_paths: 200, routes_per_pin: 100 }));
    }""", [CITY['lat'], CITY['lng'], CITY['zoom'], CITY['min'], CITY['max']])
    await page.reload()
    await cf.wait_state(page, 'true', 30000)
    await cf.helpers(page)
    pt = await page.evaluate('([a, b]) => window.__chk.screen(a, b)', [CITY['lat'], CITY['lng']])
    await page.mouse.click(pt['x'], pt['y'])
    await page.get_by_text('Map ready').wait_for(timeout=120000)
    await page.get_by_role('button', name='Find loops').click()
    print('Making routes (a first batch, then More routes until there are enough)...')
    await cf.wait_state(page, "s.mode === 'display' && s.totalCount > 0 && !s.isGenerating", 600000)
    while True:
        n = await cf.state(page, 's.totalCount')
        print(f'  {n} routes')
        if n >= want:
            break
        await page.keyboard.press('m')
        await page.wait_for_timeout(800)
        await cf.wait_state(page, '!s.isGenerating', 600000)
        if await cf.state(page, 's.totalCount') == n:
            print('  no more routes there')
            break
    record = await page.evaluate("""() => { const id = window.__loopState.activePathSetId; const s = window.__pathSets[id];
        return { id, name: 'Bench', createdAt: s.createdAt, markerPosition: s.markerPosition, settings: s.settings,
                 selections: [], paths: s.paths, batches: s.batches || 1, lastNote: null }; }""")
    await context.close()
    os.makedirs(os.path.dirname(DATA), exist_ok=True)
    with open(DATA, 'w') as f:
        json.dump(record, f)
    return record


async def run(browser, record, n_routes, n_favs, steps):
    record = dict(record, paths=record['paths'][:n_routes])
    context = await browser.new_context(viewport={'width': 1400, 'height': 900})
    page = await context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    await page.goto(f'http://localhost:{cf.UI_PORT}/')
    start = record['markerPosition']
    await page.evaluate("""([rec, nFav, lat, lng, spread]) => new Promise((done) => {
        // --spread: each favorite moved a little (its own roads, as favorites from many places)
        const moved = (path, i) => (!spread ? path : { ...path, geometry: { ...path.geometry,
          coordinates: path.geometry.coordinates.map(([x, y]) => [x + (i % 12) * 0.0011, y + Math.floor(i / 12) * 0.0009]) } });
        localStorage.setItem('lastMapPosition', JSON.stringify({ center: [lat, lng], zoom: 13 }));
        const open = indexedDB.open('loop-finder', 3);
        open.onupgradeneeded = () => { const db = open.result;
          ['generations', 'generationHeads'].forEach((n) => db.objectStoreNames.contains(n) || db.createObjectStore(n, { keyPath: 'id' }));
          if (!db.objectStoreNames.contains('favorites')) db.createObjectStore('favorites', { keyPath: 'key' }); };
        open.onsuccess = () => {
          const tx = open.result.transaction(['generations', 'favorites'], 'readwrite');
          tx.objectStore('generations').put(rec);
          rec.paths.slice(0, nFav).map(moved).forEach((path, i) => tx.objectStore('favorites').put({
            key: window.__routeKey(path), path, pathSetId: rec.id, setName: rec.name, start: rec.markerPosition, createdAt: 1000 + i }));
          tx.oncomplete = () => done();
        };
    })""", [record, n_favs, start['lat'], start['lng'], PROFILE.get('spread', False)])
    await page.reload()
    await cf.wait_state(page, 's.generations.length === 1 && s.favoriteCount > 0', 90000)
    cdp = await context.new_cdp_session(page)
    await cdp.send('Performance.enable')
    results = {}

    # ---- the route view of the large generation
    await page.locator('.gen-list__open').first.click()
    await cf.wait_state(page, "s.mode === 'display' && s.totalCount > 0", 10000)
    await page.wait_for_timeout(2500)  # its area loads, roads drawn
    n = await cf.state(page, 's.totalCount')
    pts = await page.evaluate('() => window.__loopState.paths.reduce((a, p) => a + p.geometry.coordinates.length, 0)')
    print(f'Route view: {n} routes, {pts:,} points')
    panel = await page.locator('.control-panel').bounding_box()
    await page.mouse.move(panel['x'] - 300, panel['y'] + 300)  # the pointer off the list
    name = 'next route (arrow key)'
    results[name] = await measure(page, cdp, steps, lambda i: page.keyboard.press('ArrowDown'), name)

    async def hover_card(i):
        # the two cards after the selected one (the list keeps it in view)
        cards = page.locator('.route-card.is-selected ~ .route-card')
        box = await cards.nth(i % 2).bounding_box()
        await page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2 + (i % 3))
    name = 'route card under the pointer'
    results[name] = await measure(page, cdp, steps, hover_card, name)
    previewed = await cf.state(page, 's.hoveredPathId')
    await page.mouse.move(panel['x'] - 300, panel['y'] + 300)
    await page.wait_for_timeout(300)

    # ---- the plan: the start pin under the pointer previews its routes
    await page.keyboard.press('Backspace')
    await cf.wait_state(page, "s.mode === 'input'", 5000)
    await page.wait_for_timeout(800)
    pbox = await page.locator('.leaflet-marker-icon.custom-marker-icon').first.bounding_box()
    pin_at = (pbox['x'] + pbox['width'] / 2, pbox['y'] + pbox['height'] / 2)

    async def hover_pin(i):
        await page.mouse.move(pin_at[0] - 200, pin_at[1] + 120)  # off it: the preview ends
        await page.wait_for_timeout(60)
        await page.mouse.move(pin_at[0], pin_at[1] + (i % 3))  # onto it: previewed after a short rest
    name = 'start pin under the pointer (its routes previewed)'
    results[name] = await measure(page, cdp, steps, hover_pin, name)

    await context.close()
    if errors:
        print('Page errors:', *errors[:3], sep='\n  ')
    if not previewed:
        print('Note: no route card was previewed (the pointer missed the cards).')
    return results, {'routes': n, 'points': pts}


async def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--routes', type=int, default=240, help='routes in the generation (default 240)')
    ap.add_argument('--favorites', type=int, default=150, help='how many of them are favorites (default 150)')
    ap.add_argument('--steps', type=int, default=30, help='times each step is timed (default 30)')
    ap.add_argument('--fresh', action='store_true', help='make the routes again')
    ap.add_argument('--label', default='', help='a name for this run in the output')
    ap.add_argument('--json', default='', help='also write the results to this file')
    ap.add_argument('--ui', choices=['prod', 'dev', 'both'], default='both',
                    help='the production build, the Vite dev server, or both (default)')
    ap.add_argument('--no-gpu', dest='gpu', action='store_false',
                    help='no GPU: canvases composited on the main thread, as on a machine without GPU acceleration '
                         '(default: a software GPU, SwiftShader, so canvases are handled as on a machine with a GPU)')
    ap.add_argument('--spread', action='store_true',
                    help='move each favorite a little, so no two share a road (as favorites from many places)')
    ap.add_argument('--profile', action='store_true', help='also print the functions that take the time, per step')
    ap.add_argument('--trace', action='store_true', help='also print what the browser spends the time on (paint, layout...), per step')
    ap.add_argument('--browser', default=os.environ.get('CHECK_BROWSER'), help='path to a Chrome / Chromium binary')
    args = ap.parse_args()
    PROFILE['on'] = args.profile
    PROFILE['trace'] = args.trace
    PROFILE['spread'] = args.spread
    from playwright.async_api import async_playwright

    os.makedirs(cf.OUT, exist_ok=True)
    uis = ['prod', 'dev'] if args.ui == 'both' else [args.ui]
    out = {'label': args.label, 'favorites': args.favorites}
    for ui in uis:
        procs = start_servers(ui)
        PROFILE['tops'] = {}
        try:
            async with async_playwright() as pw:
                if args.gpu:
                    # A GPU in software (SwiftShader): canvases are drawn and composited the way
                    # Chrome does on a machine with a GPU, off the page's main thread. The same
                    # browsers as the browser check, in its order.
                    browser = None
                    for label, options in cf.browser_candidates(args.browser):
                        try:
                            browser = await pw.chromium.launch(headless=True, args=[
                                '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
                                '--enable-gpu-rasterization'], **options)
                            print(f'Browser: {label} ({browser.version}), software GPU')
                            break
                        except Exception:
                            continue
                    if browser is None:
                        raise RuntimeError('No browser could be started (python tools/check_frontend.py --list-browsers)')
                else:
                    browser = await cf.launch_browser(pw, True, args.browser)
                PROFILE['browser'] = browser
                record = None
                if os.path.exists(DATA) and not args.fresh:
                    with open(DATA) as f:
                        record = json.load(f)
                    if len(record['paths']) < args.routes:
                        record = None
                if record is None:
                    record = await make_routes(browser, args.routes)
                    args.fresh = False
                results, size = await run(browser, record, args.routes, args.favorites, args.steps)
                await browser.close()
        finally:
            cf.stop_servers(procs)

        what = ('production build' if ui == 'prod' else 'dev server') + ('' if args.gpu else ', no GPU')
        title = f'UI response, {what}' + (f' ({args.label})' if args.label else '')
        print(f"\n{title}: {size['routes']} routes ({size['points']:,} points), {args.favorites} favorites; "
              f'main-thread CPU ms per step')
        print(f"  {'step':34} {'mean':>7} {'median':>7} {'p90':>7} {'max':>7}")
        table = {}
        for name, values in results.items():
            s = summary(values)
            s['median'] = statistics.median(values)
            # (script / layout / style: their tasks' wall time, for a rough split)
            s['parts'] = {p: statistics.mean(v) for p, v in BREAKDOWN.get(name, {}).items() if v}
            table[name] = s
            print(f"  {name:34} {s['mean']:7.1f} {s['median']:7.1f} {s['p90']:7.1f} {s['max']:7.1f}")
        BREAKDOWN.clear()
        for name, tops in PROFILE['tops'].items():
            print(f'\n  {name}: self time per step')
            for ms, fn in tops:
                print(f'    {ms:7.1f} ms  {fn}')
        out['size'] = size
        out[ui] = table
    if args.json:
        with open(args.json, 'w') as f:
            json.dump(out, f, indent=1)
    return 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
