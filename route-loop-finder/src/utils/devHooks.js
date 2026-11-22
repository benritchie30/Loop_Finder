/**
 * The app's state for the browser checks and the UI benchmark
 * (backend/tools/check_frontend.py, bench_ui.py): window.__loopState,
 * __loopMap, __pathSets, __routeKey, and what the route canvas draws.
 * On with the dev server; a production build has them only when built with
 * VITE_EXPOSE_STATE=1 (the benchmark's build, never the deployed one).
 */
export const EXPOSE_STATE = import.meta.env.DEV || import.meta.env.VITE_EXPOSE_STATE === '1';
