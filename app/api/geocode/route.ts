export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(h: Record<string, string> = {}) {
  return { "content-type": "application/json", "access-control-allow-origin": "*", ...h };
}

const UA = process.env.GEOCODE_UA || "HydrauRiskChecker/1.0 (+server)";

type Hit = { lat: string; lon: string; display_name?: string };

async function fetchNominatim(url: string) {
  const r = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json" },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`nominatim ${r.status}`);
  const arr = (await r.json()) as Hit[] | any;
  return Array.isArray(arr) ? arr : [];
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const address = (u.searchParams.get("address") || "").trim();
  const debug = u.searchParams.get("debug") === "1";

  if (!address) {
    return new Response(JSON.stringify({ error: "address is required" }), { status: 400, headers: json() });
  }

  const base = "https://nominatim.openstreetmap.org";

  // --------- Prépare les différentes tentatives ---------
  const tries: Array<{ kind: string; url: string }> = [];

  // 1) q direct + filtre US
  const q1 = new URLSearchParams({ format: "jsonv2", q: address, limit: "1", addressdetails: "0", countrycodes: "us" });
  tries.push({ kind: "freeform-us", url: `${base}/search?${q1}` });

  // 2) q + ", USA"
  const q2 = new URLSearchParams({ format: "jsonv2", q: `${address}, USA`, limit: "1", addressdetails: "0" });
  tries.push({ kind: "freeform-usa-suffix", url: `${base}/search?${q2}` });

  // 3) structuré "street, city, state"
  const parts = address.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const street = parts[0];
    const city = parts.length >= 3 ? parts[1] : ""; // si deux parties seulement, city restera vide
    const state = parts.length >= 3 ? parts[2] : parts[1];
    const q3 = new URLSearchParams({
      format: "jsonv2",
      street,
      city,
      state,
      country: "USA",
      limit: "1",
      addressdetails: "0",
    });
    tries.push({ kind: "structured-street-city-state", url: `${base}/search?${q3}` });
  }

  // 4) fallback ville+état uniquement
  if (parts.length >= 2) {
    const cityOnly = parts.length >= 3 ? parts[1] : parts[0];
    const stateOnly = parts.length >= 3 ? parts[2] : parts[1];
    const q4 = new URLSearchParams({
      format: "jsonv2",
      city: cityOnly,
      state: stateOnly,
      country: "USA",
      limit: "1",
      addressdetails: "0",
    });
    tries.push({ kind: "structured-city-state", url: `${base}/search?${q4}` });
  }

  // --------- Exécution des tentatives ---------
  const report: any[] = [];
  for (const t of tries) {
    try {
      const arr = await fetchNominatim(t.url);
      if (arr && arr[0]) {
        const lat = parseFloat(arr[0].lat);
        const lon = parseFloat(arr[0].lon);
        const payload: any = {
          lat,
          lon,
          display_name: arr[0].display_name,
          source: t.kind,
        };
        if (debug) payload.debug = { tried: tries.map((x) => x.kind) };
        return new Response(JSON.stringify(payload), { headers: json() });
      }
      report.push({ kind: t.kind, hit: 0 });
    } catch (e: any) {
      report.push({ kind: t.kind, error: String(e?.message || e) });
    }
  }

  // Rien trouvé
  const body = debug
    ? { error: "no result", attempts: report }
    : { error: "no result" };
  return new Response(JSON.stringify(body), { status: 404, headers: json() });
}
