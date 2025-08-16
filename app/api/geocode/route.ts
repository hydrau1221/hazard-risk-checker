import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Petit util pour construire une réponse succès */
function ok(lat: number, lon: number, meta: Record<string, any> = {}) {
  return Response.json(
    { lat, lon, ...meta },
    { headers: { "cache-control": "no-store" } }
  );
}

export async function GET(req: NextRequest) {
  const u = new URL(req.url);
  const addressRaw = u.searchParams.get("address")?.trim();
  const debug = u.searchParams.get("debug") === "1";
  if (!addressRaw) return Response.json({ error: "missing address" }, { status: 400 });

  // Variantes d’adresse à essayer (ajoute USA, garde ZIP si présent, etc.)
  const addUSA = (s: string) =>
    /(^|,)\s*(USA|United States)$/i.test(s) ? s : `${s}, USA`;

  const variants: string[] = [];
  variants.push(addressRaw);
  variants.push(addUSA(addressRaw));

  // Si l’adresse est du type "city, state", on pousse aussi avec ZIP retiré / épuré
  // (US Census aime bien les adresses complètes, mais on tente plusieurs formes)
  const compact = addressRaw.replace(/\s+/g, " ").replace(/\s+,/g, ",").trim();
  if (!variants.includes(compact)) variants.push(compact);
  const compactUSA = addUSA(compact);
  if (!variants.includes(compactUSA)) variants.push(compactUSA);

  const attempts: any[] = [];

  /** 1) US Census – onelineaddress (deux benchmarks) */
  async function tryCensus(addr: string, benchmark: string) {
    const url =
      "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress" +
      `?address=${encodeURIComponent(addr)}` +
      `&benchmark=${encodeURIComponent(benchmark)}` +
      "&format=json";
    let j: any = null;
    try {
      const r = await fetch(url, { cache: "no-store" });
      const text = await r.text();
      try { j = text ? JSON.parse(text) : null; } catch {}
      const matches = j?.result?.addressMatches ?? [];
      attempts.push({ engine: "census", benchmark, url, status: r.status, count: matches.length });

      if (r.ok && matches.length > 0) {
        const m = matches[0];
        const lat = Number(m?.coordinates?.y);
        const lon = Number(m?.coordinates?.x);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          const meta: any = { matched: m?.matchedAddress ?? null, source: "census", benchmark };
          if (debug) meta.attempts = attempts;
          return ok(lat, lon, meta);
        }
      }
    } catch (e: any) {
      attempts.push({ engine: "census", benchmark, error: String(e) });
    }
    return null;
  }

  /** 2) Nominatim (OpenStreetMap) – fallback robuste */
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

  // --- Ordre des tentatives ---
  // Pour chaque variante, on tente Census (2020), puis Census (Current), puis OSM
  for (const v of variants) {
    // Census – benchmark 2020 (stable sur adresses US récentes)
    {
      const res = await tryCensus(v, "Public_AR_Census2020");
      if (res) return res;
    }
    // Census – benchmark courant (dans le doute)
    {
      const res = await tryCensus(v, "Public_AR_Current");
      if (res) return res;
    }
    // Nominatim – fallback
    {
      const res = await tryOSM(v);
      if (res) return res;
    }
  }

  // Rien trouvé : on renvoie le détail des tentatives si debug
  const body: any = { error: "no result" };
  if (debug) body.attempts = attempts;
  return Response.json(body, { status: 404 });
}
