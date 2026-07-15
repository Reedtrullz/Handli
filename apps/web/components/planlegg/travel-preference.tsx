"use client";

import { useState } from "react";

interface TravelPreferenceProps {
  enabled: boolean;
  mode: "car" | "bike";
  onChange: (preference: { enabled: boolean; mode: "car" | "bike" }) => void;
}

export function TravelPreference({ enabled, mode, onChange }: TravelPreferenceProps) {
  const [origin, setOrigin] = useState("");

  return (
    <div className="travel-preference">
      <div className="travel-toggle-row">
        <label htmlFor="travel-time">Beregn reisetid</label>
        <input
          id="travel-time"
          type="checkbox"
          role="switch"
          checked={enabled}
          onChange={(event) => onChange({ enabled: event.target.checked, mode })}
        />
      </div>
      {enabled ? (
        <div className="travel-details">
          <label className="sr-only" htmlFor="travel-origin">Startpunkt</label>
          <input
            id="travel-origin"
            type="text"
            autoComplete="street-address"
            placeholder="Startpunkt"
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
          />
          <div className="transport-options" role="group" aria-label="Transportmiddel">
            <button
              type="button"
              aria-pressed={mode === "car"}
              onClick={() => onChange({ enabled, mode: "car" })}
            >Bil</button>
            <button
              type="button"
              aria-pressed={mode === "bike"}
              onClick={() => onChange({ enabled, mode: "bike" })}
            >Sykkel</button>
          </div>
          <p>Startpunktet ditt brukes kun for beregning av rute og lagres ikke på våre servere.</p>
        </div>
      ) : null}
    </div>
  );
}
