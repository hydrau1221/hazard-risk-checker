// app/api/landslide/risk/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RiskLevel = "Very Low" | "Low" | "Moderate" | "High" | "Very High" | "Undetermined";

const UA = process.env.LS_UA || "HydrauRiskChecker/1.0 (+server)";
function json(h: Record<string, string> = {}) {
  return { "content-type": "application/json", "access-control-allow-origin": "*", ...h };
}

// ---------- helpers ----------
const RANK: Record<RiskLevel, number> = {
  "Very Low": 1, Low: 2, Moderate: 3, High: 4, "Very High": 5, Undetermined: 0,
};

function toLevelFromLabel(s: string): RiskLevel {
  const t = (s || "").trim().toLowerCase();
  if (/very\s*high|\bvh\b/.test(t)) return "Very High";
  if (/\bhigh\b|\bh\b/.test(t)) return "High";
  if (/moderate|\bm\b/.test(t)) return "Moderate";
  if (/very\s*low|\bvl\b/.test(t)) return "Very Low";
  if (/\blow\b|\bl\b/.test(t)) return "Low";
  if (/no ?data|unknown|undetermined/.test(t)) return "Undetermined";
  return "Undetermined";
}
function toLevelFromValue(v: number): RiskLevel {
  let custom: Record<string, string> | null = null;
  try { if (process.env.LANDSLIDE_VALUE_MAP) custom = JSON.parse(process.env.LANDSLIDE_VALUE_MAP); } catch { /* ignore */ }
  const lbl =
    (custom && custom[String(Math.round(v))]) ||
    ({ 1: "Very Low", 2: "Low", 3: "Moderate", 4: "High", 5: "Very High" } as any)[String(Math.round(v))];
  return toLevelFromLabel(lbl || "");
}

function pickField(attrs: Record<string, any>): any {
  const forced = (process.env.LANDSLIDE_FIELD || "").trim();
  if (forced && forced in attrs) return attrs[forced];
  const common = "SUSC_CLASS,SUSCEPTIBILITY,CLASS,CATEGORY,CLASSNAME,CLASS_NAME,NAME,TYPE"
    .split(",").map(s => s.toLowerCase());
  for (const k of Object.keys(attrs)) if (common.includes(k.toLowerCase())) return attrs[k];

  // strings contenant VH/H/M/L/VL ou Very High/Low/Moderate
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "string" && /(very\s*high|high|moderate|very\s*low|low|\bvh\b|\bh\b|\bm\b|\bvl\b|\bl\b)/i.test(v)) return v;
  }
  // petit entier 0..10
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "number" && v >= 0 && v <= 10) return v;
    if (typeof v === "string" && /^\d+$/.test(v)) {
      const n = Number(v);
      if (n >= 0 && n <= 10) return n;
    }
  }
  return undefined;
}

async function imageIdentify(url: string, lat: number, lon: number) {
  const geom = JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } });
  const qs = new URLSearchParams({
    f: "json",
    geometry: geom,
    geometryType: "esriGeometryPoint",
    sr: "4326",
    returnGeometry: "false",
  });
  const r = await fetch(`${url.replace(/\/+$/,"")}/identify?${qs}`, {
    headers: { accept: "application/json", "user-agent": UA },
    cache: "no-store",
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) return { ok: false, url, err: `identify ${r.status}` };
  const value = j?.value ?? j?.pixelValue ?? j?.catalogItems?.[0]?.value ?? null;
  if (value == null) return { ok: false, url, err: "no pixel value" };
  return { ok: true, url, mode: "image" as const, level: toLevelFromValue(Number(value)), value };
}

async function featureQueryOneLayer(layerUrl: string, lat: number, lon: number) {
  const geom = JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } });

  // Buffer autour du point (mètres) — ajustable via ENV
  const distance = Number(process.env.LANDSLIDE_BUFFER_METERS || "50");

  const qs = new URLSearchParams({
    f: "json",
    where: "1=1",
    geometry: geom,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    distance: String(distance),
    units: "esriSRUnit_Meter",
    returnGeometry: "false",
    outFields: "*",
  });

  const r = await fetch(`${layerUrl.replace(/\/+$/,"")}/query?${qs}`, {
    headers: { accept: "application/json", "user-agent": UA },
    cache: "no-store",
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) return { ok: false, url: layerUrl, err: `query ${r.status}` };

  const feats = j?.features || [];
  if (!feats.length) return { ok: false, url: layerUrl, err: "no feature" };

  const attrs = feats[0].attributes || {};
  const val = pickField(attrs);

  let level: RiskLevel, label: string | null = null;
  if (typeof val === "number") { level = toLevelFromValue(val); label = String(val); }
  else if (val != null) { label = String(val); level = toLevelFromLabel(label); }
  else { level = "Undetermined"; }

  return { ok: true, url: layerUrl, mode: "feature" as const, level, label };
}

async function listLayers(serviceUrl: string): Promise<number[]> {
  const base = serviceUrl.replace(/\/+$/,"");
  const urls = [`${base}/layers?f=json`, `${base}?f=json`];
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { accept: "application/json", "user-agent": UA }, cache: "no-store" });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) continue;
      if (Array.isArray(j.layers)) return j.layers.map((x: any) => x.id).filter((x: any) => Number.isFinite(x));
      if (Array.isArray(j.subLayers)) return j.subLayers.map((x: any) => x.id).filter((x: any) => Number.isFinite(x));
    } catch { /* ignore */ }
  }
  // fallback pessimiste
  return Array.from({ length: 31 }, (_, i) => i);
}

// ---------- handler ----------
export async function GET(req: Request) {
  const u = new URL(req.url);
  const lat = Number(u.searchParams.get("lat"));
  const lon = Number(u.searchParams.get("lon"));
  const debug = u.searchParams.get("debug") === "1";

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return new Response(JSON.stringify({ error: "lat & lon required" }), { status: 400, headers: json() });
  }

  const base = (process.env.LANDSLIDE_URL || "").replace(/\/+$/,"");
  if (!base) {
    return new Response(JSON.stringify({ error: "Set LANDSLIDE_URL in env." }), { status: 500, headers: json() });
  }

  // Construire la liste d’URL candidates (tiles → services, image ↔ map)
  const candidates: string[] = [base];
  if (/\/tiles\//i.test(base)) {
    const svc = base.replace(/\/tiles\//i, "/services/");
    candidates.push(svc);
    if (/\/MapServer$/i.test(svc)) candidates.push(svc.replace(/\/MapServer$/i, "/ImageServer"));
  } else {
    if (/\/MapServer\/\d+$/i.test(base)) candidates.push(base.replace(/\/MapServer\/\d+$/i, "/ImageServer"));
    if (/\/ImageServer$/i.test(base)) candidates.push(base.replace(/\/ImageServer$/i, "/MapServer"));
  }

  const attempts: any[] = [];
  let best: { level: RiskLevel; label?: string | null; url: string; mode: "feature" | "image" } | null = null;

  for (const url of candidates) {
    try {
      if (/\/ImageServer$/i.test(url)) {
        const res = await imageIdentify(url, lat, lon);
        attempts.push(res);
        if (res.ok) {
          const cur = { level: res.level as RiskLevel, url, mode: "image" as const };
          if (!best || RANK[cur.level] > RANK[best.level]) best = cur;
        }
      } else if (/\/(FeatureServer|MapServer)\/\d+$/i.test(url)) {
        const res = await featureQueryOneLayer(url, lat, lon);
        attempts.push(res);
        if (res.ok) {
          const cur = { level: res.level as RiskLevel, label: (res as any).label ?? null, url, mode: "feature" as const };
          if (!best || RANK[cur.level] > RANK[best.level]) best = cur;
        }
      } else if (/\/(FeatureServer|MapServer)$/i.test(url)) {
        // URL racine → scanner tous les sous-layers
        const ids = await listLayers(url);
        let got = false;
        for (const id of ids) {
          const res = await featureQueryOneLayer(`${url}/${id}`, lat, lon);
          attempts.push(res);
          if (res.ok) {
            got = true;
            const cur = { level: res.level as RiskLevel, label: (res as any).label ?? null, url: `${url}/${id}`, mode: "feature" as const };
            if (!best || RANK[cur.level] > RANK[best.level]) best = cur;
          }
        }
        if (!got) attempts.push({ url, err: "no feature (none of sublayers matched)" });
      }
    } catch (e: any) {
      attempts.push({ url, err: String(e?.message || e) });
    }
  }

  if (best) {
    return new Response(JSON.stringify({
      level: best.level,
      label: best.label ?? null,
      source: best.mode,
      serviceUrl: best.url
    }), { headers: json() });
  }

  // Zone blanche → 404 explicite (l’UI affichera VERY LOW)
  if (attempts.some(a => a?.err && String(a.err).includes("no feature"))) {
    return new Response(JSON.stringify({ error: "no feature found at this point" }), { status: 404, headers: json() });
  }

  const body = debug ? { error: "Landslide service not available", attempts } : { error: "Landslide service not available" };
  return new Response(JSON.stringify(body), { status: 502, headers: json() });
}
