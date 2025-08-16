// app/api/landslide/risk/route.ts
import { NextRequest } from "next/server";
import { PNG } from "pngjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Tuiles USGS (la même carte que dans l’app)
const TILES_BASE =
  "https://tiles.arcgis.com/tiles/v01gqwM5QqNysAAi/arcgis/rest/services/US_Landslide_Susceptibility/MapServer";

// ---- helpers ----
function lonLatToTile(lon: number, lat: number, z: number) {
  const n = 2 ** z;
  const xt = (lon + 180) / 360 * n;
  const latRad = (lat * Math.PI) / 180;
  const yt = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return { xFloat: xt, yFloat: yt, x: Math.floor(xt), y: Math.floor(yt), z, fx: xt - Math.floor(xt), fy: yt - Math.floor(yt) };
}
function dist2(a: number[], b: number[]) { const dr=a[0]-b[0], dg=a[1]-b[1], db=a[2]-b[2]; return dr*dr+dg*dg+db*db; }
type PaletteEntry = { key: string; rgba: [number,number,number,number] };

async function fetchLegendPalette(): Promise<PaletteEntry[]> {
  const r = await fetch(`${TILES_BASE}/legend?f=pjson`, { next: { revalidate: 86400 } });
  if (!r.ok) throw new Error(`legend ${r.status}`);
  const j = await r.json();
  const samples: PaletteEntry[] = [];
  for (const layer of j.layers ?? []) for (const sym of layer.legend ?? []) {
    if (!sym?.imageData) continue;
    const png = PNG.sync.read(Buffer.from(sym.imageData, "base64"));
    const cx = Math.floor(png.width/2), cy = Math.floor(png.height/2);
    const i = (png.width*cy + cx) << 2;
    const rgba: [number,number,number,number] = [png.data[i], png.data[i+1], png.data[i+2], png.data[i+3]];
    const label = (sym.label || "").toString().toLowerCase(); if (!label) continue;
    samples.push({ key: label, rgba });
  }
  const pick = (s: string) => samples.find(x => x.key.includes(s))?.rgba;
  const palette = [
    { key: "very high", rgba: pick("very high") },
    { key: "high",      rgba: pick(" high") },  // espace pour ne pas matcher "very high"
    { key: "moderate",  rgba: pick("moderate") },
    { key: "low",       rgba: pick(" low") },
    { key: "very low",  rgba: pick("very low") },
  ].filter((p): p is PaletteEntry => !!p?.rgba);
  if (!palette.length) throw new Error("empty legend palette");
  return palette;
}

function mapLabelToLevel(label: string) {
  const l = label.toLowerCase();
  if (l.includes("very high")) return "very_high" as const;
  if (l.includes("high"))      return "high" as const;
  if (l.includes("moderate"))  return "moderate" as const;
  if (l.includes("very low"))  return "very_low" as const;
  if (l.includes("low"))       return "low" as const;
  return "very_low" as const;
}

// ---- API ----
export async function GET(req: NextRequest) {
  try {
    const u = new URL(req.url);
    const lat = Number(u.searchParams.get("lat"));
    const lon = Number(u.searchParams.get("lon"));
    const debug = u.searchParams.get("debug") === "1";
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return Response.json({ error: "Missing lat/lon" }, { status: 400 });
    }

    const palette = await fetchLegendPalette();

    const z = 12; // niveau de zoom pour l’échantillonnage
    const t = lonLatToTile(lon, lat, z);
    const tileUrl = `${TILES_BASE}/tile/${z}/${t.y}/${t.x}`;
    const tileRes = await fetch(tileUrl);
    if (!tileRes.ok) {
      const body = debug ? { error: "tile fetch failed", url: tileUrl, status: tileRes.status }
                         : { error: "Landslide service not available" };
      return Response.json(body, { status: 502 });
    }

    const png = PNG.sync.read(Buffer.from(await tileRes.arrayBuffer()));
    const px = Math.max(0, Math.min(png.width-1, Math.round(t.fx * png.width)));
    const py = Math.max(0, Math.min(png.height-1, Math.round(t.fy * png.height)));

    // moyenne sur 5x5 pour éviter l’aliasing des bords
    let sum=[0,0,0,0], n=0;
    for (let dy=-2; dy<=2; dy++) for (let dx=-2; dx<=2; dx++) {
      const x = Math.max(0, Math.min(png.width-1, px+dx));
      const y = Math.max(0, Math.min(png.height-1, py+dy));
      const i = (png.width*y + x) << 2;
      const a = png.data[i+3];
      if (a>0){ sum[0]+=png.data[i]; sum[1]+=png.data[i+1]; sum[2]+=png.data[i+2]; sum[3]+=a; n++; }
    }
    const avg = n ? [sum[0]/n|0, sum[1]/n|0, sum[2]/n|0, sum[3]/n|0] as [number,number,number,number]
                  : [0,0,0,0] as [number,number,number,number];

    let level: "very_low"|"low"|"moderate"|"high"|"very_high" = "very_low";
    let label = "Very Low";

    if (avg[3] <= 0) {
      label = "Very Low (outside mapped polygons)";
    } else {
      let best = { i:-1, d: Number.POSITIVE_INFINITY };
      for (let i=0;i<palette.length;i++){
        const d = dist2([avg[0],avg[1],avg[2]], palette[i].rgba.slice(0,3) as number[]);
        if (d < best.d) best = { i, d };
      }
      const bestLabel = palette[best.i]?.key ?? "very low";
      level = mapLabelToLevel(bestLabel);
      label = level === "very_low" && !bestLabel.includes("very low")
              ? "Very Low (outside mapped polygons)"
              : bestLabel.replace(/\b\w/g, m => m.toUpperCase());
    }

    const body: any = {
      level, label,
      ui: {
        very_low: { chip:"#22c55e", badge:"VERY LOW RISK", severity:1 },
        low:      { chip:"#1d4ed8", badge:"LOW RISK",       severity:2 },
        moderate: { chip:"#eab308", badge:"MODERATE RISK",  severity:3 },
        high:     { chip:"#f97316", badge:"HIGH RISK",       severity:4 },
        very_high:{ chip:"#ef4444", badge:"VERY HIGH RISK", severity:5 },
      }[level],
      source: { tile: tileUrl }
    };
    if (debug) body.debug = { avgRGBA: avg, tilePixel:{px,py}, tile:t, palette };

    return Response.json(body, { headers: { "Cache-Control": "s-maxage=86400" } });
  } catch (e:any) {
    return Response.json({ error: e?.message || "Landslide service error" }, { status: 500 });
  }
}
