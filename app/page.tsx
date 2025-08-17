"use client";

import { useState } from "react";

type Feature = { attributes: Record<string, any> };
type RiskLevel =
  | "Very Low" | "Low" | "Moderate" | "High" | "Very High"
  | "Undetermined" | "Not Applicable";

const LAYER_ID = 28; // FEMA NFHL - Flood Hazard Zones

const PALETTE: Record<RiskLevel, { bg: string; badge: string; text: string; border: string }> = {
  "Very Low":   { bg: "#dcfce7", badge: "#16a34a", text: "#14532d", border: "#86efac" },
  Low:          { bg: "#dbeafe", badge: "#1d4ed8", text: "#0c4a6e", border: "#93c5fd" },
  Moderate:     { bg: "#fef9c3", badge: "#ca8a04", text: "#854d0e", border: "#fde68a" },
  High:         { bg: "#ffedd5", badge: "#ea580c", text: "#7c2d12", border: "#fdba74" },
  "Very High":  { bg: "#fee2e2", badge: "#dc2626", text: "#7f1d1d", border: "#fecaca" },
  Undetermined: { bg: "#f3f4f6", badge: "#6b7280", text: "#374151", border: "#d1d5db" },
  "Not Applicable": { bg: "#f1f5f9", badge: "#64748b", text: "#334155", border: "#cbd5e1" },
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
  const subty = String(a.ZONE_SUBTY ?? a.ZONE_SUBTYPE ?? "").toUpperCase();

  const bfeRaw = a.BFE ?? a.STATIC_BFE ?? a.DEPTH ?? null;
  const bfe = bfeRaw == null || Number(bfeRaw) === -9999 ? null : String(bfeRaw);

  const inSFHA =
    a.SFHA_TF === true || a.SFHA_TF === "T" || a.SFHA_TF === "Y" ||
    ["A","AE","AO","AH","A1","A2","A3","A99","VE","V","V1"].some(p => zone.startsWith(p));

  const isFloodway = subty.includes("FLOODWAY");
  const isShadedX =
    zone === "X" &&
    (subty.includes("0.2") || subty.includes("0.2 PCT") || subty.includes("0.2%") || subty.includes("SHADED"));

  let level: RiskLevel, note = "";
  if (zone.startsWith("VE") || zone.startsWith("V")) { level = "Very High"; note = "Coastal high hazard (wave action)"; }
  else if (isFloodway) { level = "High"; note = "Regulatory floodway (within SFHA)"; }
  else if (["AO","AH","AE","A","A99"].includes(zone) || zone.startsWith("A1") || zone.startsWith("A2") || zone.startsWith("A3")) {
    level = "High"; note = "Special Flood Hazard Area (1% annual chance)"; }
  else if (isShadedX) {
    level = "Moderate"; note = "0.2% annual chance flood (Zone X shaded)"; }
  else if (zone === "X") {
    level = "Low"; note = "Outside SFHA (Zone X unshaded)"; }
  else if (zone === "D") {
    level = "Undetermined"; note = "Flood data not available (Zone D)"; }
  else {
    level = inSFHA ? "High" : "Low"; note = "See FEMA NFHL details"; }

  return { level, zone, sfha: inSFHA, bfe, note };
}

export default function Home() {
  const [address, setAddress] = useState("1600 Pennsylvania Ave NW, Washington, DC");
  const [loading, setLoading] = useState<"idle" | "geocode" | "fetch">("idle");

  // States
  const [floodLevel, setFloodLevel] = useState<RiskLevel | null>(null);
  const [floodText, setFloodText]   = useState("Enter your address and press Check.");
  const [eqLevel, setEqLevel]       = useState<RiskLevel | null>(null);
  const [eqText, setEqText]         = useState("Enter your address and press Check.");
  const [lsLevel, setLsLevel]       = useState<RiskLevel | null>(null);
  const [lsText, setLsText]         = useState("Enter your address and press Check.");

  const [wfLevel, setWfLevel]       = useState<RiskLevel | null>(null);
  const [wfText, setWfText]         = useState("Enter your address and press Check.");

  const [heatLevel, setHeatLevel]   = useState<RiskLevel | null>(null);
  const [heatText, setHeatText]     = useState("Enter your address and press Check.");
  const [coldLevel, setColdLevel]   = useState<RiskLevel | null>(null);
  const [coldText, setColdText]     = useState("Enter your address and press Check.");

  const [hurrLevel, setHurrLevel]   = useState<RiskLevel | null>(null);
  const [hurrText, setHurrText]     = useState("Enter your address and press Check.");
  const [torLevel, setTorLevel]     = useState<RiskLevel | null>(null);
  const [torText, setTorText]       = useState("Enter your address and press Check.");

  const [error, setError]           = useState<string | null>(null);
  const [geoNote, setGeoNote]       = useState<string | null>(null);

  function parseLatLon(s: string): {lat:number, lon:number} | null {
    const m = s.trim().match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!m) return null;
    const lat = Number(m[1]), lon = Number(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon };
  }

  async function onCheck() {
    setError(null);
    setGeoNote(null);
    setLoading("geocode");

    // reset
    setFloodLevel(null); setFloodText("Geocoding address…");
    setEqLevel(null);    setEqText("Geocoding address…");
    setLsLevel(null);    setLsText("Geocoding address…");
    setWfLevel(null);    setWfText("Geocoding address…");
    setHeatLevel(null);  setHeatText("Geocoding address…");
    setColdLevel(null);  setColdText("Geocoding address…");
    setHurrLevel(null);  setHurrText("Geocoding address…");
    setTorLevel(null);   setTorText("Geocoding address…");

    try {
      // lat,lon direct ?
      const ll = parseLatLon(address);
      let lat: number, lon: number;

      if (ll) { lat = ll.lat; lon = ll.lon; }
      else {
        const g = await fetch(`/api/geocode?address=${encodeURIComponent(address)}`, { cache: "no-store" });
        const gj = await g.json();
        if (!g.ok) throw new Error(gj?.error || "Error fetching coordinates.");
        lat = gj.lat; lon = gj.lon;

        if (gj?.precision === "city" || gj?.mode === "city") {
          const label = gj?.placeLabel || gj?.matched || gj?.display_name || "";
          setGeoNote(`Exact address not found. Using city centroid${label ? `: ${label}` : ""}. Results are generalized.`);
        }
      }

      setLoading("fetch");
      setFloodText("Querying FEMA NFHL…");
      setEqText("Querying USGS (Design Maps)…");
      setLsText("Querying NRI Landslide…");
      setWfText("Querying USFS Risk to Homes…");
      setHeatText("Querying NRI Heatwave…");
      setColdText("Querying NRI Cold Wave…");
      setHurrText("Querying NRI Hurricane…");
      setTorText("Querying NRI Tornado…");

      const [femaRes, eqRes, lsRes, wfRes, heatRes, coldRes, hurrRes, torRes] = await Promise.allSettled([
        fetch(`/api/fema/query?lat=${lat}&lon=${lon}&layerId=${LAYER_ID}`, { cache: "no-store" }),
        fetch(`/api/earthquake/risk?lat=${lat}&lon=${lon}`, { cache: "no-store" }),
        fetch(`/api/landslide/risk?lat=${lat}&lon=${lon}`, { cache: "no-store" }),
        fetch(`/api/wildfire/homes?lat=${lat}&lon=${lon}`, { cache: "no-store" }),
        fetch(`/api/heatwave/risk?lat=${lat}&lon=${lon}`, { cache: "no-store" }),
        fetch(`/api/coldwave/risk?lat=${lat}&lon=${lon}`, { cache: "no-store" }),
        fetch(`/api/hurricane/risk?lat=${lat}&lon=${lon}`, { cache: "no-store" }),
        fetch(`/api/tornado/risk?lat=${lat}&lon=${lon}`, { cache: "no-store" }),
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
        } else { setFloodLevel("Undetermined"); setFloodText(j?.error || "FEMA query failed."); }
      } else { setFloodLevel("Undetermined"); setFloodText("FEMA fetch failed."); }

      // Earthquake
      if (eqRes.status === "fulfilled") {
        const r = eqRes.value; const j = await r.json();
        if (r.ok) {
          setEqLevel(j.level as RiskLevel);
          setEqText(`${(j.level as string).toUpperCase()} RISK — SDC ${j.sdc} (ASCE ${j.edition}, Site ${j.siteClass})`);
        } else { setEqLevel("Undetermined"); setEqText(j?.error || "USGS query failed."); }
      } else { setEqLevel("Undetermined"); setEqText("USGS fetch failed."); }

      // Landslide
      if (lsRes.status === "fulfilled") {
        const r = lsRes.value; const j = await r.json();
        if (r.ok) {
          const lvl = (j.level as RiskLevel) ?? "Undetermined";
          setLsLevel(lvl);
          const s = Number.isFinite(Number(j.score)) ? Math.round(Number(j.score) * 10) / 10 : null;
          const head = (lvl === "Undetermined") ? "UNDETERMINED"
            : (lvl === "Not Applicable") ? "NOT APPLICABLE"
            : `${String(lvl).toUpperCase()} RISK`;
          const scorePart = s !== null ? ` — score ${s}` : "";
          const srcPart = j.adminUnit ? ` — source: ${j.adminUnit}` : "";
          setLsText(`${head} susceptibility${scorePart}${srcPart}`);
        } else { setLsLevel("Undetermined"); setLsText(j?.error || "NRI landslide query failed."); }
      } else { setLsLevel("Undetermined"); setLsText("NRI landslide fetch failed."); }

      // Wildfire — USFS RPS (avec voisinage si no-data)
      if (wfRes.status === "fulfilled") {
        const r = wfRes.value; const j = await r.json();
        if (r.ok) {
          const lvl = (j.level as RiskLevel) ?? "Undetermined";
          setWfLevel(lvl);
          const v = Number.isFinite(Number(j.value)) ? Math.round(Number(j.value)) : null;
          const head =
            (lvl === "Undetermined") ? "UNDETERMINED" :
            (lvl === "Not Applicable") ? "NOT APPLICABLE" :
            `${String(lvl).toUpperCase()}`; // <-- badge niveau seul
          const valPart = v !== null ? ` — RPS ${v}` : "";
          const note = j?.note ? ` — ${j.note}` : "";
          setWfText(`${head} to homes${valPart} — source: ${j.adminUnit || "pixel"}${note}`);
        } else { setWfLevel("Undetermined"); setWfText(j?.error || "USFS wildfire query failed."); }
      } else { setWfLevel("Undetermined"); setWfText("USFS wildfire fetch failed."); }

      // Heatwave
      if (heatRes.status === "fulfilled") {
        const r = heatRes.value; const j = await r.json();
        if (r.ok) {
          const lvl = (j.level as RiskLevel) ?? "Undetermined";
          setHeatLevel(lvl);
          const s = Number.isFinite(Number(j.score)) ? Math.round(Number(j.score) * 10) / 10 : null;
          const head = (lvl === "Undetermined") ? "UNDETERMINED"
            : (lvl === "Not Applicable") ? "NOT APPLICABLE"
            : `${String(lvl).toUpperCase()} RISK`;
          const scorePart = s !== null ? ` — score ${s}` : "";
          const srcPart = j.adminUnit ? ` — source: ${j.adminUnit}` : "";
          setHeatText(`${head}${scorePart}${srcPart}`);
        } else { setHeatLevel("Undetermined"); setHeatText(j?.error || "NRI heatwave query failed."); }
      } else { setHeatLevel("Undetermined"); setHeatText("NRI heatwave fetch failed."); }

      // Cold Wave
      if (coldRes.status === "fulfilled") {
        const r = coldRes.value; const j = await r.json();
        if (r.ok) {
          const lvl = (j.level as RiskLevel) ?? "Undetermined";
          setColdLevel(lvl);
          const s = Number.isFinite(Number(j.score)) ? Math.round(Number(j.score) * 10) / 10 : null;
          const head = (lvl === "Undetermined") ? "UNDETERMINED"
            : (lvl === "Not Applicable") ? "NOT APPLICABLE"
            : `${String(lvl).toUpperCase()} RISK`;
          const scorePart = s !== null ? ` — score ${s}` : "";
          const srcPart = j.adminUnit ? ` — source: ${j.adminUnit}` : "";
          setColdText(`${head}${scorePart}${srcPart}`);
        } else { setColdLevel("Undetermined"); setColdText(j?.error || "NRI cold wave query failed."); }
      } else { setColdLevel("Undetermined"); setColdText("NRI cold wave fetch failed."); }

      // Hurricane
      if (hurrRes.status === "fulfilled") {
        const r = hurrRes.value; const j = await r.json();
        if (r.ok) {
          const lvl = (j.level as RiskLevel) ?? "Undetermined";
          setHurrLevel(lvl);
          const s = Number.isFinite(Number(j.score)) ? Math.round(Number(j.score) * 10) / 10 : null;
          const head = (lvl === "Undetermined") ? "UNDETERMINED"
            : (lvl === "Not Applicable") ? "NOT APPLICABLE"
            : `${String(lvl).toUpperCase()} RISK`;
          const scorePart = s !== null ? ` — score ${s}` : "";
          const srcPart = j.adminUnit ? ` — source: ${j.adminUnit}` : "";
          setHurrText(`${head}${scorePart}${srcPart}`);
        } else { setHurrLevel("Undetermined"); setHurrText(j?.error || "NRI hurricane query failed."); }
      } else { setHurrLevel("Undetermined"); setHurrText("NRI hurricane fetch failed."); }

      // Tornado
      if (torRes.status === "fulfilled") {
        const r = torRes.value; const j = await r.json();
        if (r.ok) {
          const lvl = (j.level as RiskLevel) ?? "Undetermined";
          setTorLevel(lvl);
          const s = Number.isFinite(Number(j.score)) ? Math.round(Number(j.score) * 10) / 10 : null;
          const head = (lvl === "Undetermined") ? "UNDETERMINED"
            : (lvl === "Not Applicable") ? "NOT APPLICABLE"
            : `${String(lvl).toUpperCase()} RISK`;
          const scorePart = s !== null ? ` — score ${s}` : "";
          const srcPart = j.adminUnit ? ` — source: ${j.adminUnit}` : "";
          setTorText(`${head}${scorePart}${srcPart}`);
        } else { setTorLevel("Undetermined"); setTorText(j?.error || "NRI tornado query failed."); }
      } else { setTorLevel("Undetermined"); setTorText("NRI tornado fetch failed."); }

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
  const bar      = { display: "flex", justifyContent: "center", gap: 8, marginTop: 16, flexWrap: "wrap" as const, alignItems: "center" };
  const input    = { width: 420, maxWidth: "90vw", padding: "10px 12px", borderRadius: 6, border: "1px solid #cbd5e1" };
  const btn      = { padding: "10px 16px", borderRadius: 6, border: "1px solid #0b396b", background: "#114d8a", color: "white", cursor: "pointer" } as any;
  const gridWrap = { background: "#eef2f6", minHeight: "calc(100vh - 120px)", padding: "28px 16px" };
  const grid     = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 20, maxWidth: 1100, margin: "20px auto" };
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

  const makeCard = (title: string, level: RiskLevel | null, text: string, badgeMode: "level" | "risk" = "risk") => {
    if (level == null) {
      return (
        <section style={card}>
          <div style={sectionHeader}><h2 style={{ ...h2, margin: 0 }}>{title}</h2></div>
          <div style={cardBody}><div style={small} aria-live="polite">{text}</div></div>
        </section>
      );
    }
    const badgeText =
      level === "Undetermined" ? "UNDETERMINED" :
      level === "Not Applicable" ? "NOT APPLICABLE" :
      badgeMode === "level" ? level.toUpperCase() : `${level.toUpperCase()} RISK`;
    return (
      <section style={{ ...card, border: `1px solid ${PALETTE[level].border}` }}>
        <div style={coloredHeader(level)}>
          <h2 style={{ ...h2, margin: 0 }}>{title}</h2>
          <div style={{ marginTop: 6 }}><span style={badge(level)}>{badgeText}</span></div>
        </div>
        <div style={cardBody}><div style={small} aria-live="polite">{text}</div></div>
      </section>
    );
  };

  // Ordre demandé + badge wildfire = niveau seul
  const floodCard = makeCard("Flood",       floodLevel, floodText, "risk");
  const eqCard    = makeCard("Earthquake",  eqLevel,    eqText,    "risk");
  const lsCard    = makeCard("Landslide",   lsLevel,    lsText,    "risk");
  const wfCard    = makeCard("Wildfire",    wfLevel,    wfText,    "risk");
  const heatCard  = makeCard("Heatwave",    heatLevel,  heatText,  "risk");
  const coldCard  = makeCard("Cold Wave",   coldLevel,  coldText,  "risk");
  const hurrCard  = makeCard("Hurricane",   hurrLevel,  hurrText,  "risk");
  const torCard   = makeCard("Tornado",     torLevel,   torText,   "risk");

  return (
    <div>
      <header style={header}>
        <h1 style={title}>Hydrau Risk Checker</h1>
        <div style={subtitle}>Enter your address to check your risks</div>
        <div style={bar}>
          <input
            style={input}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="123 Main St, City, ST 12345 — or paste lat,lon"
            onKeyDown={(e) => { if (e.key === "Enter" && loading === "idle") onCheck(); }}
          />
          <button style={btn} onClick={onCheck} disabled={loading !== "idle"}>
            {loading === "idle" ? "Check" : loading === "geocode" ? "Geocoding…" : "Checking…"}
          </button>
        </div>
      </header>

      <main style={gridWrap}>
        {error && <div style={{ maxWidth: 1100, margin: "12px auto 0", background: "#fee2e2", border: "1px solid #fecaca", color: "#7f1d1d", padding: 10, borderRadius: 6 }}>{error}</div>}
        {geoNote && <div style={{ maxWidth: 1100, margin: "12px auto 10px", background: "#fef3c7", border: "1px solid #fde68a", color: "#78350f", padding: 10, borderRadius: 6 }}>{geoNote}</div>}

        <div style={grid}>
          {floodCard}
          {eqCard}
          {lsCard}
          {wfCard}
          {heatCard}
          {coldCard}
          {hurrCard}
          {torCard}
        </div>

        <div style={foot}>
          ⚠️ Informational tool. Sources: FEMA NFHL (Flood) • USGS Design Maps (Earthquake, Risk Cat I) •
          FEMA NRI (Landslide, Heatwave, Cold Wave, Hurricane, Tornado) • USFS Wildfire Risk to Communities (Wildfire – Risk to Homes).
        </div>
      </main>
    </div>
  );
}
