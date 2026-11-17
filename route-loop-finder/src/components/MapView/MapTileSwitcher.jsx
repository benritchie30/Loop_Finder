import React, { useState } from 'react';
import { Check, Layers } from 'lucide-react';
import './MapView.css';
import { MAP_STYLES } from './mapStyles';

function MapTileSwitcher({ currentStyle, onStyleChange }) {
    const [isOpen, setIsOpen] = useState(false);

    return (
        <div
            className="map-tile-switcher"
            onMouseEnter={() => setIsOpen(true)}
            onMouseLeave={() => setIsOpen(false)}
        >
            <div className="map-tile-switcher__button" title="Basemap">
                <Layers size={18} />
            </div>

            {isOpen && (
                <div className="map-tile-switcher__menu">
                    {Object.entries(MAP_STYLES).map(([key, style]) => (
                        <div
                            key={key}
                            className={`map-tile-switcher__option ${currentStyle === key ? 'active' : ''}`}
                            onClick={() => {
                                onStyleChange(key);
                                setIsOpen(false);
                            }}
                        >
                            <div className={`map-tile-switcher__preview map-tile-switcher__preview--${key}`}></div>
                            <span>{style.name}</span>
                            {currentStyle === key && <Check size={14} className="map-tile-switcher__check" />}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

export default MapTileSwitcher;
