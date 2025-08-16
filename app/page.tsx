"use client";

import { useState } from "react";

type Feature = { attributes: Record<string, any> };
type RiskLevel = "Very Low" | "Low" | "Moderate" | "High" | "Very High";

const LAYER_ID = 28; // NFHL - Flood Hazard Zones

// Palette (fond doux + couleur du badge)
const PALETTE: Record<
  RiskLevel,
  { bg: string; badge: string; text: string; border: string }
> = {
  "Very Low": { bg: "#dcfce7", badge: "#16a34a", text: "#14532d", border: "#86efac" }, // verts
  Low: { bg: "#dbeafe", badge: "#1d4ed8", text: "#0c4a6e", border: "#93c5fd" },        // bleus
  Moderate: { bg: "#fef9c3", badge: "#ca8a04", text: "#854d0e", border: "#fde68a" },   // jaunes
  High: { bg: "#ffedd5", badge: "#ea580c", text: "#7c2d12", border: "#fdba74" },       // orange
  "Very High": { bg: "#fee2e2", badge: "#dc2626", text: "#7f1d1d", border: "#fecaca" } // rouges
};

// --- Classification à partir des attributs FEMA ---
// Règles simples et lisibles :
//  - VE -> Very High
//  - AE/A/A1-30/A99/AO/AH -> High  (toute SFHA par défaut = High)
//  - X + ZONE_SUBTY contient "0.2" (X shaded) -> Moderate
//  - X (autres) -> Low
//  - D (undetermined) -> Moderate
//  - Aucun polygone trouvé -> Very Low
function classifyFlood(features: Feature[] | null): {
  level: RiskLevel;
  zone: string;
  sfha: boolean;
  bfe: string | null;
  note: string;
} {
  if (!features || features.length === 0) {
    return {
      level: "Very Low",
      zone: "N/A",
      sfha: false,
      bfe: null,
      note: "No NFHL polygon returned here",
    };
  }

  const a = features[0].attributes || {};

  const rawZone =
    a.FLD_ZONE ?? a.ZONE ?? a.ZONE_SUBTY ?? a.ZONE_SUBTYPE ?? "N/A";
  const zone = String(rawZone).toUpperCase();

  const subty = String(
    a.ZONE_SUBTY ?? a.ZONE_SUBTYPE ?? a.ZONE ?? ""
  ).toUpperCase();

  const bfeRaw = a.BFE ?? a.STATIC_BFE ?? a.DEPTH ?? null;
  const bfe = bfeRaw == null || Number(bfeRaw) === -9999 ? null : String(bfeRaw);

  const inSFHA =
    a.SFHA_TF === true ||
    a.SFHA_TF === "T" ||
    a.SFHA_TF === "Y" ||
    ["A", "AE", "AO", "AH", "A1", "A2", "A30", "A99", "VE"].some((p) =>
      zone.startsWith(p)
    );

  let level: RiskLevel;
  let note = "";

  if (zone.startsWith("VE")) {
    level = "Very High";
    note = "Coastal high hazard (wave action)";
  } else if (
    zone === "AO" ||
    zone === "AH" ||
    zone === "AE" ||
    zone === "A" ||
    zone.startsWith("A1") ||
    zone.startsWith("A2") ||
    zone.startsWith("A3") ||
    zone === "A99"
  ) {
    level = "High";
    note = "Special Flood Hazard Area (1% annual chance)";
  } else if (zone === "X" && subty.includes("0.2")) {
    level = "Moderate";
    note = "0.2% annual chance flood (X shaded)";
  } else if (zone === "X") {
    level = "Low";
    note = "Outside SFHA (Zone X)";
  } else if (zone === "D") {
    level = "Moderate";
    note = "Undetermined risk (Zone D)";
  } else if (zone === "N/A") {
    level = "Very Low";
    note = "No NFHL polygon returned here";
  } else {
    // Valeur exotique -> prudence
    level = inSFHA ? "High" : "Low";
    note = "See FEMA NFHL details";
  }

  return { level, zone, sfha: inSFHA, bfe, note };
}

export default function Home() {
  const [address, setAddress] = useState(
    "1600 Pennsylvania Ave NW, Washington, DC"
  );
  const [loading, setLoading] = useState<"idle" | "geocode" | "fema">("idle");
  const [floodText, setFloodText] = useState<string>(
    "Enter an address and press Check."
  );
  const [floodLevel, setFloodLevel] = useState<RiskLevel | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onCheck() {
    setError(null);
    setFloodLevel(null);
    setFloodText("Geocoding address…");
    setLoading("geocode");

    try {
      // 1) Géocoder
      const g = await fetch(
        `/api/geocode?address=${encodeURIComponent(address)}`,
        { cache: "no-store" }
      );
      const gj = await g.json();
      if (!g.ok) throw new Error(gj?.error || "Error fetching coordinates.");
      const { lat, lon } = gj as { lat: number; lon: number };

      // 2) Interroger FEMA NFHL
      setLoading("fema");
      setFloodText("Querying FEMA NFHL…");
      const q = await fetch(
        `/api/fema/query?lat=${lat}&lon=${lon}&layerId=${LAYER_ID}`,
        { cache: "no-store" }
      );
      const qj = await q.json();
      if (!q.ok) throw new Error(qj?.error || "FEMA query failed.");

      const features: Feature[] = qj.features ?? [];
      const res = classifyFlood(features);

      // Texte final
      let line = `${res.level.toUpperCase()} RISK — Zone ${res.zone}`;
      if (res.bfe) line += ` | BFE/Depth: ${res.bfe} ft`;
      line += ` | ${res.note}`;

      setFloodLevel(res.level);
      setFloodText(line);
    } catch (e: any) {
      setError(e.message || String(e));
      setFloodLevel(null);
      setFloodText("Error fetching data.");
    } finally {
      setLoading("idle");
    }
  }

  // Styles
  const s = {
    header: {
      background: "#0b396b",
      color: "white",
      padding: "28px 16px",
      textAlign: "center" as const,
    },
    title: { fontSize: 32, margin: 0 },
    subtitle: { opacity: 0.9, marginTop: 8 },
    bar: {
      display: "flex",
      justifyContent: "center",
      gap: 8,
      marginTop: 16,
      flexWrap: "wrap" as const,
    },
    input: {
      width: 420,
      maxWidth: "90vw",
      padding: "10px 12px",
      borderRadius: 6,
      border: "1px solid #cbd5e1",
    },
    btn: {
      padding: "10px 16px",
      borderRadius: 6,
      border: "1px solid #0b396b",
      background: "#114d8a",
      color: "white",
      cursor: "pointer",
    },
    gridWrap: {
      background: "#eef2f6",
      minHeight: "calc(100vh - 120px)",
      padding: "28px 16px",
    },
    grid: {
      display: "grid",
      gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
      gap: 20,
      maxWidth: 980,
      margin: "20px auto",
    },
    card: {
      background: "white",
      border: "1px solid #e2e8f0",
      borderRadius: 8,
      padding: 0,
      textAlign: "center" as const,
      boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
      overflow: "hidden",
    },
    cardBody: { padding: 24 },
    h2: { margin: "0 0 10px 0", fontSize: 22 },
    small: { fontSize: 14, color: "#334155" },
    err: {
      margin: "12px auto 0",
      maxWidth: 980,
      color: "#7f1d1d",
      background: "#fee2e2",
      border: "1px solid #fecaca",
      padding: 10,
      borderRadius: 6,
    },
    foot: {
      fontSize: 12,
      opacity: 0.6,
      textAlign: "center" as const,
      marginTop: 8,
    },
    // styles dynamiques pour la carte Flood
    floodHeader: (lvl: RiskLevel) => {
      const p = PALETTE[lvl];
      return {
        background: p.bg,
        color: p.text,
        borderBottom: `1px solid ${p.border}`,
        padding: "18px 16px",
      };
    },
    badge: (lvl: RiskLevel) => {
      const p = PALETTE[lvl];
      return {
        display: "inline-block",
        padding: "6px 10px",
        borderRadius: 999,
        background: p.badge,
        color: "white",
        fontWeight: 700,
        letterSpacing: 0.5,
      };
    },
  };

  const floodCard =
    floodLevel == null ? (
      // Etat neutre avant calcul
      <section style={s.card}>
        <div style={{ padding: 16, borderBottom: "1px solid #e2e8f0" }}>
          <h2 style={{ ...s.h2, margin: 0 }}>Flood</h2>
        </div>
        <div style={s.cardBody}>
          <div style={s.small}>{floodText}</div>
        </div>
      </section>
    ) : (
      // Carte colorée selon le risque
      <section style={{ ...s.card, border: `1px solid ${PALETTE[floodLevel].border}` }}>
        <div style={s.floodHeader(floodLevel)}>
          <h2 style={{ ...s.h2, margin: 0 }}>Flood</h2>
          <div style={{ marginTop: 6 }}>
            <span style={s.badge(floodLevel)}>{floodLevel.toUpperCase()} RISK</span>
          </div>
        </div>
        <div style={s.cardBody}>
          <div style={s.small}>{floodText}</div>
        </div>
      </section>
    );

  return (
    <div>
      <header style={s.header}>
        <h1 style={s.title}>Hydrau Risk Checker</h1>
        <div style={s.subtitle}>Enter your address to check your flood risk</div>
        <div style={s.bar}>
          <input
            style={s.input}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="123 Main St, City, State"
          />
          <button style={s.btn} onClick={onCheck} disabled={loading !== "idle"}>
            {loading === "idle"
              ? "Check"
              : loading === "geocode"
              ? "Geocoding…"
              : "Checking…"}
          </button>
        </div>
      </header>

      <main style={s.gridWrap}>
        {error && <div style={s.err}>{error}</div>}

        <div style={s.grid}>
          {floodCard}

          {/* Coming soon cards */}
          <section style={s.card}>
            <div style={{ padding: 16, borderBottom: "1px solid #e2e8f0" }}>
              <h2 style={{ ...s.h2, margin: 0 }}>Earthquake</h2>
            </div>
            <div style={s.cardBody}>
              <div style={s.small}>Coming soon</div>
            </div>
          </section>

          <section style={s.card}>
            <div style={{ padding: 16, borderBottom: "1px solid #e2e8f0" }}>
              <h2 style={{ ...s.h2, margin: 0 }}>Landslide</h2>
            </div>
            <div style={s.cardBody}>
              <div style={s.small}>Coming soon</div>
            </div>
          </section>

          <section style={s.card}>
            <div style={{ padding: 16, borderBottom: "1px solid #e2e8f0" }}>
              <h2 style={{ ...s.h2, margin: 0 }}>Wildfire</h2>
            </div>
            <div style={s.cardBody}>
              <div style={s.small}>Coming soon</div>
            </div>
          </section>
        </div>

        <div style={s.foot}>
          ⚠️ Informational tool. Regulatory reference: FEMA NFHL / FIRM.
        </div>
      </main>
    </div>
  );
}
