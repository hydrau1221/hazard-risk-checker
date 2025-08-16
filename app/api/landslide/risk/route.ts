export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(h: Record<string, string> = {}) {
  return { "content-type": "application/json", "access-control-allow-origin": "*", ...h };
}

type RiskLevel = "Very Low" | "Low" | "Moderate" | "High" | "Very High" | "Undetermined";

const UA = process.env.LS_UA || "HydrauRiskChecker/1.0 (+server)";

/**
 * ENV attendus (Vercel → Settings → Environment Variables) :
 * - LANDSLIDE_URL  : URL complète du service (MapServer/<layerId> ou ImageServer)
 * - LANDSLIDE_MODE : "feature" (MapServer) ou "image" (ImageServer). Si omis, auto-détection par l’URL.
 * - LANDSLIDE_FIELD (optionnel, mode feature) : nom du champ catégoriel (ex: "CLASS" | "SUSC_CLASS" | "CATEGORY"...)
 * - LANDSLIDE_VALUE_MAP (optionnel, mode image) : JSON mapping valeur->libellé. Par défaut: {"1":"Very Low","2":"Low","3":"Moderate","4":"High","5":"Very High"}
 */

function toLevelFromLabel(label: string): RiskLevel {
  const s = (label || "").toLowerCase().trim();
  if (s.includes("very high")) return "Very High";
  if (s === "vh") return "Very High";
  if (s.includes("high")) return "High";
  if (s.includes("moderate")) return "Moderate";
  if (s.includes("very low")) return "Very Low";
  if (s === "vl") return "Very Low";
  if (s.includes("low")) return "Low";
  if (s.includes("no data") || s.includes("undetermined") || s.includes("unknown")) return "Undetermined";
  return "Undetermined";
}

function toLevelFromValue(v: number, mapJson: string | undefined): RiskLevel {
  const fallback = { "1": "Very Low", "2": "Low", "3": "Moderate", "4": "High", "5": "Very High" };
  let map: Record<string, string> = fallback;
  try { if (mapJson) map = JSON.parse(mapJson); } catch { /* keep fallback */ }
  const label = map[String(Math.round(v))];
  return label ? toLevelFromLabel(label) : "Undetermined";
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const lat = Number(u.searchParams.get("lat"));
  const lon = Number(u.searchParams.get("lon"));

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return new Response(JSON.stringify({ error: "lat & lon required" }), { status: 400, headers: json() });
  }

  const baseUrl = (process.env.LANDSLIDE_URL || "").replace(/\/+$/, "");
  if (!baseUrl) {
    return new Response(JSON.stringify({
      error: "Configure LANDSLIDE_URL (MapServer/<layerId> ou ImageServer) et éventuellement LANDSLIDE_MODE.",
    }), { status: 500, headers: json() });
  }

  let mode = (process.env.LANDSLIDE_MODE || "").toLowerCase();
  if (!mode) {
    mode = /imageserver/i.test(baseUrl) ? "image" : "feature"; // auto
  }

  // ---- MODE FEATURE (polygones) ----
  if (mode === "feature" || /mapserver/i.test(baseUrl)) {
    const geom = JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } });
    const params = new URLSearchParams({
      f: "json",
      where: "1=1",
      geometry: geom,
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      returnGeometry: "false",
      outFields: "*",
    });
    const r = await fetch(`${baseUrl}/query?${params}`, {
      headers: { "user-agent": UA, accept: "application/json" },
      cache: "no-store",
    });
    const j = await r.json();
    if (!r.ok) {
      return new Response(JSON.stringify({ error: `Landslide feature query failed (${r.status})` }), { status: 502, headers: json() });
    }
    if (!j?.features?.length) {
      return new Response(JSON.stringify({ error: "no feature found at this point" }), { status: 404, headers: json() });
    }
    const attrs = j.features[0].attributes || {};
    // Champ préféré ou heuristique
    const candidates = (process.env.LANDSLIDE_FIELD || "CLASS,SUSC_CLASS,SUSCEPTIBILITY,CATEGORY,CLASSNAME,CLASS_NAME,NAME").split(",").map(s => s.trim().toLowerCase());
    let label = "";
    for (const key of Object.keys(attrs)) {
      const k = key.toLowerCase();
      if (candidates.includes(k)) { label = String(attrs[key]); break; }
    }
    if (!label) {
      // fallback: cherche une valeur textuelle contenant low/moderate/high
      for (const [k, v] of Object.entries(attrs)) {
        if (typeof v === "string" && /(very high|high|moderate|very low|low)/i.test(v)) { label = v; break; }
      }
    }
    const level = toLevelFromLabel(label);
    return new Response(JSON.stringify({ level, label, source: "feature" }), { headers: json() });
  }

  // ---- MODE IMAGE (raster) ----
  if (mode === "image" || /imageserver/i.test(baseUrl)) {
    const geom = JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } });
    const params = new URLSearchParams({
      f: "json",
      geometry: geom,
      geometryType: "esriGeometryPoint",
      sr: "4326",
      returnGeometry: "false",
    });
    const r = await fetch(`${baseUrl}/identify?${params}`, {
      headers: { "user-agent": UA, accept: "application/json" },
      cache: "no-store",
    });
    const j = await r.json();
    if (!r.ok) {
      return new Response(JSON.stringify({ error: `Landslide image identify failed (${r.status})` }), { status: 502, headers: json() });
    }
    const value = j?.value ?? j?.pixelValue ?? j?.catalogItems?.[0]?.value ?? null;
    if (value == null) {
      return new Response(JSON.stringify({ error: "no pixel value at this point" }), { status: 404, headers: json() });
    }
    const level = toLevelFromValue(Number(value), process.env.LANDSLIDE_VALUE_MAP);
    return new Response(JSON.stringify({ level, value, source: "image" }), { headers: json() });
  }

  return new Response(JSON.stringify({ error: `Unknown LANDSLIDE_MODE: ${mode}` }), { status: 400, headers: json() });
}
