import { describe, expect, it } from 'vitest';
import { coverageGroups, coverageOutline, nearestGroup, roadTilesState, tilesForStart, tilesInBounds, tilesNearView } from '../mapTiles';

const sorted = (tiles) => tiles.map((t) => t.join(',')).sort();

describe('map tiles (same as the server)', () => {
    // Expected values printed by backend areas.tiles_needed.
    it('a start needs the same tiles the server downloads', () => {
        expect(sorted(tilesForStart(36.25, -81.85, 12))).toEqual(sorted([
            [361, -820], [361, -819], [361, -818], [362, -820], [362, -819], [362, -818], [363, -820], [363, -819], [363, -818],
        ]));
        expect(sorted(tilesForStart(35.2, -80.8, 10))).toEqual(sorted([[351, -809], [351, -808], [352, -809], [352, -808]]));
        expect(sorted(tilesForStart(36.05, -81.95, 6))).toEqual(sorted([
            [359, -820], [360, -821], [360, -820], [360, -819], [361, -820],
        ]));
        expect(tilesForStart(35.15, -80.85, 30)).toHaveLength(31);
    });

    it('lists the tiles in view', () => {
        expect(sorted(tilesInBounds({ south: 35.15, west: -80.85, north: 35.25, east: -80.75 }))).toEqual(sorted([
            [351, -809], [351, -808], [352, -809], [352, -808],
        ]));
    });

    it('outlines a block of tiles by its outer sides only', () => {
        const block = [[351, -809], [351, -808], [352, -809], [352, -808]];
        expect(coverageOutline(block)).toHaveLength(8); // 2 x 2 block: 2 sides per edge
    });

    it('finds separate downloaded places and the nearest one', () => {
        const tiles = [[351, -809], [352, -808], [362, -819], [363, -819], [363, -818]];
        const groups = coverageGroups(tiles);
        expect(groups).toHaveLength(2); // the corner-touching pair counts as one
        expect(nearestGroup(groups, 35.0, -80.0).tiles).toHaveLength(2);
        expect(nearestGroup(groups, 37.0, -82.0).tiles).toHaveLength(3);
    });
});

describe('road pieces for the Favorites tab: only near the view', () => {
    // tiles [row, col] of 0.1 deg: row 352 is 35.2-35.3 N, col -809 is 80.9-80.8 W
    const charlotte = [[352, -809], [352, -808], [351, -809]];
    const boone = [[362, -819], [362, -818]];
    const view = { south: 35.21, west: -80.88, north: 35.27, east: -80.79 }; // inside [352, -809] and [352, -808]

    it('only the tiles in or near the view (another city loads nothing)', () => {
        const { tiles, tooMany } = tilesNearView([...charlotte, ...boone], view);
        expect(tiles).toEqual([[352, -809], [352, -808], [351, -809]]);
        expect(tooMany).toBe(false);
    });

    it('none without a view or tiles', () => {
        expect(tilesNearView(charlotte, null).tiles).toEqual([]);
        expect(tilesNearView([], view).tiles).toEqual([]);
    });

    it('zoomed far out: only those in view, else none and "zoom in"', () => {
        const many = [];
        for (let r = 340; r < 350; r++) for (let c = -830; c < -820; c++) many.push([r, c]);
        const wide = { south: 34.0, west: -83.0, north: 35.0, east: -82.0 };
        expect(tilesNearView(many, wide, { max: 24 })).toEqual({ tiles: [], tooMany: true });
        const small = { south: 34.05, west: -82.95, north: 34.25, east: -82.75 };
        const { tiles, tooMany } = tilesNearView(many, small, { max: 24 });
        expect(tooMany).toBe(false);
        expect(tiles.length).toBeGreaterThan(0);
        expect(tiles.length).toBeLessThanOrEqual(24);
    });
});

describe('the Favorites tab\'s Road tool, as the road pieces come', () => {
    const near = { tiles: [[1, 1], [1, 2]], tooMany: false };
    it('loading until every tile near the view has come, then ready', () => {
        expect(roadTilesState(near, ([, c]) => c === 1)).toBe('loading');
        expect(roadTilesState(near, () => true)).toBe('ready');
    });
    it('zoom in when too far out; none when no favorite is near', () => {
        expect(roadTilesState({ tiles: [], tooMany: true }, () => true)).toBe('zoom');
        expect(roadTilesState({ tiles: [], tooMany: false }, () => true)).toBe('none');
        expect(roadTilesState(null, () => true)).toBe('none');
    });
});
