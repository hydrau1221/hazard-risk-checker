// app/api/wildfire/homes/route.ts
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SERVICE ImageServer "Risk to Homes" (cRPS).
 * Idéalement, fournis l’URL officielle via la variable d’env WFR_HOMES_URL.
 * Sinon on essaie une petite liste de candidats.
 */
const CANDIDATES = [
  process.env.WFR_HOMES_URL || "",
  // <= Mets ici l’URL exacte si tu la connais.
  // Quelques candidats courants (si l’un marche, l’API fonctionne) :
  "https://wildfirerisk.org/arcgis/rest/services/Risk_to_Homes/ImageServer",
  "https://wildfirerisk.wim.usgs.gov/arcgis/rest/services/Risk_to_Homes/ImageServer",
  "https://services3.arcgis.com/T4QMspbfLg3qTGWY/ArcGIS/rest/services/Risk_to_Homes/ImageServer",
].filter(Boolean);

type Level = "Very Low" | "Low" | "Moderate" | "High" | "Very High" | "Undetermined" | "Not Applicable";

/** Convertit un score numérique → nos 5 niveaux */
function levelFromNumber(v: number): Level {
  // Cas 0–1
  if (v >= 0 && v <= 1.00001) {
    if (v <= 0.2) return "Very Low";
    if (v <= 0.4) return "Low";
    if (v <= 0.6) return "Moderate";
    if (v <= 0.8) return "High";
    return "Very High";
  }
  // Cas 0–100
  if (v >= 0 && v <= 100.00001) {
    if (v <= 20) return "Very Low";
    if (v <= 40) return "Low";
    if (v <= 60) return "Moderate";
    if (v <= 80) return "High";
    return "Very High";
  }
  // Cas classes 1..5 (ou 0..4)
  const vi = Math.round(v);
  if (vi === 0 || vi === 1) return "Very Low";
  if (vi === 2) return "Low";
  if (vi === 3) return "Moderate";
  if (vi === 4) return "High";
  if (vi >= 5) return "Very High";
  return "Undetermined";
}

function isNoData(x: any) {
  return x == null || Number.isNaN(Number(x)) || x === -9999;
}

/** Identify au pixel */
async function identify(url: string, lon: number, lat: number) {
  const params = new URLSearchParams({
    f: "json",
    geometry: JSON.stringify({ x: lon, y: lat }),
    geometryType: "esriGeometryPoint",
    sr: "4326",
    returnGeometry: "false",
    returnCatalogItems: "false",
    returnPixelValues: "true",
  });
  const r = await fetch(`${url.replace(/\/+$/, "")}/identify?${params}`, { cache: "no-store" });
  const text = await r.text();
  let j: any = null; try { j = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) return { ok: false as const, status: r.status, url, body: text };
  // Patterns usuels: j.value, j.pixel, j.catalogItems, j.properties, etc.
  const val =
    (j && typeof j.value === "number") ? j.value :
    (j && j.pixel && typeof j.pixel.value === "number") ? j.pixel.value :
    (j && typeof j.pixelValue === "number") ? j.pixelValue :
    null;

  return { ok: true as const, url, raw: j, value: val };
}

/** Essaye plusieurs services jusqu’à réponse valable */
async function identifyFirst(lon: number, lat: number, debug: boolean) {
  const attempts: any[] = [];
  for (const base of CANDIDATES) {
    try {
      const res = await identify(base, lon, lat);
      attempts.push({ url: res.url, ok: res.ok, status: (res as any).status, hasValue: !isNoData(res.value) });
      if (res.ok) return { pick: res, attempts };
    } catch (e: any) {
      attempts.push({ url: base, error: String(e?.message || e) });
    }
  }
  return { pick: null as any, attempts };
}

/** Petit offset géodésique (mètres → degrés) */
function dlat(m: number) { return m / 111_320; }
function dlon(m: number, lat: number) { return m / (111_320 * Math.cos((lat * Math.PI) / 180) || 1); }

/** Fallback 3×3 (0 m + ±30 m) pour éviter les trous aux limites de pixel */
async function identify3x3(lon: number, lat: number, debug: boolean) {
  const offsets = [
    [0, 0], [30, 0], [-30, 0], [0, 30], [0, -30], [30, 30], [30, -30], [-30, 30], [-30, -30],
  ];
  const tries: any[] = [];
  for (const [mx, my] of offsets) {
    const res = await identifyFirst(lon + dlon(mx, lat), lat + dlat(my), debug);
    tries.push(...res.attempts);
    if (res.pick && !isNoData(res.pick.value)) return { pick: res.pick, attempts: tries };
  }
  // aucun pixel valable
  return { pick: null as any, attempts: tries };
}

/** Géocode interne via /api/geocode (permet ?address=) */
async function geocodeFromAddress(req: NextRequest, address: string) {
  const origin = new URL(req.url).origin;
  const url = `${origin}/api/geocode?address=${encodeURIComponent(address)}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`geocode failed: ${r.status}`);
  const j = await r.json();
  if (!j || typeof j.lat !== "number" || typeof j.lon !== "number") {
    throw new Error("geocode returned invalid lat/lon");
  }
  return { lat: j.lat as number, lon: j.lon as number, geocode: j };
}

export async function GET(req: NextRequest) {
  const u = new URL(req.url);
  const debug = u.searchParams.get("debug") === "1";
  const address = u.searchParams.get("address");
  let lat = u.searchParams.get("lat");
  let lon = u.searchParams.get("lon");

  let latNum: number, lonNum: number;
  let geocodeInfo: any = null;

  try {
    if (address && (!lat || !lon)) {
      const g = await geocodeFromAddress(req, address);
      latNum = g.lat; lonNum = g.lon; geocodeInfo = g.geocode;
    } else {
      latNum = Number(lat);
      lonNum = Number(lon);
    }
  } catch (e: any) {
    return Response.json({ error: e?.message || "geocode error" }, { status: 400 });
  }

  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
    return Response.json({ error: "Missing lat/lon" }, { status: 400 });
  }

  // Identify + fallback 3×3
  const out = await identify3x3(lonNum, latNum, debug);

  if (out.pick && !isNoData(out.pick.value)) {
    const v = Number(out.pick.value);
    const level = levelFromNumber(v);
    const body: any = {
      level,
      value: v,
      adminUnit: "pixel",
      provider: "USFS / Wildfire Risk to Communities (Risk to Homes, cRPS)",
      note: "Raster identify (~30 m pixel) with 3×3 fallback",
    };
    if (debug) body.debug = {
      geocode: geocodeInfo ?? null,
      attempts: out.attempts,
      rawSample: out.pick.raw ? Object.keys(out.pick.raw).slice(0, 8) : [],
      serviceUrl: out.pick.url?.replace(/\/identify.*/, "") || null,
    };
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  }

  // Pas de donnée au pixel => Not Applicable (zones blanches / eau / non combustible)
  const res: any = {
    level: "Not Applicable",
    value: null,
    adminUnit: "pixel",
    provider: "USFS / Wildfire Risk to Communities (Risk to Homes, cRPS)",
    note: "No pixel value at this location (likely water / non-burnable / no structures).",
  };
  if (debug) res.debug = { geocode: geocodeInfo ?? null, attempts: out.attempts };
  return Response.json(res);
}
