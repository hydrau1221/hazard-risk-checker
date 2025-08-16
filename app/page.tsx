"use client";

import { useState } from "react";

type Feature = { attributes: Record<string, any> };

export default function Home() {
  // On fixe directement l'ID du layer FEMA (Flood Hazard Zones)
  const [layerId] = useState<number>(28);
  const layerSource = "fixed-28";
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Feature[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    setError(null);
    setResult(null);
    const latNum = Number(lat);
    const lonNum = Number(lon);
    if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
      setError("Latitude/Longitude invalides.");
      return;
    }
    setLoading(true);
    try {
      const r = await fetch(`/api/fema/query?lat=${latNum}&lon=${lonNum}&layerId=${layerId}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Query failed");
      const feats = j.features ?? [];
      setResult(feats);
      if (!feats.length) setError("Aucune zone trouvée (ou hors couverture NFHL).");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function useMyLocation() {
    setError(null);
    if (!navigator.geolocation) return setError("Géolocalisation non supportée.");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(String(pos.coords.latitude));
        setLon(String(pos.coords.longitude));
      },
      (err) => setError(err.message),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  return (
    <main style={{ minHeight: "100vh", background: "#0a0a0a", color: "white", display: "grid", placeItems: "center", padding: "2rem" }}>
      <div style={{ width: "100%", maxWidth: 720, background: "#111", border: "1px solid #222", borderRadius: 16, padding: 24, boxShadow: "0 10px 30px rgba(0,0,0,0.3)" }}>
        <h1 style={{ fontSize: 28, marginBottom: 12 }}>FEMA Flood Risk Checker</h1>
        <p style={{ opacity: 0.8, marginBottom: 20 }}>Entre une latitude/longitude (WGS84) ou utilise ta position, puis “Check”.</p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 12, marginBottom: 12 }}>
          <input
            placeholder="Latitude (ex: 29.951)"
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            style={{ background: "#0f172a", color: "white", border: "1px solid #243057", borderRadius: 12, padding: "10px 12px" }}
          />
          <input
            placeholder="Longitude (ex: -90.071)"
            value={lon}
            onChange={(e) => setLon(e.target.value)}
            style={{ background: "#0f172a", color: "white", border: "1px solid #243057", borderRadius: 12, padding: "10px 12px" }}
          />
          <button
            onClick={useMyLocation}
            style={{ borderRadius: 12, border: "1px solid #243057", background: "#0b122b", color: "white", padding: "10px 12px", whiteSpace: "nowrap" }}
          >
            Ma position
          </button>
        </div>

        <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
          <button
            onClick={check}
            disabled={loading}
            style={{ borderRadius: 12, border: "1px solid #2f855a", background: loading ? "#22543d" : "#1f4335", color: "white", padding: "10px 16px" }}
          >
            {loading ? "Recherche…" : "Check"}
          </button>
          <span style={{ opacity: 0.7 }}>Layer id: {layerId} ({layerSource})</span>
        </div>

        {error && (
          <div style={{ background: "#2d1b1b", border: "1px solid #5a2a2a", padding: 12, borderRadius: 12, marginBottom: 12 }}>
            {error}
          </div>
        )}

        {result && result.length > 0 && (
          <div style={{ background: "#0e1a2d", border: "1px solid #203659", padding: 16, borderRadius: 12 }}>
            <h2 style={{ margin: "0 0 8px 0" }}>
              Résultat ({result.length} feature{result.length > 1 ? "s" : ""})
            </h2>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {result.map((f, i) => {
                const a = f.attributes || {};
                const zone = a.FLD_ZONE ?? a.ZONE ?? a.ZONE_SUBTY ?? a.ZONE_SUBTYPE;
                const sfha = a.SFHA_TF;
                const bfe = a.BFE ?? a.STATIC_BFE ?? a.DEPTH ?? a.VE_ZONE ?? null;
                return (
                  <li key={i} style={{ marginBottom: 6 }}>
                    <code>FLD_ZONE: {String(zone ?? "N/A")} | SFHA_TF: {String(sfha ?? "N/A")} {bfe != null ? `| BFE/DEPTH: ${bfe}` : ""}</code>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <p style={{ opacity: 0.6, marginTop: 16, fontSize: 12 }}>⚠️ Outil informatif. Réf. réglementaire : FIRM/NFHL FEMA.</p>
      </div>
    </main>
  );
}
