export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RiskLevel = "Very Low" | "Low" | "Moderate" | "High" | "Very High" | "Undetermined";

function json(h: Record<string, string> = {}) {
  return {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    ...h,
  };
}

const UA = process.env.LS_UA || "HydrauRiskChecker/1.0 (+server)";

/** Convertit un libellé texte en niveau */
function toLevelFromLabel(label: string): RiskLevel {
  const s = (label || "").toLowerCase();
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

/** Convertit une valeur raster (1..5) en niveau, avec mapping personnalisable via LANDSLIDE_VALUE_MAP */
function toLevelFromValue(v: number, mapJson: string | undefined): RiskLevel {
  const fallback = { "1": "Very Low", "2": "Low", "3": "Moderate", "4": "High", "5": "Very High" };
  let map: Record<string, string> = fallback;
  try { if (mapJson) map = JSON.parse(mapJson); } catch {}
  const label = map[String(Math.round(v))];
  return label ? toLevelFromLabel(label) : "Undetermined";
}

async function tryImageServer(url: string, lat: number, lon: number) {
  const geom = JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } });
  const qs = new URLSearchParams({
    f: "json",
    geometry: geom,
    geometryType: "esriGeometryPoint",
    sr: "4326",
    returnGeometry: "false",
  });
  const r = await fetch(`${url.replace(/\/+$/,"")}/identify?${qs}`, {
    headers: { "user-agent": UA, accept: "application/json" },
    cache: "no-store",
  });
  const text = await r.text();
  let j: any = null; try { j = JSON.parse(text); } catch {}
  if (!r.ok) return { ok: false, url, status: r.status, err: "identify failed" };
  const value = j?.value ?? j?.pixelValue ?? j?.catalogItems?.[0]?.value ?? null;
  if (value == null) return { ok: false, url, status: r.status, err: "no pixel value" };
  const level = toLevelFromValue(Number(value), process.env.LANDSLIDE_VALUE_MAP);
  return { ok: true, url, mode: "image", level, value };
}

async function tryFeatureServerOrMap(url: string, lat: number, lon: number) {
  const geom = JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } });
  const qs = new URLSearchParams({
    f: "json",
    where: "1=1",
    geometry: geom,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    returnGeometry: "false",
    outFields: "*",
  });
  const r = await fetch(`${url.replace(/\/+$/,"")}/query?${qs}`, {
    headers: { "user-agent": UA, accept: "application/json" },
    cache: "no-store",
  });
  const text = await r.text();
  let j: any = null; try { j = JSON.parse(text); } catch {}
  if (!r.ok) return { ok: false, url, status: r.status, err: "query failed" };
  const feats = j?.features || [];
  if (!feats.length) return { ok: false, url, status: r.status, err: "no feature" };
  const attrs = feats[0].attributes || {};
  const prefer = (process.env.LANDSLIDE_FIELD || "CLASS,SUSC_CLASS,SUSCEPTIBILITY,CATEGORY,CLASSNAME,CLASS_NAME,NAME").split(",").map(s => s.trim().toLowerCase());
  let label = "";
  for (const k of Object.keys(attrs)) {
    if (prefer.includes(k.toLowerCase())) { label = String(attrs[k]); break; }
  }
  if (!label) {
    for (const [k, v] of Object.entries(attrs)) {
      if (typeof v === "string" && /(very high|high|moderate|very low|low)/i.test(v)) { label = v; break; }
    }
  }
  const level = toLevelFromLabel(label);
  return { ok: true, url, mode: "feature", level, label };
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const lat = Number(u.searchParams.get("lat"));
  const lon = Number(u.searchParams.get("lon"));
  const debug = u.searchParams.get("debug") === "1";

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return new Response(JSON.stringify({ error: "lat & lon required" }), { status: 400, headers: json() });
  }

  const inputUrl = (process.env.LANDSLIDE_URL || "").replace(/\/+$/,"");
  if (!inputUrl) {
    return new Response(JSON.stringify({ error: "Set LANDSLIDE_URL in environment variables." }), { status: 500, headers: json() });
  }

  // Construit des candidats si on reçoit une URL “tiles”
  const candidates = new Set<string>([inputUrl]);
  if (/\/tiles\//i.test(inputUrl)) {
    const svc = inputUrl.replace(/\/tiles\//i, "/services/");
    candidates.add(svc);
    if (/\/MapServer$/i.test(svc)) candidates.add(svc.replace(/\/MapServer$/i, "/ImageServer"));
  } else {
    // Essaie aussi la variante ImageServer/MapServer
    if (/\/MapServer$/i.test(inputUrl)) candidates.add(inputUrl.replace(/\/MapServer$/i, "/ImageServer"));
    if (/\/ImageServer$/i.test(inputUrl)) candidates.add(inputUrl.replace(/\/ImageServer$/i, "/MapServer"));
  }

  const attempts: any[] = [];
  for (const url of candidates) {
    try {
      if (/\/ImageServer$/i.test(url)) {
        const res = await tryImageServer(url, lat, lon);
        attempts.push(res);
        if (res.ok) {
          return new Response(JSON.stringify({ level: res.level, value: res.value, source: "image", serviceUrl: url }), { headers: json() });
        }
      } else {
        // essaie MapServer/FeatureServer
        const res = await tryFeatureServerOrMap(url, lat, lon);
        attempts.push(res);
        if (res.ok) {
          return new Response(JSON.stringify({ level: res.level, label: res.label, source: "feature", serviceUrl: url }), { headers: json() });
        }
      }
    } catch (e: any) {
      attempts.push({ url, err: String(e?.message || e) });
    }
  }

  const body = debug
    ? { error: "No usable landslide service found.", attempts }
    : { error: "Landslide service not available" };

  return new Response(JSON.stringify(body), { status: 502, headers: json() });
}
