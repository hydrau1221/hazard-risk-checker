"use client";

import { useState } from "react";

type Feature = { attributes: Record<string, any> };
type RiskLevel = "Very Low" | "Low" | "Moderate" | "High" | "Very High" | "Undetermined";

const LAYER_ID = 28; // FEMA NFHL - Flood Hazard Zones

// Palette unique pour toutes les cartes
const PALETTE: Record<RiskLevel, { bg: string; badge: string; text: string; border: string }> = {
  "Very Low":   { bg: "#dcfce7", badge: "#16a34a", text: "#14532d", border: "#86efac" },
  Low:          { bg: "#dbeafe", badge: "#1d4ed8", text: "#0c4a6e", border: "#93c5fd" },
  Moderate:     { bg: "#fef9c3", badge: "#ca8a04", text: "#854d0e", border: "#fde68a" },
  High:         { bg: "#ffedd5", badge: "#ea580c", text: "#7c2d12", border: "#fdba74" },
  "Very High":  { bg: "#fee2e2", badge: "#dc2626", text: "#7f1d1d", border: "#fecaca" },
  Undetermined: { bg: "#f3f4f6", badge: "#6b7280", text: "#374151", border: "#d1d5db" },
};

// ---------- Flood classification ----------
function classifyFlood(features: Feature[] | null): {
  level: RiskLevel; zone: string; sfha: boolean; bfe: string | null; note: string;
} {
  if (!features || features.length === 0) {
    return { level: "Very Low", zone: "N/A", sfha: false, bfe: null, note: "No NFHL polygon returned here" };
  }
  const a = features[0].attributes || {};
  const zone = String(a.FLD_ZONE ?? a.ZONE ?? a.ZONE_SUBTY ?? a.ZONE_SUBTYPE ?? "N/A").toUpperCase();
  const subty = String(a.ZONE_SUBTY ?? a.ZONE_SUBTYPE ?? a.ZONE ?? "").toUpperCase();
  const bfeRaw = a.BFE ?? a.STATIC_BFE ?? a.DEPTH ?? null;
  const bfe = bfeRaw == null || Number(bfeRaw) === -9999 ? null : String(bfeRaw);

  const inSFHA =
    a.SFHA_TF === true || a.SFHA_TF === "T" || a.SFHA_TF === "Y" ||
    ["A","AE","AO","AH","A1","A2","A3","A99","VE"].some(p => zone.startsWith(p));

  let level: RiskLevel, note = "";
  if (zone.startsWith("VE")) { level = "Very High"; note = "Coastal high hazard (wave action)"; }
  else if (["AO","AH","AE","A","A99"].includes(zone) || zone.startsWith("A1") || zone.startsWith("A2") || zone.startsWith("A3")) {
    level = "High"; note = "Special Flood Hazard Area (1% annual chance)";}
  else if (zone === "X" && subty.includes("0.2")) {
    level = "Moderate"; note = "0.2% annual chance flood (X shaded)"; }
  else if (zone === "X") {
    level = "Low"; note = "Outside SFHA (Zone X)"; }
  else if (zone === "D") {
    level = "Undetermined"; note = "Flood data is not available for this parcel (Zone D)"; }
  else {
    level = inSFHA ? "High" : "Low"; note = "See FEMA NFHL details"; }
  return { level, zone, sfha: inSFHA, bfe, note };
}

export default function Home() {
  const [address, setAddress] = useState("1600 Pennsylvania Ave NW, Washington, DC");
  const [loading, setLoading] = useState<"idle" | "geocode" | "fetch">("idle");

  // Flood
  const [floodLevel, setFloodLevel] = useState<RiskLevel | null>(null);
  const [floodText, setFloodText] = useState<string>("Enter your address and press Check.");

  // Earthquake
  const [eqLevel, setEqLevel] = useState<RiskLevel | null>(null);
  const [eqText, setEqText] = useState<string>("Coming soon");

  // Landslide
  const [lsLevel, setLsLevel] = useState<RiskLevel | null>(null);
  const [lsText, setLsText] = useState<string>("Coming soon");

  const [error, setError] = useState<string | null>(null);

  async function onCheck() {
    setError(null);
    setLoading("geocode");
    setFloodLevel(null); setFloodText("Geocoding address…");
    setEqLevel(null);    setEqText("Geocoding address…");
    setLsLevel(null);    setLsText("Geocoding address…");

    try {
      // 1) géocoder
      const g = await fetch(`/api/geocode?address=${encodeURIComponent(address)}`, { cache: "no-store" });
      const gj = await g.json();
      if (!g.ok) throw new Error(gj?.error || "Error fetching coordinates.");
      const { lat, lon } = gj as { lat: number; lon: number };

      setLoading("fetch");
      setFloodText("Querying FEMA NFHL…");
      setEqText("Querying USGS (Design Maps)…");
      setLsText("Querying NRI Landslide…");

      // 2) requêtes parallèles
      const [femaRes, eqRes, lsRes] = await Promise.allSettled([
        fetch(`/api/fema/query?lat=${lat}&lon=${lon}&layerId=${LAYER_ID}`, { cache: "no-store" }),
        fetch(`/api/earthquake/risk?lat=${lat}&lon=${lon}`, { cache: "no-store" }),
        fetch(`/api/landslide/risk?lat=${lat}&lon=${lon}`, { cache: "no-store" }),
      ]);

      // Flood
      if (femaRes.status === "fulfilled") {
        const r = femaRes.value; const j = await r.json();
        if (r.ok) {
          const res = classifyFlood(j.features ?? []);
          let line = `${res.level === "Undetermined" ? "UNDETERMINED" : `${res.level.toUpperCase()} RISK`} — Zone ${res.zone}`;
          if (res.bfe) line += ` | BFE/Depth: ${res.bfe} ft`;
          line += ` | ${res.note}`;
          setFloodLevel(res.level); setFloodText(line);
        } else { setFloodLevel(null); setFloodText(j?.error || "FEMA query failed."); }
      } else { setFloodLevel(null); setFloodText("FEMA fetch failed."); }

      // Earthquake
      if (eqRes.status === "fulfilled") {
        const r = eqRes.value; const j = await r.json();
        if (r.ok) {
          setEqLevel(j.level as RiskLevel);
          setEqText(`${(j.level as string).toUpperCase()} RISK — SDC ${j.sdc} (ASCE ${j.edition}, Site ${j.siteClass})`);
        } else { setEqLevel(null); setEqText(j?.error || "USGS query failed."); }
      } else { setEqLevel(null); setEqText("USGS fetch failed."); }

      // Landslide (NRI) — texte simplifié : "<LEVEL> risk susceptibility — score XX.X — source: tract|county"
      if (lsRes.status === "fulfilled") {
        const r = lsRes.value; const j = await r.json();

        if (r.ok) {
          const lvl = (j.level as RiskLevel) ?? "Undetermined";
          setLsLevel(lvl);

          const s =
            Number.isFinite(Number(j.score))
              ? Math.round(Number(j.score) * 10) / 10
              : null;

          const head = (lvl === "Undetermined")
            ? "UNDETERMINED"
            : `${String(lvl).toUpperCase()} RISK`;

          const scorePart = s !== null ? ` — score ${s}` : "";
          const srcPart = j.adminUnit ? ` — source: ${j.adminUnit}` : "";

          setLsText(`${head} susceptibility${scorePart}${srcPart}`);
        } else {
          setLsLevel(null);
          setLsText(j?.error || "NRI landslide query failed.");
        }
      } else {
        setLsLevel(null);
        setLsText("NRI landslide fetch failed.");
      }

    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setLoading("idle");
    }
  }

  // ---------- styles ----------
  const header   = { background: "#0b396b", color: "white", padding: "28px 16px", textAlign: "center" as const };
  const title    = { fontSize: 32, margin: 0 };
  const subtitle = { opacity: 0.9, marginTop: 8 };
  const bar      = { display: "flex", justifyContent: "center", gap: 8, marginTop: 16, flexWrap: "wrap" as const };
  const input    = { width: 420, maxWidth: "90vw", padding: "10px 12px", borderRadius: 6, border: "1px solid #cbd5e1" };
  const btn      = { padding: "10px 16px", borderRadius: 6, border: "1px solid #0b396b", background: "#114d8a", color: "white", cursor: "pointer" };
  const gridWrap = { background: "#eef2f6", minHeight: "calc(100vh - 120px)", padding: "28px 16px" };
  const grid     = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 20, maxWidth: 980, margin: "20px auto" };
  const card     = { background: "white", border: "1px solid #e2e8f0", borderRadius: 8, padding: 0, textAlign: "center" as const, boxShadow: "0 1px 2px rgba(0,0,0,0.05)", overflow: "hidden" };
  const sectionHeader = { padding: 16, borderBottom: "1px solid #e2e8f0" };
  const h2       = { margin: "0 0 10px 0", fontSize: 22 };
  const cardBody = { padding: 24 };
  const small    = { fontSize: 14, color: "#334155" };
  const foot     = { fontSize: 12, opacity: 0.6, textAlign: "center" as const, marginTop: 8 };

  const coloredHeader = (lvl: RiskLevel) => ({
    background: PALETTE[lvl].bg,
    color: PALETTE[lvl].text,
    borderBottom: `1px solid ${PALETTE[lvl].border}`,
    padding: "18px 16px",
  });
  const badge = (lvl: RiskLevel) => ({
    display: "inline-block",
    padding: "6px 10px",
    borderRadius: 999,
    background: PALETTE[lvl].badge,
    color: "white",
    fontWeight: 700,
  });

  const floodCard = floodLevel == null
    ? (<section style={card}><div style={sectionHeader}><h2 style={{ ...h2, margin: 0 }}>Flood</h2></div><div style={cardBody}><div style={small}>{floodText}</div></div></section>)
    : (<section style={{ ...card, border: `1px solid ${PALETTE[floodLevel].border}` }}>
        <div style={coloredHeader(floodLevel)}><h2 style={{ ...h2, margin: 0 }}>Flood</h2><div style={{ marginTop: 6 }}><span style={badge(floodLevel)}>{floodLevel === "Undetermined" ? "UNDETERMINED" : `${floodLevel.toUpperCase()} RISK`}</span></div></div>
        <div style={cardBody}><div style={small}>{floodText}</div></div>
      </section>);

  const eqCard = eqLevel == null
    ? (<section style={card}><div style={sectionHeader}><h2 style={{ ...h2, margin: 0 }}>Earthquake</h2></div><div style={cardBody}><div style={small}>{eqText}</div></div></section>)
    : (<section style={{ ...card, border: `1px solid ${PALETTE[eqLevel].border}` }}>
        <div style={coloredHeader(eqLevel)}><h2 style={{ ...h2, margin: 0 }}>Earthquake</h2><div style={{ marginTop: 6 }}><span style={badge(eqLevel)}>{`${eqLevel.toUpperCase()} RISK`}</span></div></div>
        <div style={cardBody}><div style={small}>{eqText}</div></div>
      </section>);

  const lsCard = lsLevel == null
    ? (<section style={card}><div style={sectionHeader}><h2 style={{ ...h2, margin: 0 }}>Landslide</h2></div><div style={cardBody}><div style={small}>{lsText}</div></div></section>)
    : (<section style={{ ...card, border: `1px solid ${PALETTE[lsLevel].border}` }}>
        <div style={coloredHeader(lsLevel)}><h2 style={{ ...h2, margin: 0 }}>Landslide</h2><div style={{ marginTop: 6 }}><span style={badge(lsLevel)}>{`${lsLevel.toUpperCase()} RISK`}</span></div></div>
        <div style={cardBody}><div style={small}>{lsText}</div></div>
      </section>);

  return (
    <div>
      <header style={header}>
        <h1 style={title}>Hydrau Risk Checker</h1>
        <div style={subtitle}>Enter your address to check your risks</div>
        <div style={bar}>
          <input style={input} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="123 Main St, City, State" />
          <button style={btn} onClick={onCheck} disabled={loading !== "idle"}>
            {loading === "idle" ? "Check" : loading === "geocode" ? "Geocoding…" : "Checking…"}
          </button>
        </div>
      </header>

      <main style={gridWrap}>
        {error && <div style={{ maxWidth: 980, margin: "12px auto 0", background: "#fee2e2", border: "1px solid #fecaca", color: "#7f1d1d", padding: 10, borderRadius: 6 }}>{error}</div>}
        <div style={grid}>
          {floodCard}
          {eqCard}
          {lsCard}
          <section style={card}><div style={sectionHeader}><h2 style={{ ...h2, margin: 0 }}>Wildfire</h2></div><div style={cardBody}><div style={small}>Coming soon</div></div></section>
        </div>
        <div style={foot}>⚠️ Informational tool. Sources: FEMA NFHL (Flood) • USGS Design Maps (Earthquake, Risk Cat I) • FEMA NRI (Landslide).</div>
      </main>
    </div>
  );
}
