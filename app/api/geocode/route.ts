// app/api/geocode/route.ts
import { NextRequest } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function ok(lat: number, lon: number, meta: Record<string, any> = {}) {
  return Response.json({ lat, lon, ...meta }, { headers: { "cache-control": "no-store" } });
}

const NOMINATIM_UA =
  process.env.NOMINATIM_UA ||
  "HydrauRiskChecker/1.0 (contact@example.com)"; // ← mets ton email/domaine

type Parsed = { street: string; city?: string; state?: string; zip?: string };

/** Parse "195 Center St, Marysvale, UT 84750" (zip optionnel) */
function parseUS(addr: string): Parsed | null {
  const rx = /^\s*(.+?)\s*,\s*([A-Za-z .'-]+?)\s*,\s*([A-Z]{2})(?:\s+(\d{5})(?:-\d{4})?)?\s*$/;
  const m = addr.match(rx);
  if (m) return { street: m[1].trim(), city: m[2].trim(), state: m[3], zip: m[4] };
  const rx2 = /^\s*(.+?)\s*,\s*([A-Za-z .'-]+?)\s*,\s*([A-Z]{2})\s*$/;
  const m2 = addr.match(rx2);
  if (m2) return { street: m2[1].trim(), city: m2[2].trim(), state: m2[3] };
  return null;
}

/** Census (structured) — adresse stricte */
async function censusStructured(p: Parsed, benchmark: string, attempts: any[]) {
  const params = new URLSearchParams({
    street: p.street,
    format: "json",
    benchmark,
  });
  if (p.city) params.set("city", p.city);
  if (p.state) params.set("state", p.state);
  if (p.zip) params.set("zip", p.zip);

  const url = `https://geocoding.geo.census.gov/geocoder/locations/address?${params.toString()}`;
  const r = await fetch(url, { cache: "no-store" });
  const j: any = await r.json().catch(() => null);
  const matches = j?.result?.addressMatches ?? [];
  attempts.push({ engine: "census-structured", benchmark, url, status: r.status, count: matches.length });
  if (r.ok && matches.length > 0) {
    const m = matches[0];
    const lat = Number(m?.coordinates?.y);
    const lon = Number(m?.coordinates?.x);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return ok(lat, lon, {
        matched: m?.matchedAddress ?? null,
        source: "census",
        benchmark,
        mode: "address",
        precision: "address",
      });
    }
  }
  return null;
}

/** Census (oneline) — un peu plus permissif, toujours “adresse” si trouvé */
async function censusOneLine(address: string, benchmark: string, attempts: any[]) {
  const params = new URLSearchParams({ address, format: "json", benchmark });
  const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${params.toString()}`;
  const r = await fetch(url, { cache: "no-store" });
  const j: any = await r.json().catch(() => null);
  const matches = j?.result?.addressMatches ?? [];
  attempts.push({ engine: "census-oneline", benchmark, url, status: r.status, count: matches.length });
  if (r.ok && matches.length > 0) {
    const m = matches[0];
    const lat = Number(m?.coordinates?.y);
    const lon = Number(m?.coordinates?.x);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return ok(lat, lon, {
        matched: m?.matchedAddress ?? null,
        source: "census",
        benchmark,
        mode: "address",
        precision: "address",
      });
    }
  }
  return null;
}

/** Nominatim — adresse libre */
async function osmAddress(addr: string, attempts: any[]) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(addr)}`;
  const r = await fetch(url, { cache: "no-store", headers: { "User-Agent": NOMINATIM_UA } });
  const arr: any[] = await r.json().catch(() => []) as any[];
  attempts.push({ engine: "nominatim-address", url, status: r.status, count: Array.isArray(arr) ? arr.length : 0 });
  if (r.ok && Array.isArray(arr) && arr.length > 0) {
    const it = arr[0];
    const lat = Number(it.lat), lon = Number(it.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      return ok(lat, lon, {
        display_name: it.display_name ?? null,
        source: "nominatim",
        mode: "address",
        precision: "address",
      });
    }
  }
  return null;
}

/** ✅ Nominatim — fallback centroïde de ville */
async function osmCity(p: Parsed, attempts: any[]) {
  if (!p.city || !p.state) return null;
  const params = new URLSearchParams({
    format: "jsonv2",
    country: "USA",
    city: p.city,
    state: p.state,
    limit: "1",
  });
  if (p.zip) params.set("postalcode", p.zip);

  const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
  const r = await fetch(url, { cache: "no-store", headers: { "User-Agent": NOMINATIM_UA } });
  const arr: any[] = await r.json().catch(() => []) as any[];
  attempts.push({ engine: "nominatim-city", url, status: r.status, count: Array.isArray(arr) ? arr.length : 0 });

  if (r.ok && Array.isArray(arr) && arr.length > 0) {
    const it = arr[0];
    const lat = Number(it.lat), lon = Number(it.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const place = [p.city, p.state, p.zip].filter(Boolean).join(", ");
      return ok(lat, lon, {
        display_name: it.display_name ?? null,
        placeLabel: place,
        source: "nominatim",
        mode: "city",
        precision: "city",
        reason: "exact-address-not-found",
      });
    }
  }
  return null;
}

export async function GET(req: NextRequest) {
  const u = new URL(req.url);
  const address = (u.searchParams.get("address") || "").trim();
  const debug = u.searchParams.get("debug") === "1";
  if (!address) return Response.json({ error: "missing address" }, { status: 400 });

  const attempts: any[] = [];
  const parsed = parseUS(address);

  // 1) Census structured (2020 puis Current) — avec/sans ZIP
  if (parsed) {
    for (const bench of ["Public_AR_Census2020", "Public_AR_Current"]) {
      const r1 = await censusStructured(parsed, bench, attempts);
      if (r1) { const j = await r1.json(); if (debug) j.attempts = attempts; return Response.json(j); }
      if (parsed.zip) {
        const { zip, ...noZip } = parsed;
        const r2 = await censusStructured(noZip, bench, attempts);
        if (r2) { const j2 = await r2.json(); if (debug) j2.attempts = attempts; return Response.json(j2); }
      }
    }
  }

  // 2) Census one-line
  for (const bench of ["Public_AR_Census2020", "Public_AR_Current"]) {
    const r3 = await censusOneLine(address, bench, attempts);
    if (r3) { const j3 = await r3.json(); if (debug) j3.attempts = attempts; return Response.json(j3); }
  }

  // 3) Nominatim adresse
  const rO = await osmAddress(address, attempts);
  if (rO) { const j = await rO.json(); if (debug) j.attempts = attempts; return Response.json(j); }

  // 4) ✅ Fallback centroïde de ville (avec precision="city")
  if (parsed) {
    const rCity = await osmCity(parsed, attempts);
    if (rCity) { const jc = await rCity.json(); if (debug) jc.attempts = attempts; return Response.json(jc); }
  }

  // 5) Rien
  const body: any = { error: "no result" };
  if (debug) body.attempts = attempts;
  return Response.json(body, { status: 404 });
}
