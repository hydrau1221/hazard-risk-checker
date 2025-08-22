"use client";

import { useState } from "react";

type Feature = { attributes: Record<string, any> };
type RiskLevel =
  | "Very Low" | "Low" | "Moderate" | "High" | "Very High"
  | "Undetermined" | "Not Applicable";

// ====== CONFIG ======
const FIVERR_URL = "https://fr.fiverr.com/s/dD1zYLG"; // <-- remplace par ton lien Fiverr

// Périls qui déclenchent la CTA (si niveau ≥ Moderate)
const CTA_HAZARDS = new Set(["Flood", "Earthquake", "Landslide", "Wildfire", "Hurricane", "Tornado"]);

// Palette unique (inclut Not Applicable)
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

  // évalue une feature et retourne un rang de sévérité
  const evalOne = (a: Record<string, any>) => {
    const zone = String(a.FLD_ZONE ?? a.ZONE ?? a.ZONE_SUBTY ?? a.ZONE_SUBTYPE ?? "N/A").toUpperCase();
    const subty = String(a.ZONE_SUBTY ?? a.ZONE_SUBTYPE ?? "").toUpperCase();

    const bfeRaw = a.BFE ?? a.STATIC_BFE ?? a.DEPTH ?? null;
    const bfe = bfeRaw == null || Number(bfeRaw) === -9999 ? null : String(bfeRaw);

    const inSFHA =
      a.SFHA_TF === true || a.SFHA_TF === "T" || a.SFHA_TF === "Y" ||
      ["A","AE","AO","AH","A1","A2","A3","A99","VE","V","V1"].some(p => zone.startsWith(p));

    const isFloodway = subty.includes("FLOODWAY");
    const isShadedX =
      zone === "X" && (subty.includes("0.2") || subty.includes("0.2 PCT") || subty.includes("0.2%") || subty.includes("SHADED"));

    let level: RiskLevel, note = "";
    if (zone.startsWith("VE") || zone.startsWith("V")) { level = "Very High"; note = "Coastal high hazard (wave action)"; }
    else if (isFloodway) { level = "High"; note = "Regulatory floodway (within SFHA)"; }
    else if (["AO","AH","AE","A","A99"].includes(zone) || /^A\d/.test(zone)) {
      level = "High"; note = "Special Flood Hazard Area (1% annual chance)";
    }
    else if (isShadedX) { level = "Moderate"; note = "0.2% annual chance flood (Zone X shaded)"; }
    else if (zone === "X") { level = "Low"; note = "Outside SFHA (Zone X unshaded)"; }
    else if (zone === "D") { level = "Undetermined"; note = "Flood data not available (Zone D)"; }
    else { level = inSFHA ? "High" : "Low"; note = "See FEMA NFHL details"; }

    const rank = level === "Very High" ? 5 : level === "High" ? 4 : level === "Moderate" ? 3 : level === "Low" ? 2 : 1;
    return { level, zone, bfe, note, inSFHA, rank };
  };

  // garde la feature la plus “risquée”
  let best = { level: "Very Low" as RiskLevel, zone: "N/A", bfe: null as string | null, note: "", inSFHA: false, rank: 0 };
  for (const f of features) {
    if (!f?.attributes) continue;
    const cur = evalOne(f.attributes);
    if (cur.rank > best.rank) best = cur as any;
  }

  return { level: best.level, zone: best.zone, sfha: best.inSFHA, bfe: best.bfe, note: best.note };
}

// Sécurise la lecture JSON
async function safeJson(r: Response) {
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const t = await r.text();
    return { __nonjson: true, text: t };
  }
  try { return await r.json(); } catch { const t = await r.text(); return { __nonjson: true, text: t }; }
}

export default function Home() {
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState<"idle" | "geocode" | "fetch">("idle");

  const [error, setError] = useState<string | null>(null);
  const [geoNote, setGeoNote] = useState<string | null>(null);
  const [geoPrecision, setGeoPrecision] = useState<"address" | "city" | null>(null); // <- pour activer/désactiver CTA

  // Flood
  const [floodLevel, setFloodLevel] = useState<RiskLevel | null>(null);
  const [floodText, setFloodText]   = useState<string>("Enter your address to see your hazard risk");

  // Earthquake
  const [eqLevel, setEqLevel] = useState<RiskLevel | null>(null);
  const [eqText,  setEqText]  = useState<string>("Enter your address to see your hazard risk");

  // Landslide (NRI)
  const [lsLevel, setLsLevel] = useState<RiskLevel | null>(null);
  const [lsText,  setLsText]  = useState<string>("Enter your address to see your hazard risk");

  // Wildfire (NRI)
  const [wfLevel, setWfLevel] = useState<RiskLevel | null>(null);
  const [wfText,  setWfText]  = useState<string>("Enter your address to see your hazard risk");

  // Heatwave (NRI)
  const [heatLevel, setHeatLevel] = useState<RiskLevel | null>(null);
  const [heatText,  setHeatText]  = useState<string>("Enter your address to see your hazard risk");

  // Cold Wave (NRI)
  const [coldLevel, setColdLevel] = useState<RiskLevel | null>(null);
  const [coldText,  setColdText]  = useState<string>("Enter your address to see your hazard risk");

  // Hurricane (NRI)
  const [hurrLevel, setHurrLevel] = useState<RiskLevel | null>(null);
  const [hurrText,  setHurrText]  = useState<string>("Enter your address to see your hazard risk");

  // Tornado (NRI)
  const [torLevel, setTorLevel] = useState<RiskLevel | null>(null);
  const [torText,  setTorText]  = useState<string>("Enter your address to see your hazard risk");

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
    setGeoPrecision(null);
    setLoading("geocode");

    const geoMsg = "Geocoding address…";
    setFloodLevel(null); setFloodText(geoMsg);
    setEqLevel(null);    setEqText(geoMsg);
    setLsLevel(null);    setLsText(geoMsg);
    setWfLevel(null);    setWfText(geoMsg);
    setHeatLevel(null);  setHeatText(geoMsg);
    setColdLevel(null);  setColdText(geoMsg);
    setHurrLevel(null);  setHurrText(geoMsg);
    setTorLevel(null);   setTorText(geoMsg);

    try {
      // 1) lat,lon direct ?
      const ll = parseLatLon(address);
      let lat: number, lon: number;

      if (ll) {
        lat = ll.lat; lon = ll.lon;
        setGeoPrecision("address");
      } else {
        // géocoder
        const g = await fetch(`/api/geocode?address=${encodeURIComponent(address)}`, { cache: "no-store" });
        const gj = await g.json();
        if (!g.ok) throw new Error(gj?.error || "Error fetching coordinates.");
        lat = gj.lat; lon = gj.lon;
        const precision = (gj?.precision === "city") ? "city" : "address";
        setGeoPrecision(precision);
        if (precision === "city") setGeoNote(`Using city centroid${gj?.placeLabel ? `: ${gj.placeLabel}` : ""}. Results are generalized.`);
      }

      setLoading("fetch");
      setFloodText("Querying FEMA NFHL…");
      setEqText("Querying USGS (Design Maps)…");
      setLsText("Querying NRI Landslide…");
      setWfText("Querying NRI Wildfire…");
      setHeatText("Querying NRI Heatwave…");
      setColdText("Querying NRI Cold Wave…");
      setHurrText("Querying Hurricane…");
      setTorText("Querying NRI Tornado…");

      // 2) requêtes parallèles
      const [femaRes, eqRes, lsRes, wfRes, heatRes, coldRes, hurrRes, torRes] = await Promise.allSettled([
        fetch(`/api/fema/query?lat=${lat}&lon=${lon}`, { cache: "no-store" }),
        fetch(`/api/earthquake/risk?lat=${lat}&lon=${lon}`, { cache: "no-store" }),
        fetch(`/api/landslide/risk?lat=${lat}&lon=${lon}`, { cache: "no-store" }),
        fetch(`/api/wildfire/risk?lat=${lat}&lon=${lon}`, { cache: "no-store" }),
        fetch(`/api/heatwave/risk?lat=${lat}&lon=${lon}`, { cache: "no-store" }),
        fetch(`/api/coldwave/risk?lat=${lat}&lon=${lon}`, { cache: "no-store" }),
        fetch(`/api/hurricane/risk?lat=${lat}&lon=${lon}`, { cache: "no-store" }),
        fetch(`/api/tornado/risk?lat=${lat}&lon=${lon}`, { cache: "no-store" }),
      ]);

      // Flood (texte SANS le prefixe du niveau)
      if (femaRes.status === "fulfilled") {
        const r = femaRes.value; const j = await r.json();
        if (r.ok) {
          const res = classifyFlood(j.features ?? []);
          let line = `Zone ${res.zone}`;
          if (res.bfe) line += ` | BFE/Depth: ${res.bfe} ft`;
          if (res.note) line += ` | ${res.note}`;
          setFloodLevel(res.level); setFloodText(line);
        } else { setFloodLevel(null); setFloodText(j?.error || "FEMA query failed."); }
      } else { setFloodLevel(null); setFloodText("FEMA fetch failed."); }

      // Earthquake
      if (eqRes.status === "fulfilled") {
        const r = eqRes.value; const j = await r.json();
        if (r.ok) {
          setEqLevel(j.level as RiskLevel);
          setEqText(`SDC ${j.sdc} (ASCE ${j.edition}, Site ${j.siteClass})`);
        } else { setEqLevel(null); setEqText(j?.error || "USGS query failed."); }
      } else { setEqLevel(null); setEqText("USGS fetch failed."); }

      // -------- Helper NRI --------
      const formatNri = (lvl: RiskLevel, score: any, tractId?: string | null) => {
        if (lvl === "Undetermined" || lvl === "Not Applicable") return "";
        const word = `${String(lvl).toLowerCase()} risk`;
        const levelWord = word.charAt(0).toUpperCase() + word.slice(1);
        const parts: string[] = [`${levelWord} susceptibility`];
        const s = Number.isFinite(Number(score)) ? Math.round(Number(score) * 10) / 10 : null;
        if (s !== null) parts.push(`score ${s}`);
        if (tractId) parts.push(`tract ${tractId}`);
        return parts.join(" — ");
      };

      // Landslide (NRI)
      if (lsRes.status === "fulfilled") {
        const r = lsRes.value; const j = await r.json();
        if (r.ok) { const lvl = (j.level as RiskLevel) ?? "Undetermined"; setLsLevel(lvl); setLsText(formatNri(lvl, j.score, j.tractId || null)); }
        else { setLsLevel(null); setLsText(j?.error || "NRI landslide query failed."); }
      } else { setLsLevel(null); setLsText("NRI landslide fetch failed."); }

      // Wildfire (NRI)
      if (wfRes.status === "fulfilled") {
        const r = wfRes.value; const j = await safeJson(r);
        if (r.ok && !j?.__nonjson) { const lvl = (j.level as RiskLevel) ?? "Undetermined"; setWfLevel(lvl); setWfText(formatNri(lvl, j.score, j.tractId || null)); }
        else { setWfLevel(null); setWfText("NRI wildfire query failed."); }
      } else { setWfLevel(null); setWfText("NRI wildfire fetch failed."); }

      // Heatwave (NRI)
      if (heatRes.status === "fulfilled") {
        const r = heatRes.value; const j = await r.json();
        if (r.ok) { const lvl = (j.level as RiskLevel) ?? "Undetermined"; setHeatLevel(lvl); setHeatText(formatNri(lvl, j.score, j.tractId || null)); }
        else { setHeatLevel(null); setHeatText(j?.error || "NRI heatwave query failed."); }
      } else { setHeatLevel(null); setHeatText("NRI heatwave fetch failed."); }

      // Cold Wave (NRI)
      if (coldRes.status === "fulfilled") {
        const r = coldRes.value; const j = await r.json();
        if (r.ok) { const lvl = (j.level as RiskLevel) ?? "Undetermined"; setColdLevel(lvl); setColdText(formatNri(lvl, j.score, j.tractId || null)); }
        else { setColdLevel(null); setColdText(j?.error || "NRI cold wave query failed."); }
      } else { setColdLevel(null); setColdText("NRI cold wave fetch failed."); }

      // Hurricane (NRI)
      if (hurrRes.status === "fulfilled") {
        const r = hurrRes.value; const j = await r.json();
        if (r.ok) { const lvl = (j.level as RiskLevel) ?? "Undetermined"; setHurrLevel(lvl); setHurrText(formatNri(lvl, j.score, j.tractId || null)); }
        else { setHurrLevel(null); setHurrText(j?.error || "Hurricane query failed."); }
      } else { setHurrLevel(null); setHurrText("Hurricane fetch failed."); }

      // Tornado (NRI)
      if (torRes.status === "fulfilled") {
        const r = torRes.value; const j = await r.json();
        if (r.ok) { const lvl = (j.level as RiskLevel) ?? "Undetermined"; setTorLevel(lvl); setTorText(formatNri(lvl, j.score, j.tractId || null)); }
        else { setTorLevel(null); setTorText(j?.error || "NRI tornado query failed."); }
      } else { setTorLevel(null); setTorText("NRI tornado fetch failed."); }

    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setLoading("idle");
    }
  }

  // ---------- CTA helpers ----------
  const ctaBtnStyle: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: 6,
    padding: "8px 12px", borderRadius: 10,
    background: "#2d2d2d", color: "#f5f5f5",
    textDecoration: "none", fontSize: 14, marginTop: 12
  };

  function shouldShowCTA(hazard: string, lvl: RiskLevel | null) {
    if (geoPrecision !== "address") return false;            // pas de CTA si centroid
    if (!lvl) return false;
    if (!CTA_HAZARDS.has(hazard)) return false;
    return lvl === "Moderate" || lvl === "High" || lvl === "Very High";
  }

  function buildFiverrUrl(hazard: string, lvl: RiskLevel) {
    const params = new URLSearchParams({
      utm_source: "app",
      utm_medium: "cta",
      utm_campaign: "per_card",
      hazard: hazard.toLowerCase(),
      level: lvl.replace(/\s+/g, "_").toLowerCase(),
    });
    return `${FIVERR_URL}?${params.toString()}`;
  }

  function CTA(hazard: string, lvl: RiskLevel | null) {
    if (!lvl || !shouldShowCTA(hazard, lvl)) return null;
    return (
      <div>
        <a href={buildFiverrUrl(hazard, lvl)} target="_blank" rel="noopener noreferrer" style={ctaBtnStyle} aria-label={`Get help for ${hazard} risk`}>
          <span role="img" aria-hidden>🔎</span>
          <span>Need help?</span>
        </a>
      </div>
    );
  }

  // CTA mémo (centroïde)
  const showMemoCTA = geoPrecision === "city" && loading === "idle" && !error;

  // ---------- styles ----------
  const header   = { background: "#121212", color: "#e0e0e0", padding: "28px 16px", textAlign: "center" as const };
  const title    = { fontSize: 32, margin: 0, color: "#e0e0e0" };
  const beta     = { marginLeft: 8, fontSize: 12, padding: "3px 8px", borderRadius: 999, border: "1px solid #3a3a3a", color: "#cbd5e1" };
  const subtitle = { opacity: 0.9, marginTop: 6, fontStyle: "italic" as const, color: "#e0e0e0" };
  const tagline  = { opacity: 0.9, marginTop: 8, color: "#e0e0e0" };
  const bar      = { display: "flex", justifyContent: "center", gap: 8, marginTop: 16, flexWrap: "wrap" as const, alignItems: "center" };
  const input    = { width: 520, maxWidth: "92vw", padding: "10px 12px", borderRadius: 6, border: "1px solid #cbd5e1" };
  const btn      = { padding: "10px 16px", borderRadius: 6, border: "1px solid #2d2d2d", background: "#2d2d2d", color: "#e0e0e0", cursor: "pointer" } as any;
  const hint     = { fontSize: 12, color: "#e0e0e0", opacity: 0.8, marginTop: 6 };

  const gridWrap = { background: "#e0e0e0", minHeight: "calc(100vh - 120px)", padding: "28px 16px" };
  const grid     = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 20, maxWidth: 1100, margin: "20px auto" };
  const card     = { background: "white", border: "1px solid "#e2e8f0", borderRadius: 8, padding: 0, textAlign: "center" as const, boxShadow: "0 1px 2px rgba(0,0,0,0.05)", overflow: "hidden" };
  const sectionHeader = { padding: 16, borderBottom: "1px solid #e2e8f0", color: "#111827" };
  const h2            = { margin: "0 0 10px 0", fontSize: 22, color: "#111827" };
  const cardBody = { padding: 24 };
  const small    = { fontSize: 14, color: "#334155" };
  const foot     = { fontSize: 12, opacity: 0.7, textAlign: "center" as const, marginTop: 8, color: "#374151" };

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

  const cardShell = (title: string, text: string) => (
    <section style={card}>
      <div style={sectionHeader}><h2 style={{ ...h2, margin: 0 }}>{title}</h2></div>
      <div style={cardBody}><div style={small} aria-live="polite">{text}</div></div>
    </section>
  );
  const levelCard = (title: string, lvl: RiskLevel, text: string) => (
    <section style={{ ...card, border: `1px solid ${PALETTE[lvl].border}` }}>
      <div style={coloredHeader(lvl)}>
        <h2 style={{ ...h2, margin: 0 }}>{title}</h2>
        <div style={{ marginTop: 6 }}>
          <span style={badge(lvl)}>
            {lvl === "Undetermined" ? "UNDETERMINED"
              : lvl === "Not Applicable" ? "NOT APPLICABLE"
              : `${lvl.toUpperCase()} RISK`}
          </span>
        </div>
      </div>
      <div style={cardBody}>
        <div style={small} aria-live="polite">{text}</div>
        {/* CTA par carte */}
        {CTA(title, lvl)}
      </div>
    </section>
  );

  // Ordre: Flood → EQ → Landslide → Wildfire → Heatwave → Cold Wave → Hurricane → Tornado
  const floodCard = floodLevel == null ? cardShell("Flood", floodText) : levelCard("Flood", floodLevel, floodText);
  const eqCard    = eqLevel    == null ? cardShell("Earthquake", eqText) : levelCard("Earthquake", eqLevel!, eqText);
  const lsCard    = lsLevel    == null ? cardShell("Landslide", lsText) : levelCard("Landslide", lsLevel!, lsText);
  const wfCard    = wfLevel    == null ? cardShell("Wildfire", wfText) : levelCard("Wildfire", wfLevel!, wfText);
  const heatCard  = heatLevel  == null ? cardShell("Heatwave", heatText) : levelCard("Heatwave", heatLevel!, heatText);
  const coldCard  = coldLevel  == null ? cardShell("Cold Wave", coldText) : levelCard("Cold Wave", coldLevel!, coldText);
  const hurrCard  = hurrLevel  == null ? cardShell("Hurricane", hurrText) : levelCard("Hurricane", hurrLevel!, hurrText);
  const torCard   = torLevel   == null ? cardShell("Tornado", torText) : levelCard("Tornado", torLevel!, torText);

  return (
    <div>
      <header style={header}>
        <h1 style={title}>Hazard Risk Checker <span style={beta}>BETA</span></h1>
        <div style={subtitle}>by Hydrau</div>
        <div style={tagline}>Enter your address to see your hazard risk</div>
        <div style={bar}>
          <input
            style={input}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="e.g. 1600 Pennsylvania Ave NW, Washington, DC"
            onKeyDown={(e) => { if (e.key === "Enter" && loading === "idle") onCheck(); }}
          />
          <button style={btn} onClick={onCheck} disabled={loading !== "idle"}>
            {loading === "idle" ? "Check" : loading === "geocode" ? "Geocoding…" : "Checking…"}
          </button>
        </div>
        <div style={hint}>Your street, city, or county (US only)</div>
      </header>

      <main style={gridWrap}>
        {error && (
          <div style={{ maxWidth: 1100, margin: "12px auto 0", background: "#fee2e2", border: "1px solid #fecaca", color: "#7f1d1d", padding: 10, borderRadius: 6 }}>
            {error}
          </div>
        )}
        {geoNote && (
          <div
            style={{
              maxWidth: 1100,
              margin: "12px auto 0",
              background: "#fef3c7",
              border: "1px solid #fde68a",
              color: "#78350f",
              padding: 10,
              borderRadius: 6,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <span>{geoNote}</span>

            {showMemoCTA && (
              <a
                href={FIVERR_URL}
                target="_blank"
                rel="noopener noreferrer"
                style={ctaBtnStyle}
              >
                <span role="img" aria-hidden>🔎</span>
                <span>Need more precision?</span>
              </a>
            )}
          </div>
        )}

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
          ⚠️ Informational tool. Sources: FEMA NFHL (Flood) • USGS Design Maps (Earthquake, Risk Cat I) • FEMA NRI (Landslide, Wildfire, Heatwave, Cold Wave, Tornado).
        </div>
      </main>
    </div>
  );
}
