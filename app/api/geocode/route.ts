// app/api/geocode/route.ts
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const u = new URL(req.url);
  const address = u.searchParams.get("address")?.trim();
  const debug = u.searchParams.get("debug") === "1";
  if (!address) {
    return Response.json({ error: "missing address" }, { status: 400 });
  }

  const attempts: any[] = [];

  // 1) US Census Geocoder (adresse -> coords)
  try {
    const url =
      "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress" +
      `?address=${encodeURIComponent(address)}` +
      "&benchmark=Public_AR_Census2020&format=json";
    const r = await fetch(url, { cache: "no-store" });
    const j: any = await r.json();
    const matches = j?.result?.addressMatches ?? [];
    attempts.push({ engine: "census", url, status: r.status, count: matches.length });

    if (r.ok && matches.length > 0) {
      const m = matches[0];
      const lat = Number(m?.coordinates?.y);
      const lon = Number(m?.coordinates?.x);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        const out: any = {
          lat,
          lon,
          matched: m?.matchedAddress ?? null,
          source: "census",
        };
        if (debug) out.attempts = attempts;
        return Response.json(out, { headers: { "cache-control": "no-store" } });
      }
    }
  } catch (e: any) {
    attempts.push({ engine: "census", error: String(e) });
  }

  // 2) Fallback: Nominatim (OpenStreetMap)
  try {
    const url =
      "https://nominatim.openstreetmap.org/search" +
      `?format=jsonv2&limit=1&q=${encodeURIComponent(address)}`;
    const r = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": "HydrauRiskChecker/1.0 (contact)" },
    });
    const arr: any[] = await r.json();
    attempts.push({ engine: "nominatim", url, status: r.status, count: arr?.length ?? 0 });

    if (r.ok && Array.isArray(arr) && arr.length > 0) {
      const it = arr[0];
      const lat = Number(it.lat);
      const lon = Number(it.lon);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        const out: any = {
          lat,
          lon,
          display_name: it.display_name ?? null,
          source: "nominatim",
        };
        if (debug) out.attempts = attempts;
        return Response.json(out, { headers: { "cache-control": "no-store" } });
      }
    }
  } catch (e: any) {
    attempts.push({ engine: "nominatim", error: String(e) });
  }

  return Response.json(
    { error: "no result", attempts },
    { status: 404 }
  );
}
