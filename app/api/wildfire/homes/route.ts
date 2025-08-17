// app/api/wildfire/homes/route.ts
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 1) AGOL (souvent dispo)  2) USFS (fonction RPS) */
const SOURCES: Array<{ url: string; name: string }> = [
  { url: "https://services3.arcgis.com/T4QMspbfLg3qTGWY/ArcGIS/rest/services/Risk_to_Homes/ImageServer", name: "AGOL Risk_to_Homes" },
  { url: "https://apps.fs.usda.gov/fsgisx01/rest/services/RDW_Wildfire/RMRS_WRC_RiskToPotentialStructures/ImageServer", name: "USFS RPS" },
];

/** Variantes de lecture qu’on va tenter séquentiellement */
const RENDERING_RULES: Array<{ label: string; rule?: any }> = [
  { label: "none", rule: undefined }, // valeur brute
  { label: "RPS", rule: { rasterFunction: "RPS" } },
  { label: "RPS_Class", rule: { rasterFunction: "RPS_Class" } },
  { label: "ClassRPS", rule: { rasterFunction: "ClassRPS" } },
  { label: "ClassifiedRPS", rule: { rasterFunction: "ClassifiedRPS" } },
];

type Five = "Very Low" | "Low" | "Moderate" | "High" | "Very High" | "Undetermined" | "Not Applicable";

function levelFromRps(v: number | null): Five {
  if (v == null || !Number.isFinite(v)) return "Not Applicable";
  // seuils RPS (≈0–1020)
  if (v < 160) return "Very Low";
  if (v < 350) return "Low";
  if (v < 600) return "Moderate";
  if (v < 850) return "High";
  return "Very High";
}
function levelFromClassCode(v: number | null): Five {
  if (v == null || !Number.isFinite(v)) return "Not Applicable";
  const n = Math.round(v);
  if (n <= 0) return "Not Applicable";
  if (n === 1) return "Very Low";
  if (n === 2) return "Low";
  if (n === 3) return "Moderate";
  if (n === 4) return "High";
  return "Very High"; // 5+
}

function degPerMeterLat() { return 1 / 111_320; }
function degPerMeterLon(latDeg: number) {
  const k = Math.cos((latDeg * Math.PI) / 180);
  return 1 / (111_320 * (k || 1e-6));
}

/** Tente plusieurs "renderingRule" + "bandIds" et retourne la première valeur exploitable */
async function tryVariants(baseUrl: string, lat: number, lon: number) {
  const attempts: any[] = [];
  for (const rr of RENDERING_RULES) {
    for (const band of [undefined, 0, 1, 2, 3]) {
      const params = new URLSearchParams({
        f: "json",
        geometry: JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }),
        geometryType: "esriGeometryPoint",
        sr: "4326",
        returnFirstValueOnly: "true",
        interpolation: "RSP_NearestNeighbor",
      });
      if (rr.rule) params.set("renderingRule", JSON.stringify(rr.rule));
      if (band !== undefined) params.set("bandIds", String(band));
      const url = `${baseUrl}/getSamples?${params.toString()}`;
      let ok = false, raw: any = null, valueType: "unknown" | "class" | "rps" = "unknown";
      try {
        const r = await fetch(url, { cache: "no-store" });
        const txt = await r.text();
        const j: any = txt ? JSON.parse(txt) : null;
        ok = r.ok;
        raw = Array.isArray(j?.samples) && j.samples.length ? j.samples[0]?.value : null;
      } catch { /* ignore */ }

      // normalise
      if (typeof raw === "string") {
        if (/nan/i.test(raw)) raw = null;
        else raw = raw.split(",")[0];
      }
      const num = Number(raw);
      const isNum = Number.isFinite(num);
      // no-data usuels
      const isNoData = !isNum || num === 0 || num === -9999 || Math.abs(num) > 1e20;

      attempts.push({ url, ok, rr: rr.label, band, got: raw, noData: isNoData });

      if (!ok || isNoData) continue;

      // classes 1..5 ?
      if (Math.abs(num - Math.round(num)) < 1e-6 && num >= 1 && num <= 5) {
        valueType = "class";
        return { value: num, valueType, variant: { rr: rr.label, band }, attempts };
      }

      // continu : 0–1 ? 0–1020 ? 0–2000 ? on ramène à ~0–1020
      let rps = num;
      if (num <= 1.5) rps = num * 1020;         // 0–1
      else if (num > 1020 && num <= 2000) rps = (num / 2000) * 1020; // 0–2000 → 0–1020

      valueType = "rps";
      return { value: rps, valueType, variant: { rr: rr.label, band }, attempts };
    }
  }
  return { value: null as number | null, valueType: "unknown" as const, variant: null as any, attempts };
}

/** Cherche un pixel non-no-data le plus proche (0..300 m) sur toutes les sources */
async function sampleNearest(lat: number, lon: number) {
  const traces: any[] = [];
  for (const src of SOURCES) {
    // point
    let best = await tryVariants(src.url, lat, lon);
    traces.push({ src: src.name, radius: 0, ...best.variant, attempts: best.attempts.slice(0, 5) });
    if (best.value != null) return { ...best, meters: 0, provider: src.name, allAttempts: traces };

    // anneaux
    const step = 30;
    for (let radius = step; radius <= 300; radius += step) {
      const n = Math.max(8, Math.round((2 * Math.PI * radius) / step));
      const dLat = degPerMeterLat() * radius;
      const dLon = degPerMeterLon(lat) * radius;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * 2 * Math.PI;
        const lt = lat + dLat * Math.sin(ang);
        const ln = lon + dLon * Math.cos(ang);
        best = await tryVariants(src.url, lt, ln);
        traces.push({ src: src.name, radius, ...best.variant, attempts: best.attempts.slice(0, 3) });
        if (best.value != null) return { ...best, meters: radius, provider: src.name, allAttempts: traces };
      }
    }
  }
  return { value: null as number | null, valueType: "unknown" as const, meters: null as number | null, provider: null as string | null, allAttempts: traces };
}

async function geocodeFromAddress(req: NextRequest, address: string) {
  const origin = new URL(req.url).origin;
  const u = `${origin}/api/geocode?address=${encodeURIComponent(address)}`;
  const r = await fetch(u, { cache: "no-store" });
  if (!r.ok) throw new Error(`geocode failed: ${r.status}`);
  const j = await r.json();
  if (typeof j.lat !== "number" || typeof j.lon !== "number") throw new Error("geocode returned invalid lat/lon");
  return { lat: j.lat as number, lon: j.lon as number, geocode: j };
}

export async function GET(req: NextRequest) {
  const u = new URL(req.url);
  const debug = u.searchParams.get("debug") === "1";
  const address = u.searchParams.get("address");
  const lat = u.searchParams.get("lat");
  const lon = u.searchParams.get("lon");

  let latNum: number, lonNum: number, geocodeInfo: any = null;
  try {
    if (address && (!lat || !lon)) {
      const g = await geocodeFromAddress(req, address);
      latNum = g.lat; lonNum = g.lon; geocodeInfo = g.geocode;
    } else {
      latNum = Number(lat); lonNum = Number(lon);
    }
  } catch (e: any) {
    return Response.json({ error: e?.message || "geocode error" }, { status: 400 });
  }
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
    return Response.json({ error: "Missing lat/lon" }, { status: 400 });
  }

  const res = await sampleNearest(latNum, lonNum);

  let level: Five = "Not Applicable";
  if (res.valueType === "class") level = levelFromClassCode(res.value);
  else if (res.valueType === "rps") level = levelFromRps(res.value);

  const body: any = {
    level,
    value: res.value,
    adminUnit: "pixel",
    provider: res.provider || "Wildfire Risk to Communities (ImageServer)",
  };
  if (res.meters && res.meters > 0) {
    body.note = `Nearest colored pixel used (~${res.meters} m).`;
    body.nearestMeters = res.meters;
  } else if (res.value == null) {
    body.note = "No pixel value at this location (water / non-burnable / no structures).";
  }
  if (debug) body.debug = { geocode: geocodeInfo, attempts: res.allAttempts.slice(0, 60) };

  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
