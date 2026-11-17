import { useMemo } from 'react';
import { Marker } from 'react-leaflet';
import L from 'leaflet';

const ARROW_PX = 22;

/**
 * Create a rotated arrow DivIcon using an SVG arrow: a chevron in `color`
 * (white) with a dark outline, so it reads on the route whatever its colour
 * and on any map.
 * bearingDeg is geographic (0=north, 90=east).
 * The SVG arrow points east (right) by default, so we subtract 90° for CSS rotation.
 */
function createArrowIcon(bearingDeg, color, outline, plainColor) {
    const cssRotation = bearingDeg - 90;
    // The Classic style: a larger chevron in one colour, with a soft glow around it.
    if (plainColor) {
        return L.divIcon({
            className: 'direction-arrow',
            html: `<div class="direction-arrow__inner direction-arrow__inner--glow" style="transform: rotate(${cssRotation}deg)">
            <svg viewBox="0 0 24 24" width="32" height="32">
                <path d="M8 4 L16 12 L8 20" stroke="${plainColor}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
            </svg>
        </div>`,
            iconSize: [32, 32],
            iconAnchor: [16, 16]
        });
    }
    return L.divIcon({
        className: 'direction-arrow',
        html: `<div class="direction-arrow__inner" style="transform: rotate(${cssRotation}deg)">
            <svg viewBox="0 0 24 24" width="${ARROW_PX}" height="${ARROW_PX}">
                <path d="M9 5 L16 12 L9 19" stroke="${outline}" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
                <path d="M9 5 L16 12 L9 19" stroke="${color}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
            </svg>
        </div>`,
        iconSize: [ARROW_PX, ARROW_PX],
        iconAnchor: [ARROW_PX / 2, ARROW_PX / 2]
    });
}

/**
 * Renders directional arrow markers along the active path.
 * Uses the elevation_profile array: [dist_mi, elev_ft, lat, lng, bearing_deg].
 * Bearing is pre-computed in the backend from the actual edge geometry.
 * Places an arrow every `intervalMiles` miles along the path.
 */
function DirectionArrows({
    elevationProfile, intervalMiles = 1, color = '#ffffff', outline = '#0a0d12',
    plainColor = null, // the Classic style's one-colour arrow (null: the outlined chevron)
}) {
    const arrows = useMemo(() => {
        if (!elevationProfile || elevationProfile.length < 2) return [];

        const result = [];
        let nextMileMark = intervalMiles;

        for (let i = 0; i < elevationProfile.length; i++) {
            const pt = elevationProfile[i];
            if (pt.length < 5) continue; // need [dist, elev, lat, lng, bearing]

            const dist = pt[0];
            if (dist < nextMileMark) continue;

            result.push({
                lat: pt[2],
                lng: pt[3],
                bearing: pt[4],
                key: `arrow-${i}`
            });
            nextMileMark = dist + intervalMiles;
        }
        return result;
    }, [elevationProfile, intervalMiles]);

    return (
        <>
            {arrows.map(({ lat, lng, bearing, key }) => (
                <Marker
                    key={key}
                    position={[lat, lng]}
                    icon={createArrowIcon(bearing, color, outline, plainColor)}
                    interactive={false}
                />
            ))}
        </>
    );
}

export default DirectionArrows;
