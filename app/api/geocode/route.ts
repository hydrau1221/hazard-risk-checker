import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// --- helpers ---------------------------------------------------------------

function ok(lat: number, lon: number, meta: Record<string, any> = {}) {
  return Response.json({ lat, lon, ...meta }, { headers: { "cache-control": "no-store" } });
}

type Parsed = { street: string; city?: string; state?: string; zip?: string };

const SUFFIX_EXPAND: Record<string, string> = {
  RD: "Road",
  ST: "Street",
  AVE: "Avenue",
  BLVD: "Boulevard",
  HWY: "Highway",
  LN: "Lane",
  DR: "Drive",
  CT: "Court",
  PL: "Place",
  CIR: "Circle",
  PKWY: "Parkway",
  TER: "Terrace",
};

function expandStreetSuffix(street: string): string[] {
  const out = new Set<string>();
  out.add(street);

  const parts = street.trim().split(/\s+/);
  const last = parts[parts.length - 1]?.replace(/\./g, "").toUpperCase();
  if (last && SUFFIX_EXPAND[last]) {
    const full = [...parts.slice(0, -1), SUFFIX_EXPAND[last]].join(" ");
    out.add(full);
  }
  // essaye aussi avec le suffixe “Rd” sans point, etc.
  if (last && SUFFIX_EXPAND[last]) {
    const abbr = last[0] + last.slice(1).toLowerCase();
    out.add([...parts.slice(0, -1), abbr].join(" "));
  }
  return [...out];
}

/** Parsea "street, city, ST 12345" (variantes tolérées). */
function parseUS(addr: string): Parsed | null {
  // ex: "763 Mall Rd, Fayetteville, WV 25840"
  const rx = /^\s*(.+?)\s*,\s*([A-Za-z .'-]+?)\s*,\s*([A-Z]{2})(?:\s+(\d{5})(?:-\d{4})?)?\s*$/;
  const m = addr.match(rx);
  if (m) {
    const [, street, city, state, zip] = m;
    return { street: street.trim(), city: city.trim(), state, zip };
  }
  // ex: "763 Mall Rd, Fayetteville, WV" (sans ZIP)
  const rx2 = /^\s*(.+?)\s*,\s*([A-Za-z .'-]+?)\s*,\s*([A-Z]{2})\s*$/;
  const m2 = addr.match(rx2);
  if (m2) {
    const [, street, city, state] = m2;
    return { street: street.trim(), city: city.trim(), state };
  }
  return null;
}

// --- main ------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const u = new URL(req.url);
  const addressRaw = (u.searchParams.get("address") || "").trim();
  const debug = u.searchParams.get("debug") === "1";
  if (!addressRaw) return Response.json({ error: "missing address" }, { status: 400 });

  const attempts: any[] = [];

  async function tryCensusOneLine(addr: string, benchmark: string) {
    const url =
      "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress" +
      `?address=${encodeURIComponent(addr)}&benchmark=${encodeURIComponent(benchmark)}&format=json`;
    try {
      const r = await fetch(url, { cache: "no-store" });
      const j: any = await r.json();
      const matches = j?.result?.addressMatches ?? [];
      attempts.push({ engine: "census-oneline", benchmark, url, status: r.status, count: matches.length });
      if (r.ok && matches.length > 0) {
        const m = matches[0];
        const lat = Number(m?.coordinates?.y);
        const lon = Number(m?.coordinates?.x);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          const meta: any = { matched: m?.matchedAddress ?? null, source: "census", benchmark, mode: "oneline" };
          if (debug) meta.attempts = attempts;
          return ok(lat, lon, meta);
        }
      }
    } catch (e: any) {
      attempts.push({ engine: "census-oneline", benchmark, error: String(e) });
    }
    return null;
  }

  async function tryCensusStructured(p: Parsed, streetVariant: string, benchmark: string) {
    // https://geocoding.geo.census.gov/geocoder/locations/address?street=...&city=...&state=WV&zip=25840&benchmark=...
    const params = new URLSearchParams({
      street: streetVariant,
      format: "json",
      benchmark,
    });
    if (p.city) params.set("city", p.city);
    if (p.state) params.set("state", p.state);
    if (p.zip) params.set("zip", p.zip);

    const url = `https://geocoding.geo.census.gov/geocoder/locations/address?${params.toString()}`;
    try {
      const r = await fetch(url, { cache: "no-store" });
      const j: any = await r.json();
      const matches = j?.result?.addressMatches ?? [];
      attempts.push({
        engine: "census-structured",
        benchmark,
        url,
        status: r.status,
        count: matches.length,
      });
      if (r.ok && matches.length > 0) {
        const m = matches[0];
        const lat = Number(m?.coordinates?.y);
        const lon = Number(m?.coordinates?.x);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          const meta: any = { matched: m?.matchedAddress ?? null, source: "census", benchmark, mode: "structured" };
          if (debug) meta.attempts = attempts;
          return ok(lat, lon, meta);
        }
      }
    } catch (e: any) {
      attempts.push({ engine: "census-structured", benchmark, error: String(e) });
    }
    return null;
  }

  async function tryOSM(addr: string) {
    const url =
      "https://nominatim.openstreetmap.org/search" +
      `?format=jsonv2&limit=1&q=${encodeURIComponent(addr)}`;
    try {
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
          const meta: any = { display_name: it.display_name ?? null, source: "nominatim" };
          if (debug) meta.attempts = attempts;
          return ok(lat, lon, meta);
        }
      }
    } catch (e: any) {
      attempts.push({ engine: "nominatim", error: String(e) });
    }
    return null;
  }

  // 0) On tente d’abord le “structured” si on arrive à parser
  const parsed = parseUS(addressRaw);

  if (parsed) {
    // Variantes de rue (Rd→Road, etc.)
    const streetVariants = expandStreetSuffix(parsed.street);

    for (const bench of ["Public_AR_Census2020", "Public_AR_Current"]) {
      for (const sv of streetVariants) {
        // 0a) Structured avec ZIP si disponible
        {
          const res = await tryCensusStructured(parsed, sv, bench);
          if (res) return res;
        }
        // 0b) Structured sans ZIP (parfois le ZIP bloque)
        if (parsed.zip) {
          const { zip, ...noZip } = parsed;
          const res = await tryCensusStructured(noZip, sv, bench);
          if (res) return res;
        }
      }
    }
  }

  // 1) Oneline (plus tolérant) – deux benchmarks + variantes ", USA"
  const v1 = addressRaw;
  const v2 = /(^|,)\s*(USA|United States)$/i.test(addressRaw) ? addressRaw : `${addressRaw}, USA`;

  for (const bench of ["Public_AR_Census2020", "Public_AR_Current"]) {
    {
      const res = await tryCensusOneLine(v1, bench);
      if (res) return res;
    }
    {
      const res = await tryCensusOneLine(v2, bench);
      if (res) return res;
    }
  }

  // 2) OSM (fallback) – 2 variantes
  {
    const res = await tryOSM(v1);
    if (res) return res;
  }
  {
    const res = await tryOSM(v2);
    if (res) return res;
  }

  const body: any = { error: "no result" };
  if (debug) body.attempts = attempts;
  return Response.json(body, { status: 404 });
}
