"use client";

import { useState } from "react";

type Feature = { attributes: Record<string, any> };
type RiskLevel =
  | "Very Low" | "Low" | "Moderate" | "High" | "Very High"
  | "Undetermined" | "Not Applicable";

const LAYER_ID = 28; // FEMA NFHL - Flood Hazard Zones

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
  else if (isShadedX) { level = "Moderate"; note = "0.2% annual chance flood (Zone X shaded)"; }
  else if (zone === "X") { level = "Low"; note = "Outside SFHA (Zone X unshaded)"; }
  else if (zone === "D") { level = "Undetermined"; note = "Flood data not available (Zone D)"; }
  else { level = inSFHA ? "High" : "Low"; note = "See FEMA NFHL details"; }

  return { level, zone, sfha: inSFHA, bfe, note };
}

// Sécurise la lecture JSON (cas d’erreurs HTML renvoyées par des proxys)
async function safeJson(r: Response) {
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const t = await r.text();
    return { __nonjson: true, text: t };
  }
  try { return await r.json(); } catch { const t = await r.text(); return { __nonjson: true, text: t }; }
}

// -------- Helper NRI (formatage de texte uniforme) --------
function formatNri(lvl: RiskLevel, score: any, tractId?: string | null) {
  if (lvl === "Undetermined" || lvl === "Not Applicable") return "";
  const word = `${String(lvl).toLowerCase()} risk`;
  const levelWord = word.charAt(0).toUpperCase() + word.slice(1); // "Low risk"
  const parts: string[] = [`${levelWord} susceptibility`];
  const s = Number.isFinite(Number(score)) ? Math.round(Number(score) * 10) / 10 : null;
  if (s !== null) parts.push(`score ${s}`);
  if (tractId) parts.push(`tract ${tractId}`);
  return parts.join(" — ");
}

export default function Home() {
  const [address, setAddress] = useState("1600 Pennsylvania Ave NW, Washington, DC");
  const [loading, setLoading] = useState<"idle" | "geocode" | "fetch">("idle");

  const [error, setError] = useState<string | null>(null);
  const [geoNote, setGeoNote] = useState<string | null>(null);

  // Flood
  const [floodLevel, setFloodLevel] = useState<RiskLevel | null>(null);
  const [floodText, setFloodText]   = useState<string>("Enter your address to check your risk exposure.");

  // Earthquake
  const [eqLevel, setEqLevel] = useState<RiskLevel | null>(null);
  const [eqText,  setEqText]  = useState<string>("Enter your address to check your risk exposure.");

  // Landslide (NRI)
  const [lsLevel, setLsLevel] = useState<RiskLevel | null>(null);
  const [lsText,  setLsText]  = useState<string>("Enter your address to check your risk exposure.");

  // Wildfire (NRI)
  const [wfLevel, setWfLevel] = useState<RiskLevel | null>(null);
  const [wfText,  setWfText]  = useState<string>("Enter your address to check your risk exposure.");

  // Heatwave (NRI)
  const [heatLevel, setHeatLevel] = useState<RiskLevel | null>(null);
  const [heatText,  setHeatText]  = useState<string>("Enter your address to check your risk exposure.");

  // Cold Wave (NRI)
  const [coldLevel, setColdLevel] = useState<RiskLevel | null>(null);
  const [coldText,  setColdText]  = useState<string>("Enter your address to check your risk exposure.");

  // Hurricane (NRI ou autre)
  const [hurrLevel, setHurrLevel] = useState<RiskLevel | null>(null);
  const [hurrText,  setHurrText]  = useState<string>("Enter your address to check your risk exposure.");

  // Tornado (NRI)
  const [torLevel, setTorLevel] = useState<RiskLevel | null>(null);
  const [torText,  setTorText]  = useState<string>("Enter your address to check your risk exposure.");

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
      } else {
        // géocoder
        const g = await fetch(`/api/geocode?address=${encodeURIComponent(address)}`, { cache: "no-store" });
        const gj = await g.json();
        if (!g.ok) throw new Error(gj?.error || "Error fetching coordinates.");
        lat = gj.lat; lon = gj.lon;
        if (gj?.precision === "city") setGeoNote(`Using city centroid${gj?.placeLabel ? `: ${gj.placeLabel}` : ""}. Results are generalized.`);
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
        fetch(`/api/fema/query?lat=${lat}&lon=${lon}&layerId=${LAYER_ID}`, { cache: "no-store" }),
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

      // Earthquake (texte SANS le prefixe du niveau)
      if (eqRes.status === "fulfilled") {
        const r = eqRes.value; const j = await r.json();
        if (r.ok) {
          setEqLevel(j.level as RiskLevel);
          setEqText(`SDC ${j.sdc} (ASCE ${j.edition}, Site ${j.siteClass})`);
        } else { setEqLevel(null); setEqText(j?.error || "USGS query failed."); }
      } else { setEqLevel(null); setEqText("USGS fetch failed."); }

      // Landslide (NRI)
      if (lsRes.status === "fulfilled") {
        const r = lsRes.value; const j = await r.json();
        if (r.ok) {
          const lvl = (j.level as RiskLevel) ?? "Undetermined";
          setLsLevel(lvl);
          setLsText(formatNri(lvl, j.score, j.tractId || null));
        } else { setLsLevel(null); setLsText(j?.error || "NRI landslide query failed."); }
      } else { setLsLevel(null); setLsText("NRI landslide fetch failed."); }

      // Wildfire (NRI)
      if (wfRes.status === "fulfilled") {
        const r = wfRes.value; const j = await safeJson(r);
        if (r.ok && !j?.__nonjson) {
          const lvl = (j.level as RiskLevel) ?? "Undetermined";
          setWfLevel(lvl);
          setWfText(formatNri(lvl, j.score, j.tractId || null));
        } else { setWfLevel(null); setWfText("NRI wildfire query failed."); }
      } else { setWfLevel(null); setWfText("NRI wildfire fetch failed."); }

      // Heatwave (NRI)
      if (heatRes.status === "fulfilled") {
        const r = heatRes.value; const j = await r.json();
        if (r.ok) {
          const lvl = (j.level as RiskLevel) ?? "Undetermined";
          setHeatLevel(lvl);
          setHeatText(formatNri(lvl, j.score, j.tractId || null));
        } else { setHeatLevel(null); setHeatText(j?.error || "NRI heatwave query failed."); }
      } else { setHeatLevel(null); setHeatText("NRI heatwave fetch failed."); }

      // Cold Wave (NRI)
      if (coldRes.status === "fulfilled") {
        const r = coldRes.value; const j = await r.json();
        if (r.ok) {
          const lvl = (j.level as RiskLevel) ?? "Undetermined";
          setColdLevel(lvl);
          setColdText(formatNri(lvl, j.score, j.tractId || null));
        } else { setColdLevel(null); setColdText(j?.error || "NRI cold wave query failed."); }
      } else { setColdLevel(null); setColdText("NRI cold wave fetch failed."); }

      // Hurricane (selon ta route)
      if (hurrRes.status === "fulfilled") {
        const r = hurrRes.value; const j = await r.json();
        if (r.ok) {
          const lvl = (j.level as RiskLevel) ?? "Undetermined";
          setHurrLevel(lvl);
          setHurrText(formatNri(lvl, j.score, j.tractId || null));
        } else { setHurrLevel(null); setHurrText(j?.error || "Hurricane query failed."); }
      } else { setHurrLevel(null); setHurrText("Hurricane fetch failed."); }

      // Tornado (NRI)
      if (torRes.status === "fulfilled") {
        const r = torRes.value; const j = await r.json();
        if (r.ok) {
          const lvl = (j.level as RiskLevel) ?? "Undetermined";
          setTorLevel(lvl);
          setTorText(formatNri(lvl, j.score, j.tractId || null));
        } else { setTorLevel(null); setTorText(j?.error || "NRI tornado query failed."); }
      } else { setTorLevel(null); setTorText("NRI tornado fetch failed."); }

    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setLoading("idle");
    }
  }

  // ---------- styles (branding) ----------
  const header = {
    background: "#121212",
    color: "#e5e7eb",
    padding: "36px 16px 28px",
    textAlign: "center" as const,
    borderBottom: "1px solid rgba(255,255,255,0.08)",
  };
  const title = { fontSize: 34, lineHeight: 1.15, margin: 0, letterSpacing: 0.2 } as const;
  const beta  = {
    display: "inline-block",
    marginLeft: 10,
    padding: "2px 8px",
    fontSize: 12,
    borderRadius: 999,
    background: "rgba(255,255,255,0.08)",
    border: "1px solid rgba(255,255,255,0.12)",
    verticalAlign: "middle" as const,
  };
  const subtitle = { opacity: 0.9, marginTop: 6, fontStyle: "italic" as const, color: "#cbd5e1" };
  const tagline  = { opacity: 0.9, marginTop: 10, color: "#e5e7eb" };
  const bar      = { display: "flex", justifyContent: "center", gap: 8, marginTop: 18, flexWrap: "wrap" as const, alignItems: "center" };

  // Input sans icône + padding propre
  const input = {
    width: 560,
    maxWidth: "92vw",
    padding: "12px 14px",
    borderRadius: 10,
    border: "1px solid #475569",
    background: "rgba(17,24,39,0.35)",
    color: "#e5e7eb",
    outline: "none",
    transition: "border-color .15s ease, box-shadow .15s ease",
  } as const;

  const btn = {
    padding: "12px 18px", borderRadius: 10, border: "1px solid #1f2937",
    background: "#1f2937", color: "#e5e7eb", cursor: "pointer",
    fontWeight: 600, transition: "transform .08s ease",
  } as const;
  const hint     = { fontSize: 12, color: "#cbd5e1", opacity: 0.85, marginTop: 8 };

  const gridWrap = { background: "#f3f4f6", minHeight: "calc(100vh - 140px)", padding: "28px 16px" };
  const grid     = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 22, maxWidth: 1100, margin: "24px auto" };
  const card     = {
    background: "white", border: "1px solid #e5e7eb", borderRadius: 14, padding: 0,
    textAlign: "center" as const, boxShadow: "0 6px 16px rgba(0,0,0,0.04)", overflow: "hidden",
    transition: "transform .12s ease, box-shadow .12s ease",
  };
  const sectionHeader = { padding: 16, borderBottom: "1px solid #e5e7eb", color: "#0f172a" };
  const h2            = { margin: "0 0 10px 0", fontSize: 20, color: "#0f172a", letterSpacing: 0.2 };
  const cardBody = { padding: 22 };
  const small    = { fontSize: 14, color: "#334155" };
  const footWrap = { maxWidth: 1100, margin: "8px auto 0", textAlign: "center" as const };
  const foot     = { fontSize: 12, opacity: 0.75, color: "#374151" };

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
    fontWeight: 800 as const,
    letterSpacing: 0.3,
  });

  const cardShell = (title: string, text: string) => (
    <section className="card" style={card}>
      <div style={sectionHeader}><h2 style={{ ...h2, margin: 0 }}>{title}</h2></div>
      <div style={cardBody}><div style={small} aria-live="polite">{text}</div></div>
    </section>
  );
  const levelCard = (title: string, lvl: RiskLevel, text: string) => (
    <section className="card" style={{ ...card, border: `1px solid ${PALETTE[lvl].border}` }}>
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
      <div style={cardBody}><div style={small} aria-live="polite">{text}</div></div>
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
        <h1 style={title}>
          Risk Map Check
          <span style={beta}>BETA</span>
        </h1>
        <div style={subtitle}>by Hydrau</div>
        <div style={tagline}>Enter your address to check your risk exposure</div>
        <div style={bar}>
          <input
            style={input}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="123 Main St, City, ST 12345"
            onKeyDown={(e) => { if (e.key === "Enter" && loading === "idle") onCheck(); }}
            aria-label="Address input"
          />
          <button className="cta" style={btn} onClick={onCheck} disabled={loading !== "idle"} aria-label="Check risks">
            {loading === "idle" ? "Check" : loading === "geocode" ? "Geocoding…" : "Checking…"}
          </button>
        </div>
        <div style={hint}>Your street, city or county (US only)</div>
      </header>

      <main style={gridWrap}>
        {error && (
          <div style={{ maxWidth: 1100, margin: "12px auto 0", background: "#fee2e2", border: "1px solid #fecaca", color: "#7f1d1d", padding: 12, borderRadius: 10 }}>
            {error}
          </div>
        )}
        {geoNote && (
          <div style={{ maxWidth: 1100, margin: "12px auto 0", background: "#fef3c7", border: "1px solid #fde68a", color: "#78350f", padding: 12, borderRadius: 10 }}>
            {geoNote}
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

        <div style={footWrap}>
          <div style={foot}>
            ⚠️ Informational tool. Sources: FEMA NFHL (Flood) • USGS Design Maps (Earthquake, Risk Cat I) • FEMA NRI (Landslide, Wildfire, Heatwave, Cold Wave, Tornado).
          </div>
          <div style={{ ...foot, marginTop: 8 }}>
            © {new Date().getFullYear()} Hydrau — Educational project • Privacy-friendly, no tracking.
          </div>

          {/* Lien LinkedIn centré (une seule ligne) */}
          <div style={{ marginTop: 10 }} className="social">
            <a
              href="https://www.linkedin.com/in/hydrau-830122327/"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Hydrau on LinkedIn"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M4.98 3.5C4.98 4.88 3.86 6 2.5 6S0 4.88 0 3.5 1.12 1 2.5 1s2.48 1.12 2.48 2.5zM.5 8h4V23h-4V8zm7.5 0h3.8v2.05h.05c.53-1 1.83-2.05 3.77-2.05 4.03 0 4.78 2.65 4.78 6.1V23h-4v-6.64c0-1.58-.03-3.62-2.21-3.62-2.22 0-2.56 1.73-2.56 3.52V23h-4V8z"/>
              </svg>
              <span>Find me on LinkedIn</span>
            </a>
          </div>
        </div>
      </main>

      {/* micro-interactions (hover/focus) */}
      <style jsx>{`
        .card:hover { transform: translateY(-2px); box-shadow: 0 10px 24px rgba(0,0,0,0.08); }
        .cta:hover:not([disabled]) { transform: translateY(-1px); }
        .cta:active:not([disabled]) { transform: translateY(0); }
        input:focus { box-shadow: 0 0 0 3px rgba(59,130,246,0.35); border-color: #60a5fa !important; }
        @media (max-width: 420px) {
          h1 { font-size: 26px !important; }
        }
        .social { text-align: center; }
        .social a {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          color: #0a66c2;
          font-size: 14px;
          font-weight: 600;
          text-decoration: none;
          white-space: nowrap;        /* évite le retour à la ligne */
        }
        .social a:hover { text-decoration: underline; }
        .social a svg {
          width: 18px;
          height: 18px;
          color: #0a66c2;             /* utilise currentColor */
          display: inline-block;
          vertical-align: middle;
          flex: 0 0 18px;
        }
      `}</style>
    </div>
  );
}
