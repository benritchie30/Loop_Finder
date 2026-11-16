"""Compare loop-search strategies headless: speed, quality, coverage, choice.

    cd backend
    python tools/algo_lab.py --build                      # graphs from the tiles on disk
    python tools/algo_lab.py --scen clt20 --algos tree_guided tree_triangles tree_full
    python tools/algo_lab.py --scen all --num 100 --png

Scenarios are fixed starts whose tiles are already in map_data (nothing is
downloaded). Built graphs are pickled to backend/cache/lab/.

Columns
  paths     routes sent before --num / --time
  t1 t20 tN seconds to the first, 20th and last route
  qpm       (turns + discomfort) per mile of the whole route: median / 90th pct
  ratio     loop share of the route (mean)
  round     how round the loop is: area / area of a circle of the same
            perimeter (mean; a thin out-and-back sliver is near 0)
  cells     400 m cells under the loops (area covered)
  roadmi    miles of distinct road used by the loops
  areas3    1.6 km squares crossed by the loops of at least 3 routes (choice
            within an area)
  novel     mean share of a route's loop roads no earlier route used
  sig       fingerprint of the routes in the order sent (same sig = same output)
  good      routes whose qpm is within 1.5x of the best 10 routes' median, and
            the cells / areas3 of those routes alone (what a rider would
            actually pick from)
"""
import argparse
import math
import os
import pickle
import statistics
import sys
import time

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND)

import loop_generator as lg  # noqa: E402
import loop_tree  # noqa: E402
import route_features as rf  # noqa: E402
from loop_tree import is_idle  # noqa: E402

MILE_M = 1609.34
CELL_M = 400.0
AREA_CELLS = 4  # an "area" is 4 x 4 cells
LAB_DIR = os.path.join(BACKEND, 'cache', 'lab')

# name: (lat, lng, min mi, max mi)
SCENARIOS = {
    'clt10': (35.15, -80.83, 5, 10),      # dense suburb, short
    'clt20': (35.20, -80.85, 10, 20),     # dense city, 12k nodes
    'avl28': (35.62, -82.58, 14, 28),     # mountain town
    'boone25': (36.21, -81.67, 12, 25),   # sparse rural
    'boone45': (36.21, -81.67, 20, 45),   # sparse rural, long
}


def build(name):
    from areas import tiles_needed
    from map_store import MapStore
    import graph_builder
    lat, lng, _lo, hi = SCENARIOS[name]
    store = MapStore()
    tiles = tiles_needed(lat, lng, hi * MILE_M)
    missing = [t for t in tiles if not store.has(t)]
    if missing:
        raise SystemExit(f'{name}: {len(missing)} tiles are not on disk')
    G, start, stats = graph_builder.build_graph(store.ways(tiles), lat, lng, hi * MILE_M)
    os.makedirs(LAB_DIR, exist_ok=True)
    with open(os.path.join(LAB_DIR, f'{name}.pkl'), 'wb') as f:
        pickle.dump((G, start), f)
    print(f"{name}: {stats['nodes']} nodes, {stats['edges']} edges")
    return G, start


def load(name):
    path = os.path.join(LAB_DIR, f'{name}.pkl')
    if not os.path.exists(path):
        return build(name)
    with open(path, 'rb') as f:
        return pickle.load(f)


def loop_part(E, path):
    """(walk edges of the whole route, loop edges) from a lollipop node path."""
    nodes = [n for i, n in enumerate(path) if i == 0 or n != path[i - 1]]
    walk = []
    for u, v in zip(nodes[:-1], nodes[1:]):
        e = next((e for e in E.out[u] if E.head[e] == v), None)
        if e is not None:
            walk.append(e)
    # the loop is the stretch of edges whose road is used once
    count = {}
    for e in walk:
        count[E.uid[e]] = count.get(E.uid[e], 0) + 1
    loop = [e for e in walk if count[E.uid[e]] == 1]
    return walk, loop


def roundness(E, loop):
    if len(loop) < 3:
        return 0.0
    k = E._k
    pts = [(E._xy[E.tail[e]][0] * k * 111139.0, E._xy[E.tail[e]][1] * 111139.0) for e in loop]
    area = 0.0
    for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
        area += x0 * y1 - x1 * y0
    per = sum(E.length[e] for e in loop)
    return abs(area) / 2.0 / (per * per / (4 * math.pi)) if per > 0 else 0.0


def run(G, start, algo, lo, hi, args):
    E = loop_tree.edge_table(G)
    t0 = time.perf_counter()
    gen = lg.find_paths(G, start, lo * MILE_M, hi * MILE_M, args.loop_ratio,
                        min_loop_length=600, algorithm=algo, min_dist_m=args.min_dist)
    feats, times = [], []
    try:
        for f in gen:
            if is_idle(f):
                break
            feats.append(f)
            times.append(time.perf_counter() - t0)
            if len(feats) >= args.num or times[-1] > args.time:
                break
    finally:
        gen.close()
    E.refresh_stress()

    routes = []
    for f in feats:
        p = f['properties']
        walk, loop = loop_part(E, p['_path'])
        total_mi = sum(E.length[e] for e in walk) / MILE_M
        _c, turns, disc, _s = loop_tree.score_walk(E, walk, len(walk))
        cells = set()
        for e in loop:
            cells.update(E.cells[E.uid[e]])
        routes.append({
            'key': frozenset(E.uid[e] for e in walk),
            'uids': {E.uid[e] for e in loop},
            'cells': cells,
            'areas': {(c[0] // AREA_CELLS, c[1] // AREA_CELLS) for c in cells},
            'qpm': (turns + disc) / total_mi if total_mi else 0.0,
            'ratio': p.get('loop_miles', 0) / p['total_miles'] if p.get('total_miles') else 0.0,
            'round': roundness(E, loop),
        })

    def summarize(rs):
        cells, areas = set(), {}
        for r in rs:
            cells |= r['cells']
            for a in r['areas']:
                areas[a] = areas.get(a, 0) + 1
        return len(cells), sum(1 for n in areas.values() if n >= 3)

    used, novel = set(), []
    for r in routes:
        if r['uids']:
            novel.append(len(r['uids'] - used) / len(r['uids']))
        used |= r['uids']
    qs = sorted(r['qpm'] for r in routes)
    import hashlib
    sig = hashlib.md5(repr([f['properties']['_path'] for f in feats]).encode()).hexdigest()[:6]
    row = {'algo': algo, 'paths': len(routes), 'sig': sig}
    if routes:
        bar = 1.5 * statistics.median(qs[:10])
        good = [r for r in routes if r['qpm'] <= bar]
        cells, areas3 = summarize(routes)
        g_cells, g_areas3 = summarize(good)
        row.update({
            't1': round(times[0], 1),
            't20': round(times[min(19, len(times) - 1)], 1),
            'tN': round(times[-1], 1),
            'qpm': f"{statistics.median(qs):.2f}/{qs[int(0.9 * (len(qs) - 1))]:.2f}",
            'ratio': round(statistics.mean(r['ratio'] for r in routes), 2),
            'round': round(statistics.mean(r['round'] for r in routes), 2),
            'cells': cells,
            'roadmi': round(sum(E.length[E.by_uid[u][0]] for u in used) / MILE_M, 1),
            'areas3': areas3,
            'novel': round(statistics.mean(novel), 2) if novel else 0,
            'good': f"{len(good)}:{g_cells}/{g_areas3}",
        })
    return row, feats, routes


def draw(G, feats, start, path, size=900):
    from PIL import Image, ImageDraw
    xs = [d['x'] for _, d in G.nodes(data=True)]
    ys = [d['y'] for _, d in G.nodes(data=True)]
    min_x, max_x, min_y, max_y = min(xs), max(xs), min(ys), max(ys)
    pad = 12
    k = math.cos(math.radians((min_y + max_y) / 2))
    span = max((max_x - min_x) * k, max_y - min_y) or 1e-6

    def proj(x, y):
        return (pad + (x - min_x) * k / span * (size - 2 * pad),
                pad + (max_y - y) / span * (size - 2 * pad))

    img = Image.new('RGB', (size, size), (255, 255, 255))
    dr = ImageDraw.Draw(img, 'RGBA')
    for u, v in G.edges():
        dr.line([proj(G.nodes[u]['x'], G.nodes[u]['y']), proj(G.nodes[v]['x'], G.nodes[v]['y'])],
                fill=(215, 215, 215, 255), width=1)
    for f in feats:
        pts = [proj(x, y) for x, y in f['geometry']['coordinates']]
        dr.line(pts, fill=(200, 40, 40, 70), width=2)
    sx, sy = proj(G.nodes[start]['x'], G.nodes[start]['y'])
    dr.ellipse([sx - 6, sy - 6, sx + 6, sy + 6], fill=(39, 174, 96, 255), outline=(0, 0, 0, 255))
    img.save(path)


def draw_tiles(G, feats, start, path, cols=6, rows=4, tile=220):
    """One small map per route, in the order sent."""
    from PIL import Image, ImageDraw
    xs = [d['x'] for _, d in G.nodes(data=True)]
    ys = [d['y'] for _, d in G.nodes(data=True)]
    min_x, max_x, min_y, max_y = min(xs), max(xs), min(ys), max(ys)
    k = math.cos(math.radians((min_y + max_y) / 2))
    span = max((max_x - min_x) * k, max_y - min_y) or 1e-6
    pad = 6
    step = max(1, len(feats) // (cols * rows))
    picks = feats[::step][:cols * rows]
    img = Image.new('RGB', (cols * tile, rows * tile), (255, 255, 255))
    dr = ImageDraw.Draw(img)
    base = [(G.nodes[u]['x'], G.nodes[u]['y'], G.nodes[v]['x'], G.nodes[v]['y']) for u, v in G.edges()]
    for i, f in enumerate(picks):
        ox, oy = (i % cols) * tile, (i // cols) * tile

        def proj(x, y):
            return (ox + pad + (x - min_x) * k / span * (tile - 2 * pad),
                    oy + pad + (max_y - y) / span * (tile - 2 * pad))

        for x0, y0, x1, y1 in base[::3]:
            dr.line([proj(x0, y0), proj(x1, y1)], fill=(225, 225, 225))
        dr.line([proj(x, y) for x, y in f['geometry']['coordinates']], fill=(200, 30, 30), width=2)
        sx, sy = proj(G.nodes[start]['x'], G.nodes[start]['y'])
        dr.ellipse([sx - 3, sy - 3, sx + 3, sy + 3], fill=(30, 90, 220))
        p = f['properties']
        dr.text((ox + 3, oy + 2), f"#{feats.index(f) + 1} {p['total_miles']:.1f}mi", fill=(0, 0, 0))
        dr.rectangle([ox, oy, ox + tile - 1, oy + tile - 1], outline=(150, 150, 150))
    img.save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--scen', nargs='+', default=['clt20'])
    ap.add_argument('--algos', nargs='+', default=[lg.DEFAULT_ALGORITHM])
    ap.add_argument('--num', type=int, default=60)
    ap.add_argument('--time', type=float, default=90)
    ap.add_argument('--loop-ratio', type=float, default=0.5)
    ap.add_argument('--min-dist', type=float, default=50)
    ap.add_argument('--png', action='store_true')
    ap.add_argument('--build', action='store_true')
    ap.add_argument('--quiet', action='store_true', help='hide the search logs')
    args = ap.parse_args()

    if args.build:
        for name in SCENARIOS:
            build(name)
        return

    to_geojson = rf.path_to_geojson

    def keep_path(G, path, props):
        props['_path'] = list(path)
        return to_geojson(G, path, props)

    rf.path_to_geojson = keep_path

    names = list(SCENARIOS) if args.scen == ['all'] else args.scen
    out_dir = os.path.join(BACKEND, 'bench_out')
    for name in names:
        G, start = load(name)
        _lat, _lng, lo, hi = SCENARIOS[name]
        loop_tree.edge_table(G)  # the per-graph table is not part of any strategy's time
        rows, sets = [], {}
        for algo in args.algos:
            real = sys.stdout
            if args.quiet:
                sys.stdout = open(os.devnull, 'w')
            try:
                row, feats, routes = run(G, start, algo, lo, hi, args)
            finally:
                if args.quiet:
                    sys.stdout.close()
                    sys.stdout = real
            rows.append(row)
            sets[algo] = {r['key'] for r in routes}
            if args.png and feats:
                os.makedirs(out_dir, exist_ok=True)
                draw(G, feats, start, os.path.join(out_dir, f'lab_{name}_{algo}.png'))
                draw_tiles(G, feats, start, os.path.join(out_dir, f'lab_{name}_{algo}_tiles.png'))
        print(f"\n== {name}: {G.number_of_nodes()} nodes, {lo}-{hi} mi, up to {args.num} routes / {args.time:g}s")
        keys = ['algo', 'paths', 't1', 't20', 'tN', 'qpm', 'ratio', 'round', 'cells', 'roadmi',
                'areas3', 'novel', 'good', 'sig']
        widths = {k: max(len(k), *(len(str(r.get(k, ''))) for r in rows)) for k in keys}
        print('  '.join(f'{k:>{widths[k]}}' for k in keys))
        for r in rows:
            print('  '.join(f"{str(r.get(k, '')):>{widths[k]}}" for k in keys))
        algos = list(sets)
        if len(algos) > 1:
            shared = [f"{a}&{b}: {len(sets[a] & sets[b])}" for i, a in enumerate(algos) for b in algos[i + 1:]]
            print('same route in both: ' + ', '.join(shared))


if __name__ == '__main__':
    main()
