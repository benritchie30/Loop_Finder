# Testing

Four kinds of checks. Run them after a change.

| Check | Where | Time | What it needs |
|---|---|---|---|
| Logic tests (`npm test`) | `route-loop-finder/` | ~2 s | Node.js, `node_modules` |
| Backend tests (`python -m unittest`) | `backend/` | ~1 s | the project's virtual environment (`venv/`) |
| Lint and build | `route-loop-finder/` | ~15 s | Node.js, `node_modules` |
| Browser check (`check_frontend.py`) | `backend/` | ~4 min | the above, plus the project's virtual environment (`venv/`) |

Commands below are for Linux / macOS, run from the project folder (the one with `backend/`
and `route-loop-finder/`). On Windows, activate with `venv\Scripts\activate` instead.

---

## All at once: `run.sh`

```bash
bash run.sh                  # set up (once), then logic tests, lint, build, backend tests
bash run.sh --e2e            # ...and the browser check (downloads Playwright's Chromium the first time)
bash run.sh --all            # ...and check_limits.py, check_load.py
bash run.sh --skip-install   # only the checks
bash run.sh --e2e-only --only sets,favorites --area city   # only the browser check, with its options
```

It installs into the project folder only (`venv/`, `route-loop-finder/node_modules/`), prints a
summary, and exits with 0 only when every check passed. `CHECK_BROWSER=/path/to/chrome` picks
the browser for the browser check.

## 1. Set up (once)

```bash
python -m venv venv
source venv/bin/activate
pip install -r backend/requirements.txt
pip install -r backend/requirements-dev.txt     # Playwright, for the browser check

cd route-loop-finder
npm install
cd ..
```

Always use the virtual environment, never the system Python: `pip install` into the system
Python fails on Debian / Ubuntu with **error: externally-managed-environment**. Every new
terminal needs `source venv/bin/activate` again (the prompt then starts with `(venv)`).

No browser download is needed: the browser check uses a Chrome, Chromium or Edge that is
already on the machine. `python backend/tools/check_frontend.py --list-browsers` shows which
browser it found and whether it starts.

---

## 2. Run

### Backend tests

```bash
cd backend
python -m unittest discover -s tests -v
```

### Public server limits

```bash
cd backend
python tools/check_limits.py     # starts its own backend (port 8798), about a minute
python tools/check_load.py       # several visitors at once (port 8796), 2-3 minutes
```

### Deployment scripts (Linux)

```bash
bash deploy/test_setup.sh        # setup.sh and update.sh in a temporary folder, a few minutes
```

See `DEPLOY.md` for what it covers and for the rehearsal with Caddy (`deploy/Caddyfile.local`).

### Logic tests, lint, build

```bash
cd route-loop-finder
npm test              # Vitest: src/**/*.test.js
npx eslint src        # must be clean
npm run build         # must succeed
npm run test:watch    # re-runs the tests as you edit
```

### Try the app by hand

The backend and the UI each keep running, so each needs its own terminal (with the venv
activated):

```bash
# terminal 1: the backend (ws://localhost:8765)
cd backend
python server.py

# terminal 2: the UI (http://localhost:5173)
cd route-loop-finder
npm run dev
```

Ctrl-C stops either one.

### Browser check

```bash
cd backend
python tools/check_frontend.py                       # both areas
python tools/check_frontend.py --area city           # rural (Boone, NC) or city (Charlotte, NC)
python tools/check_frontend.py --only hover,click    # sections: offline_map, sidebar, hover, click, road_tool, areas, favorites, dead_end, sets, pins, boundary
python tools/check_frontend.py --headed              # watch it happen
python tools/check_frontend.py --browser /path/to/chrome
python tools/check_frontend.py --list-browsers       # which browsers it can use
```

It does not need the app from "Try the app by hand": it starts its own backend (port 8799,
using the map tiles in `backend/map_data/`, no map downloads) and Vite dev server (port 5199), so it
can run next to the app you are using, then stops both. Each check prints `PASS` or `FAIL`;
the last line counts them, and the exit code is 0 only when all pass. Screenshots and the two
servers' logs go to `backend/check_frontend_out/`.

It uses the first browser that starts: `--browser PATH` (or the `CHECK_BROWSER` environment
variable) if given, else a Chrome for Testing / Chromium already on the machine (it looks in
`~/.cache/puppeteer/`, `~/.cache/ms-playwright/` and the usual install places), and prints
which.

### How fast the UI responds with many routes (`bench_ui.py`)

```bash
cd backend
python tools/bench_ui.py                          # 240 routes, 150 of them favorites: production build, then dev server
python tools/bench_ui.py --ui prod --no-gpu       # the production build, as on a machine without GPU acceleration
python tools/bench_ui.py --spread                 # favorites that share no road (as from many places)
python tools/bench_ui.py --profile --trace        # also what the time goes to: functions, and the browser's own work
python tools/bench_ui.py --label after --json bench_out/after.json   # keep the numbers to compare
```

It times the main thread's CPU work (Chrome's ThreadTime) of each step: the next route
(arrow key) and a route card under the pointer in one large generation, and the pointer
coming onto its start pin in the plan (its routes previewed), each many times after a
few untimed ones, and prints the mean, median, 90th percentile and worst. The routes are made
once by the app (Charlotte, same servers as the browser check) and kept in
`backend/bench_out/ui_bench_routes.json` (`--fresh` makes them again), so runs before and after
a change time the same routes. The production build is made with `VITE_EXPOSE_STATE=1` (the
app's state for the tool, `utils/devHooks.js`; never in the deployed build). Headless Chromium
has no GPU: by default it gets one in software (SwiftShader), as canvases are handled on a
machine with a GPU; `--no-gpu` times one without. The numbers move a little from run to run:
compare medians of a few runs.

---

## 3. What the checks cover

**Logic tests** (`route-loop-finder/src/utils/__tests__/`):
- sorting and filters (climb rate is climb per mile, the sort list, Length-only default filters);
- the hover maths: the nearest point of a route, gliding between samples, staying on one leg
  of an out-and-back stem, the hover reach;
- clicking routes: which route a click shows, cycling through routes on the same road;
- the Road tool rules: paint, clear in either mode, whole roads, excluded areas (outline kept,
  roads turned back on and off), a red road inside a green area;
- double-click hit testing (painted roads, area outlines);
- the shared hover helper (one update per frame, only changes, clean up);
- generations that share a start (one pin, the same start within 20 m, length ranges, a pin's
  menu newest first, the plan's start choice: New set unless a set is picked for this pin);
- kept sets: a deleted set's favorites in a "Favorites from deleted sets" at their start, with
  the other sets there (named after the oldest) or on its own (its place from the deleted set's
  name), one per start; a favorite with no start in one set with none (newest favorited first;
  also when another set found the route too), none for sets that exist, where a favorite
  starts (saved, else its route's first point);
- Your loops by start: a group per start named after its first set, its sets newest first (a
  start's kept set after them), the starts with a route in the map's view first, the kept set
  with no start last;
- short dates (today the time, this year the day, else with the year);
- all routes from one start (Best taking turns between the sets, newest first; a route found by
  two sets, either way round, listed once; every route's set; a route without a line);
- route identity for favorites (the same route in another generation or ridden the other way is
  the same favorite; another route is not);
- custom boundaries (valid shapes, keys, inside any shape, bounds, a drawn outline simplified to
  a few points spaced apart, labels).

**Backend tests** (`backend/tests/`), on a made-up grid of streets: where a start joins the
roads (the end of a dead end, the middle of a block, the nearest road, not a path no road
joins), routes from a dead end begin and end there, a dead end off the dead end is still
dropped, and a one-way dead end (a loop could not come back) falls back to a junction; road
pieces straight from a map tile (split where roads cross, only rideable ones, a ref for a
name); custom boundaries (only the roads inside are kept and routes stay inside, shapes
together are one area, an unreachable part is dropped, a pin outside starts on the nearest road
inside, circles and freeform shapes, no roads inside, shapes cleaned and keyed, only the map
tiles the boundary overlaps; a hand-made boundary is capped like other messages). Also: a failed SRTM download pauses
elevation and it comes back (`test_elevation.py`), and the message limits (`test_limits.py`:
numbers, coordinates, ids, road weights, selections and centroids capped, the message rate).

**Public server limits** (`tools/check_limits.py`, against a real backend): `/healthz`; junk
messages (not JSON, wrong types, NaN, bad ids and selections) are ignored and a messy start
still runs; `num_paths` is capped at 200; a message over 4 MB and a flood of messages close
that connection; a 4th connection from one address is refused (HTTP 429) while another visitor
behind the web server gets in; a page from a site not in `LOOP_ALLOWED_ORIGINS` is refused
(HTTP 403); the server still generates afterwards.

**Deployment scripts** (`deploy/test_setup.sh`): `setup.sh` and `update.sh` run against a
temporary folder, with stand-ins for the system commands (apt, ufw, systemctl, ...) but real
pip, npm build, settings file, Caddy config check and backend. Checks: wrong use is refused
(no arguments, not root); the first run writes the settings (site address, contact), the service
file and the Caddyfile for the domain, builds the UI, and the backend answers `/healthz` with
those settings; a second run keeps an edited settings file; `update.sh` pulls a new commit from
the stand-in GitHub and the backend answers again. The project sits in a subfolder of the
repository (the harder layout).

**Several visitors** (`tools/check_load.py`, against a real backend, reading its memory): one
visitor alone, then three at once plus one that presses Stop while waiting. Each visitor's
timeline is printed (waiting, its turn, first route, complete). Checks: the first visitor waits at
most for one other map build and gets routes at about solo speed; later ones are told they are
waiting and all get routes, in arrival order; Stop while waiting ends that search at once; after
the idle time (30 s here) generations and areas are dropped and memory is given back.

**Browser check**, on both areas:
- *offline_map*: with the Blank road network map style and no start yet, the roads of the downloaded
  tiles are drawn; away from them a button goes back to them; a start near the edge, whose
  search area needs tiles that are not downloaded, says so (the check finds such a start near
  each area every run, from the tiles the server reports, so it keeps working as the data grows);
- *sidebar*: the panel fits without scrolling at 1400 × 900 and 1366 × 768, the tools are
  always visible, Advanced opens as its own page (a back arrow, no Done; Esc closes it),
  filters start with Length only and can be added / removed, the sort dropdown (a new
  variable keeps the route, reversing selects the first and scrolls the list to it, even while
  the list is still gliding from the sort change), going back from a generation started
  with Enter on the Advanced page shows the plan, the arrows step and keep the
  selected card in the middle of its list, a clicked card instead stays under the pointer
  and shows whole, More routes options, the elevation chart stays clear of the panel,
  Your loops;
- *hover*: the marker follows the pointer 14 px and 40 px beside the route at every position
  (no flicker), the elevation chart follows, the marker hides away from the route and off the
  map; hovering a route card shows only that route in bold (the chart stays on the selected one),
  moving from card to card never drops the preview in the gap, and a card clicked low in the list
  stays under the pointer and shows whole, so small moves after the click preview no other card;
  clicking the selected card when it is partly hidden shows it whole; the mouse wheel
  scrolls one card per notch (quick notches queue, a trackpad swipe of about a card is one card,
  up goes back one), and the card it brings under the pointer is previewed;
- *click*: a click near another route shows it, clicking again cycles, a click away from routes
  changes nothing, quick clicks never zoom, nothing is added or sent to the server;
- *road_tool*: paints green without asking for routes (Advanced "Find more routes when I add a
  road or area to include" is off by default) and M then asks once, clears in either mode, paints
  red without asking for routes, Ctrl-click paints a whole road, double-click removes it without
  zooming, double-click elsewhere does not zoom;
- *areas*: drawing a box, circle or freeform in the plan leaves the start pin where it was; an
  excluded box is a dotted red outline (not red roads), the Road tool inside it shows its roads
  and turns one back on and off, leaving hides them; with "Painted roads & areas" switched off
  they are hidden in pan mode (and cannot be double-clicked away) and shown while a tool is
  active; double-clicking the outline removes it; drawing an include circle asks for no routes
  (the option is off by default); an include circle is a dotted green outline
  at full strength, a red road can go inside it, every listed route enters it;
- *favorites*: S makes the shown route a favorite, drawn in the favorite colour (the theme
  colour's complement) with its card marked; a card's star favorites its route without selecting
  it; faint favorites look like the other faint routes (one canvas draws the faint routes; on the
  dev server it records the colours, opacity and number of lines it draws, halos marked apart), a favorite previewed from its card is in
  the favorite colour; Favorites lists only the favorites (staying on the shown one), an unfavorited route stays
  listed while shown and is gone at the next; favorites are kept after a reload and after
  deleting their generation (in "Favorites from deleted sets", the notice saying so; Undo
  brings the set back in their place), and marked again when it is reopened;
- *sets*: a generation is named after its place only; Plan again from here goes to the plan with
  New set chosen and the generation listed (the plan still fits), and picking it there, Add loops
  adds routes to the same generation; a start pin
  placed by hand on a set's start chooses New set (picking the set makes it Add loops); clicking
  the grey pin of one set opens that set, right-clicking it opens its menu, and its New set from here goes to the
  plan with the pin on that start, New set chosen and nothing searched; that makes
  "<place> #2" (the start's place, numbered with a # so it does not run into a count; routes favorited in the first that it finds again are favorites there too), both
  share one pin whose menu lists them newest first and opens one as all routes from there with
  its chip chosen and its name above; a long list scrolls in the
  menu and the wheel there does not zoom the map; the menu closes at a click on the map (which
  places no start pin; the next one does), on the panel, on a panel button (which still acts) or
  a map button (zoom in), at Esc, and at a click on its pin (which opens the pin's routes); with a set open, a click on a route only
  closes it (the next shows that route); from an open set, the pin's New set from here
  goes back to the plan at that start; a pin with one set has no Show all routes from here, one
  with two has: it lists every route of both sets, a route both found once, Best taking turns
  between the sets (newest first), every card naming its set, with no Rename, Settings used or
  Delete; More routes adds to the newest set or the one chosen in its options (the list stays
  all routes from here); a card's set name chooses its set's chip, its name above, on the same route;
  hovering a row in Your loops
  shows only its pin and previews its routes without moving the map, leaving the list ends it; a generation can be
  renamed in Your loops; clicking a row opens it and centres the map on its pin beside the panel;
- *pins*: the pointer resting on the pin of several sets (it stays the plain pin) shows its label,
  previews its routes (a route two sets found once) and hides the other pins and the start pin; moving off brings
  them back and the preview goes; a right-click opens its menu (not the set) and a set there
  under the pointer previews only that set; a click opens all routes from there with a chip per
  set and All, only that pin showing; a chip under the pointer shows only its set's routes,
  clicked it lists only them and More routes adds to it, All lists every route again; Esc goes
  back to the plan with every pin; the Favorites switch (V) leaves only the starts with favorites
  (their usual pins counting them) and Your loops only the sets with favorites, a click on a star pin
  opens only its favorites, and the switch is remembered after a reload;
- *boundary*: New boundary opens the editor; a dragged box joins it with handles, dragging a
  corner resizes it; a freehand shape is simplified to a few points that can be dragged and
  removed by double-click; shapes can be added and removed; Enter saves it and the plan uses it
  (a grey dotted outline, the plan still fits); every route found stays inside it; the generation
  keeps it and shows it (the Search boundary option hides it); adding to a generation made
  without it gives that generation the boundary, and the new routes stay inside; the pencil
  edits it, deleting it puts the plan back on the automatic area;
- *dead_end*: a pin clicked a few metres off the end of a dead-end street (Northside Drive,
  Boone; Marvin Road, Charlotte) moves onto the end of the road, finds loops, and every one
  starts where the pin is.

---

## 4. Troubleshooting

| Message | Fix |
|---|---|
| `error: externally-managed-environment` | You used the system Python's pip. Activate the venv first (`source venv/bin/activate`). |
| `ensurepip is not available` / `python -m venv` fails | `sudo apt install python3-venv`, then make the venv again. |
| `Playwright is not installed for this Python` | The venv is not active: `source venv/bin/activate`, then run the check again. |
| `No browser could be started` | `python tools/check_frontend.py --list-browsers` shows what it tried; pass `--browser` with the path of the Chrome for Testing. |
| Chromium: `error while loading shared libraries: libnss3.so` (or similar) | A minimal Linux lacks libraries a desktop has: `python -m playwright install-deps chromium` (needs internet and sudo). |
| `server.py`: `AttributeError: 'Headers' object has no attribute 'path'` and `opening handshake failed` on every connection, or it stops with `This backend needs websockets 14 or newer` | The Python environment has an old `websockets` (13 or older; conda environments often do). In that environment: `pip install -r backend/requirements.txt` (or `pip install -U "websockets>=14"`). websockets 14 needs Python 3.9+. |
| `server.py`: `Port 8765 is in use` | A backend is already running (an earlier `python server.py`, in another terminal or in the background). The UI can use it as it is; to restart, stop it first: the message names the process (`kill <PID>`); otherwise `ss -ltnp \| grep 8765` shows it. Or run on another port: `LOOP_PORT=8766 python server.py` and start the UI with `LOOP_PORT=8766 npm run dev`. |
| `port 8799 is busy` / `port 5199 is busy` | An earlier check is still running, or something else uses the port; stop it. |
| A check fails | Look at the screenshots and logs in `backend/check_frontend_out/`, and run that section alone with `--only ... --headed`. |
