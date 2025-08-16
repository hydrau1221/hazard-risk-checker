"use client";

import { useState } from "react";

type Feature = { attributes: Record<string, any> };
type FloodResult = {
  zone: string;
  sfha: boolean;
  bfe: string | null;
  note: string;
};

const LAYER_ID = 28; // Flood Hazard Zones (NFHL)

function assessFlood(features: Feature[]): FloodResult {
  if (!features?.length) {
    return { zone: "N/A", sfha: false, bfe: null, note: "No flood polygon here (NFHL)" };
  }
  const a = features[0].attributes || {};
  const zoneRaw = a.FLD_ZONE ?? a.ZONE ?? a.ZONE_SUBTY ?? a.ZONE_SUBTYPE ?? "N/A";
  const zone = String(zoneRaw);
  const sfha =
    a.SFHA_TF === true ||
    a.SFHA_TF === "T" ||
    a.SFHA_TF === "Y" ||
    ["A", "AE", "VE", "AO", "AH", "A1", "A99"].includes(zone);

  const bfeRaw = a.BFE ?? a.STATIC_BFE ?? a.DEPTH ?? null;
  const bfe = bfeRaw == null || Number(bfeRaw) === -9999 ? null : String(bfeRaw);

  const desc: Record<string, string> = {
    AE: "High risk (1% annual chance), BFE determined",
    A: "High risk (1% annual chance)",
    VE: "Coastal high hazard (wave action)",
    AO: "High risk (depth-based)",
    AH: "High risk (ponding), BFE in feet",
    X: "Moderate/minimal risk (outside SFHA)",
  };

  return {
    zone,
    sfha,
    bfe,
    note: desc[zone] ?? "See FEMA NFHL for details",
  };
}

export default function Home() {
  const [address, setAddress] = useState("1600 Pennsylvania Ave NW, Washington, DC");
  const [loading, setLoading] = useState<"idle" | "geocode" | "fema">("idle");
  const [floodBox, setFloodBox] = useState<string>("Enter an address and press Check.");
  const [error, setError] = useState<string | null>(null);

  async function onCheck() {
    setError(null);
    setFloodBox("Geocoding address…");
    setLoading("geocode");

    try {
      // 1) Geocode
      const g = await fetch(`/api/geocode?address=${encodeURIComponent(address)}`, { cache: "no-store" });
      const gj = await g.json();
      if (!g.ok) throw new Error(gj?.error || "Error fetching coordinates.");

      const { lat, lon } = gj as { lat: number; lon: number };

      // 2) FEMA
      setLoading("fema");
      setFloodBox("Querying FEMA NFHL…");

      const q = await fetch(`/api/fema/query?lat=${lat}&lon=${lon}&layerId=${LAYER_ID}`, { cache: "no-store" });
      const qj = await q.json();
      if (!q.ok) throw new Error(qj?.error || "FEMA query failed.");

      const features: Feature[] = qj.features ?? [];
      const res = assessFlood(features);

      let line = `Zone: ${res.zone} — ${res.note}`;
      line += ` | SFHA: ${res.sfha ? "Yes" : "No"}`;
      if (res.bfe) line += ` | BFE/Depth: ${res.bfe} ft`;

      setFloodBox(line);
    } catch (e: any) {
      setError(e.message || String(e));
      setFloodBox("Error fetching coordinates.");
    } finally {
      setLoading("idle");
    }
  }

  // --- styles simples (sans Tailwind) ---
  const s = {
    header: { background: "#121212", color: "white", padding: "28px 16px", textAlign: "center" as const },
    title: { fontSize: 32, margin: 0 },
    subtitle: { opacity: 0.9, marginTop: 8 },
    bar: { display: "flex", justifyContent: "center", gap: 8, marginTop: 16 },
    input: { width: 420, maxWidth: "90vw", padding: "10px 12px", borderRadius: 6, border: "1px solid #cbd5e1" },
    btn: { padding: "10px 16px", borderRadius: 6, border: "1px solid #0b396b", background: "#114d8a", color: "white", cursor: "pointer" },
    gridWrap: { background: "#e0e0e0", minHeight: "calc(100vh - 120px)", padding: "28px 16px" },
    grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 20, maxWidth: 980, margin: "20px auto" },
    card: { background: "white", border: "1px solid #e2e8f0", borderRadius: 8, padding: 24, textAlign: "center" as const, boxShadow: "0 1px 2px rgba(0,0,0,0.05)" },
    h2: { margin: "0 0 10px 0", fontSize: 22 },
    small: { fontSize: 14, color: "#475569" },
    err: { margin: "12px auto 0", maxWidth: 980, color: "#7f1d1d", background: "#fee2e2", border: "1px solid #fecaca", padding: 10, borderRadius: 6 },
    foot: { fontSize: 12, opacity: 0.6, textAlign: "center" as const, marginTop: 8 },
  };

  return (
    <div>
      <header style={s.header}>
        <h1 style={s.title}>Risk Checker Map</h1>
        <div style={s.subtitle}>Enter your address to check your risk exposure</div>
        <div style={s.bar}>
          <input
            style={s.input}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="123 Main St, City, State"
          />
          <button style={s.btn} onClick={onCheck} disabled={loading !== "idle"}>
            {loading === "idle" ? "Check" : loading === "geocode" ? "Geocoding…" : "Checking…"}
          </button>
        </div>
      </header>

      <main style={s.gridWrap}>
        {error && <div style={s.err}>{error}</div>}

        <div style={s.grid}>
          {/* Flood card */}
          <section style={s.card}>
            <h2 style={s.h2}>Flood</h2>
            <div style={s.small}>{floodBox}</div>
          </section>

          {/* Coming soon cards */}
          <section style={s.card}>
            <h2 style={s.h2}>Earthquake</h2>
            <div style={s.small}>Coming soon</div>
          </section>
          <section style={s.card}>
            <h2 style={s.h2}>Landslide</h2>
            <div style={s.small}>Coming soon</div>
          </section>
          <section style={s.card}>
            <h2 style={s.h2}>Wildfire</h2>
            <div style={s.small}>Coming soon</div>
          </section>
        </div>

        <div style={s.foot}>⚠️ Informational tool. Regulatory reference: FEMA NFHL / FIRM.</div>
      </main>
    </div>
  );
}
