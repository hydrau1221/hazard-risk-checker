// app/api/landslide/risk2/route.ts
import { NextRequest } from "next/server";
import { PNG } from "pngjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// La couche Tiles USGS (même carte que dans l'app web USGS)
const TILES_BASE =
  "https://tiles.arcgis.com/tiles/v01gqwM5QqNysAAi/arcgis/rest/services/US_Landslide_Susceptibility/MapServer";

// -------- helpers ----------
function lonLatToTile(lon: number, lat: number, z: number) {
  const n = 2 ** z;
  const xt = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const yt =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
    n;
  return {
    x: Math.floor(xt),
    y: Math.floor(yt),
    z,
    fx: xt - Math.floor(xt),
    fy: yt - Math.floor(yt),
  };
}

function dist2(a: number[], b: number[]) {
  const dr = a[0] - b[0],
    dg = a[1] - b[1],
    db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

type PaletteEntry = { key: string; rgba: [number, number, number, number] };

async function fetchLegendPalette(): Promise<PaletteEntry[]> {
  const r = await fetch(`${TILES_BASE}/legend?f=pjson`, {
    next: { revalidate: 86400 },
  });
  if (!r.ok) throw new Error(`legend ${r.status}`);
  const j = await r.json();

  const samples: PaletteEntry[] = [];
  for (const layer of j.layers ?? []) {
    for (const sym of layer.legend ?? []) {
      if (!sym?.imageData) continue;
      const png = PNG.sync.read(Buffer.from(sym.imageData, "base64"));
      const cx = Math.floor(png.width / 2);
      const cy = Math.floor(png.height / 2);
      const i = (png.width * cy + cx) << 2;
      const rgba: [number, number, number, number] = [
        png.data[i],
        png.data[i + 1],
        png.data[i + 2],
        png.data[i + 3],
      ];
      const label = String(sym.label || "").toLowerCase();
      if (!label) continue;
      samples.push({ key: label, rgba });
    }
  }

  // On ne garde que les 5 classes utiles
  const pick = (substr: string) =>
    samples.find((s) => s.key.includes(substr))?.rgba;
  const palette = [
    { key: "very high", rgba: pick("very high") },
    { key: "high", rgba: pick(" high") }, // espace pour éviter de voler "very high"
    { key: "moderate", rgba: pick("moderate") },
    { key: "low", rgba: pick(" low") },
    { key: "very low", rgba: pick("very low") },
  ].filter((p) => p.rgba) as PaletteEntry[];

  if (!palette.length) throw new Error("empty legend palette");
  return palette;
}

function mapLabelToRisk(labelLower: string):
  | "Very High"
  | "High"
  | "Moderate"
  | "Low"
  | "Very Low" {
  if (labelLower.includes("very high")) return "Very High";
  if (labelLower.includes("high")) return "High";
  if (labelLower.includes("moderate")) return "Moderate";
  if (labelLower.includes("very low")) return "Very Low";
  if (labelLower.includes("low")) return "Low";
  return "Very Low";
}

// -------- handler ----------
export async function GET(req: NextRequest) {
  try {
    const u = new URL(req.url);
    const lat = Number(u.searchParams.get("lat"));
    const lon = Number(u.searchParams.get("lon"));
    const debug = u.searchParams.get("debug") === "1";

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return Response.json({ error: "Missing lat/lon" }, { status: 400 });
    }

    // 1) Palette (couleurs de la légende)
    const palette = await fetchLegendPalette();

    // 2) Tuiles : on prend z=12 (équilibre précision/cache)
    const z = 12;
    const t = lonLatToTile(lon, lat, z);
    const tileUrl = `${TILES_BASE}/tile/${z}/${t.y}/${t.x}`;
    const tileRes = await fetch(tileUrl);
    if (!tileRes.ok) {
      const body = debug
        ? { error: "tile fetch failed", url: tileUrl, status: tileRes.status }
        : { error: "Landslide service not available" };
      return Response.json(body, { status: 502 });
    }

    const png = PNG.sync.read(Buffer.from(await tileRes.arrayBuffer()));
    const px = Math.max(0, Math.min(png.width - 1, Math.round(t.fx * png.width)));
    const py = Math.max(0, Math.min(png.height - 1, Math.round(t.fy * png.height)));

    // 3) Moyenne sur 5x5 pixels pour lisser les bords (anti-aliasing)
    let sum = [0, 0, 0, 0];
    let n = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = Math.max(0, Math.min(png.width - 1, px + dx));
        const y = Math.max(0, Math.min(png.height - 1, py + dy));
        const i = (png.width * y + x) << 2;
        const a = png.data[i + 3];
        if (a > 0) {
          sum[0] += png.data[i];
          sum[1] += png.data[i + 1];
          sum[2] += png.data[i + 2];
          sum[3] += a;
          n++;
        }
      }
    }
    const avg: [number, number, number, number] =
      n > 0
        ? [
            Math.round(sum[0] / n),
            Math.round(sum[1] / n),
            Math.round(sum[2] / n),
            Math.round(sum[3] / n),
          ]
        : [0, 0, 0, 0];

    // 4) Transparence -> hors polygones (Very Low)
    if (avg[3] <= 0) {
      const body: any = {
        level: "Very Low",
        label: "Very Low (outside mapped polygons)",
        source: { tile: tileUrl },
      };
      if (debug)
        body.debug = { avgRGBA: avg, tilePixel: { px, py }, tile: t, palette };
      return Response.json(body, {
        headers: { "Cache-Control": "s-maxage=86400" },
      });
    }

    // 5) Couleur la plus proche de la légende -> niveau
    let best = { i: -1, d: Number.POSITIVE_INFINITY };
    for (let i = 0; i < palette.length; i++) {
      const d = dist2(
        [avg[0], avg[1], avg[2]],
        (palette[i]
