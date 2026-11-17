"""Compiled inner loop of loop_tree.grow_tree (optional: needs numba).

The tree search is a priority-queue loop, which numpy cannot do in one
pass; here numba compiles the same loop to machine code. Same arithmetic in
the same order, and the queue pops the smallest (cost, edge) just as
heapq's tuples do, so the tree is the same as the Python loop's, state for
state. Without numba (or with LOOP_NO_NUMBA=1) `grow` is None and
loop_tree runs its own loop.

The compiled code is cached next to this file (numba's cache), so only the
first run on a machine pays the few seconds of compiling; `warm_up` does it
ahead of the first search.
"""
import os

import numpy as np

grow = None

try:
    if os.environ.get('LOOP_NO_NUMBA', '').strip().lower() in ('1', 'true', 'yes', 'on'):
        raise ImportError('switched off')
    from numba import njit
except ImportError:  # the Python loop in loop_tree does the work
    njit = None


def _grow(forward, max_len, starts, nexts, turns, length, stress, ride, steer, left,
          b_in, b_out, cost, dist, qual, par, seed_cost, seed_edge,
          crossing_max_m, crossing_cap, turn_deg):
    """Settle every state reachable from the seeds. cost / dist / qual / par
    come in holding the seeds' values and go out holding the tree's.
    Returns (done, route_hash, order).

    starts / nexts / turns: per edge e, nexts[starts[e]:starts[e + 1]] are
    the edges a route may take after e (before e, for a return tree) and
    turns says which of those steps is a turn.
    """
    n = len(length)
    done = np.zeros(n, dtype=np.uint8)
    route_hash = np.zeros(n, dtype=np.uint64)
    order = np.empty(n, dtype=np.int64)
    settled = 0

    # Binary heap of (cost, edge); an edge is pushed again when its cost
    # drops, and the stale entries are skipped when they surface.
    room = len(seed_edge) + len(nexts) + 1
    heap_c = np.empty(room, dtype=np.float64)
    heap_e = np.empty(room, dtype=np.int64)
    size = 0
    for k in range(len(seed_edge)):
        c, e = seed_cost[k], seed_edge[k]
        i = size
        size += 1
        while i > 0:
            up = (i - 1) >> 1
            if heap_c[up] < c or (heap_c[up] == c and heap_e[up] <= e):
                break
            heap_c[i], heap_e[i] = heap_c[up], heap_e[up]
            i = up
        heap_c[i], heap_e[i] = c, e

    mult = np.uint64(1000003)
    while size > 0:
        c, e = heap_c[0], heap_e[0]
        size -= 1
        if size > 0:
            lc, le = heap_c[size], heap_e[size]
            i = 0
            while True:
                child = 2 * i + 1
                if child >= size:
                    break
                right = child + 1
                if right < size and (heap_c[right] < heap_c[child]
                                     or (heap_c[right] == heap_c[child] and heap_e[right] < heap_e[child])):
                    child = right
                if lc < heap_c[child] or (lc == heap_c[child] and le <= heap_e[child]):
                    break
                heap_c[i], heap_e[i] = heap_c[child], heap_e[child]
                i = child
            heap_c[i], heap_e[i] = lc, le
        if done[e]:
            continue
        done[e] = 1
        order[settled] = e
        settled += 1
        p = par[e]
        before = route_hash[p] if p >= 0 else np.uint64(0)
        route_hash[e] = before * mult + np.uint64(e) + np.uint64(1)  # wraps at 64 bits

        d_e = dist[e]
        q_e = qual[e]
        for k in range(starts[e], starts[e + 1]):
            e2 = nexts[k]
            if done[e2]:
                continue
            nd = d_e + length[e2]
            if nd + left[e2] > max_len:
                continue
            dq = ride[e2]
            if turns[k]:
                l_e = length[e]
                s_e = stress[e]
                crossing = False
                if p >= 0 and l_e <= crossing_max_m and s_e > stress[e2] and s_e > stress[p]:
                    if forward:
                        d = abs(b_in[p] - b_out[e]) % 360.0
                    else:
                        d = abs(b_in[e] - b_out[p]) % 360.0
                    if d > 180.0:
                        d = 360.0 - d
                    crossing = d >= turn_deg
                if crossing:
                    full = s_e * l_e
                    dq -= full - min(full, crossing_cap)
                else:
                    dq += 1.0
            nc = c + dq + steer[e2]
            if nc < cost[e2]:
                cost[e2] = nc
                dist[e2] = nd
                qual[e2] = q_e + dq
                par[e2] = e
                i = size
                size += 1
                while i > 0:
                    up = (i - 1) >> 1
                    if heap_c[up] < nc or (heap_c[up] == nc and heap_e[up] <= e2):
                        break
                    heap_c[i], heap_e[i] = heap_c[up], heap_e[up]
                    i = up
                heap_c[i], heap_e[i] = nc, e2

    return done, route_hash, order[:settled]


def _span(order, par):
    """Tree.span: (enter, leave) numbering of the states."""
    n = len(par)
    enter = np.zeros(n, dtype=np.int64)
    leave = np.zeros(n, dtype=np.int64)
    size = np.ones(n, dtype=np.int64)
    for k in range(len(order) - 1, -1, -1):
        e = order[k]
        p = par[e]
        if p >= 0:
            size[p] += size[e]
    nxt = np.zeros(n, dtype=np.int64)
    clock = 0
    for k in range(len(order)):
        e = order[k]
        p = par[e]
        if p >= 0:
            enter[e] = nxt[p]
            nxt[p] += size[e]
        else:
            enter[e] = clock
            clock += size[e]
        nxt[e] = enter[e] + 1
        leave[e] = enter[e] + size[e]
    return enter, leave


def _one_way(order, par, rev):
    """Tree.one_way: per state, its route uses an edge with no reverse edge."""
    flag = np.zeros(len(par), dtype=np.uint8)
    for k in range(len(order)):
        e = order[k]
        p = par[e]
        if rev[e] < 0 or (p >= 0 and flag[p]):
            flag[e] = 1
    return flag


def _touch(order, par, head_no, on, inc_starts, inc_edges, done, enter, leave):
    """The touches of find_paths_tree: per state, its route passes a junction
    twice or comes back to a junction marked in `on` (by node number)."""
    flag = np.zeros(len(par), dtype=np.uint8)
    for k in range(len(order)):
        e = order[k]
        p = par[e]
        node = head_no[e]
        if (p >= 0 and flag[p]) or on[node]:
            flag[e] = 1
            continue
        at = enter[e]
        for i in range(inc_starts[node], inc_starts[node + 1]):
            y = inc_edges[i]
            if y != e and done[y] and enter[y] <= at and at < leave[y]:
                flag[e] = 1
                break
    return flag


def _stem_hit(g, at, enter, leave, done, b_par, head_no, inc_starts, inc_edges, start_no,
              with_f, f_at, f_enter, f_leave, f_done):
    """The walk of find_paths_tree's doomed: follow the return route from
    edge g home until it touches the outbound route. Returns (x, y, where):
    x the return edge that arrives there (-1: never), y the outbound state
    it met, where 1 on the tree itself, 2 on the route a leg tree
    continues, 0 at the start."""
    x = g
    while x >= 0:
        node = head_no[x]
        if node == start_no:
            return x, -1, 0
        for i in range(inc_starts[node], inc_starts[node + 1]):
            y = inc_edges[i]
            if done[y] and enter[y] <= at and at < leave[y]:
                return x, y, 1
            if with_f and f_done[y] and f_enter[y] <= f_at and f_at < f_leave[y]:
                return x, y, 2
        x = b_par[x]
    return -1, -1, 0


span = one_way = touch = stem_hit = None
if njit is not None:
    grow = njit(cache=True)(_grow)
    span = njit(cache=True)(_span)
    one_way = njit(cache=True)(_one_way)
    touch = njit(cache=True)(_touch)
    stem_hit = njit(cache=True)(_stem_hit)


def disable():
    """Go back to the Python loops (numba failed to compile or load)."""
    global grow, span, one_way, touch, stem_hit
    grow = span = one_way = touch = stem_hit = None


def warm_up():
    """Compile (or load from numba's cache) before the first search needs it."""
    if grow is None:
        return False
    f8, i8 = np.float64, np.int64
    one = np.zeros(1, dtype=f8)
    grow(True, 1.0, np.zeros(2, dtype=i8), np.zeros(0, dtype=i8), np.zeros(0, dtype=np.bool_),
         one, one, one, one, one, one, one, np.zeros(1, dtype=f8), np.zeros(1, dtype=f8),
         np.zeros(1, dtype=f8), np.full(1, -1, dtype=i8), np.zeros(1, dtype=f8), np.zeros(1, dtype=i8),
         160.0, 0.15, 30.0)
    order, par = np.zeros(1, dtype=i8), np.full(1, -1, dtype=i8)
    enter, leave = span(order, par)
    one_way(order, par, par)
    done, starts = np.ones(1, dtype=np.uint8), np.zeros(2, dtype=i8)
    touch(order, par, np.zeros(1, dtype=i8), np.zeros(1, dtype=np.bool_), starts, np.zeros(0, dtype=i8),
          done, enter, leave)
    stem_hit(0, 0, enter, leave, done, par, np.zeros(1, dtype=i8), starts, np.zeros(0, dtype=i8), 0,
             False, 0, enter, leave, done)
    return True
