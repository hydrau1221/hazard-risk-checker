// app/api/landslide/risk/route.ts
import { NextRequest } from "next/server";
import { PNG } from "pngjs";

export const dynamic = "force-dynamic";

// USGS tiles-only service (the same map you view in the USGS app)
const TILES_BASE =
  "https://tiles.arcgis.com/tiles/v01gqwM5QqNysAAi/arcgis/rest/services/US_Landslide_Susceptibility/MapServer";

// --- helpers --------------------------------------------------------------

function lonLatToTile(lon: number, lat: number, z: number) {
  const n = 2 ** z;
  const xt = (lon + 180) / 360 * n;
  const latRad = (lat * Math.PI) / 180;
  const yt =
    (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return {
    xFloat: xt,
    yFloat: yt,
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

// Pull legend swatches and extract their representative RGBA colors.
// We don’t hardcode colors; we read what the service uses.
async function fetchLegendPalette(): Promise<PaletteEntry[]> {
  const res = await fetch(`${TILES_BASE}/legend?f=pjson`, {
    // cache on the server for a day
    next: { revalidate: 86400 },
  });
  if (!res.ok) throw new Error(`legend fetch failed: ${res.status}`);
  const j = await res.json();

  const samples: PaletteEntry[] = [];
  for (const layer of j.layers ?? []) {
    for (const sym of layer.legend ?? []) {
      if (!sym?.imageData) continue;
      const buf = Buffer.from(sym.imageData, "base64");
      const png = PNG.sync.read(buf);
      const cx = Math.floor(png.width / 2);
      const cy = Math.floor(png.height / 2);
      const idx = (png.width * cy + cx) << 2;
      const rgba: [number, number, number, number] = [
        png.data[idx],
        png.data[idx + 1],
        png.data[idx + 2],
        png.data[idx + 3],
      ];
      const label = (sym.label || "").toString().toLowerCase();
      if (!label) continue;
      samples.push({ key: label, rgba });
    }
  }

  // Deduplicate to the five classes we care about.
  function pick(substr: string) {
    return samples.find((s) => s.key.includes(substr))?.rgba;
  }
  const palette = [
    { key: "very high", rgba: pick("very high") },
    { key: "high", rgba: pick(" high") }, // note leading space so it won't steal "very high"
    { key: "moderate", rgba: pick("moderate") },
    { key: "low", rgba: pick(" low") },
    { key: "very low", rgba: pick("very low") },
  ].filter((p) => p.rgba) as PaletteEntry[];

  if (!palette.length) throw new Error("empty legend palette");
  return palette;
}

function toUi(level: "very_low" | "low" | "moderate" | "high" | "very_high") {
  // Your unified UI colors (same scheme you use for Flood & Earthquake)
  return {
    very_low: { chip: "#22c55e", badge: "VERY LOW RISK", severity: 1 },
    low: { chip: "#1d4ed8", badge: "LOW RISK", severity: 2 },
    moderate: { chip: "#eab308", badge: "MODERATE RISK", severity: 3 },
    high: { chip: "#f97316", badge: "HIGH RISK", severity: 4 },
    very_high: { chip: "#ef4444", badge: "VERY HIGH RISK", severity: 5 },
  }[level];
}

function mapLabelToLevel(label: string) {
  const l = label.toLowerCase();
  if (l.includes("very high")) return "very_high" as const;
  if (l.includes("high")) return "high" as const;
  if (l.includes("moderate")) return "moderate" as const;
  if (l.includes("very low")) return "very_low" as const;
  if (l.includes("low")) return "low" as const;
  return "very_low" as const;
}

// --- API --------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const lat = Number(searchParams.get("lat"));
    const lon = Number(searchParams.get("lon"));
    const debug = searchParams.get("debug");

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return Response.json({ error: "Missing lat/lon" }, { status: 400 });
    }

    // 1) Get legend palette (class colors)
    const palette = await fetchLegendPalette();

    // 2) Find the tile and the pixel for the given lat/lon
    const z = 12; // good balance of detail & cache hit rate
    const t = lonLatToTile(lon, lat, z);
    const tileUrl = `${TILES_BASE}/tile/${z}/${t.y}/${t.x}`;
    const tileRes = await fetch(tileUrl);
    if (!tileRes.ok) {
      const body = debug
        ? { error: "tile fetch failed", url: tileUrl, status: tileRes.status }
        : { error: "Landslide service not available" };
      return Response.json(body, { status: 502 });
    }

    const tileBuf = Buffer.from(await tileRes.arrayBuffer());
    const png = PNG.sync.read(tileBuf);

    // 3) Sample a 5x5 neighborhood around the exact pixel to avoid anti-aliasing noise
    const px = Math.max(0, Math.min(511, Math.round(t.fx * png.width)));
    const py = Math.max(0, Math.min(511, Math.round(t.fy * png.height)));
    let sum = [0, 0, 0, 0];
    let count = 0;

    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = Math.max(0, Math.min(png.width - 1, px + dx));
        const y = Math.max(0, Math.min(png.height - 1, py + dy));
        const idx = (png.width * y + x) << 2;
        const a = png.data[idx + 3];
        if (a > 0) {
          sum[0] += png.data[idx];
          sum[1] += png.data[idx + 1];
          sum[2] += png.data[idx + 2];
          sum[3] += a;
          count++;
        }
      }
    }

    // If everything around is transparent, we’re outside mapped polygons.
    const avg =
      count > 0
        ? ([
            Math.round(sum[0] / count),
            Math.round(sum[1] / count),
            Math.round(sum[2] / count),
            Math.round(sum[3] / count),
          ] as [number, number, number, number])
        : ([0, 0, 0, 0] as [number, number, number, number]);

    let level: "very_low" | "low" | "moderate" | "high" | "very_high" =
      "very_low";
    let label = "Very Low";

    if (avg[3] <= 0) {
      // fully transparent: outside mapped susceptible polygons
      level = "very_low";
      label = "Very Low (outside mapped polygons)";
    } else {
      // 4) Find nearest legend swatch by RGB distance
      let best = { i: -1, d: Number.POSITIVE_INFINITY };
      for (let i = 0; i < palette.length; i++) {
        const d = dist2(
          [avg[0], avg[1], avg[2]],
          palette[i].rgba.slice(0, 3) as number[]
        );
        if (d < best.d) best = { i, d };
      }
      const bestLabel = palette[best.i]?.key ?? "very low";
      level = mapLabelToLevel(bestLabel);
      label =
        level === "very_low" && !bestLabel.includes("very low")
          ? "Very Low (outside mapped polygons)"
          : bestLabel.replace(/\b\w/g, (m) => m.toUpperCase());
    }

    const body: any = {
      level,
      label,
      ui: toUi(level),
      source: { tile: tileUrl },
    };
    if (debug) {
      body.debug = { avgRGBA: avg, tilePixel: { px, py }, tile: t, palette };
    }

    return Response.json(body, {
      headers: { "Cache-Control": "s-maxage=86400" },
    });
  } catch (e: any) {
    return Response.json(
      { error: e?.message || "Landslide service error" },
      { status: 500 }
    );
  }
}
