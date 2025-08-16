export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// JSON + CORS
function json(h: Record<string, string> = {}) {
  return { "content-type": "application/json", "access-control-allow-origin": "*", ...h };
}

// On utilise Photon (https://photon.komoot.io)
const UA = process.env.AC_UA || "HydrauRiskChecker/1.0 (+server)";

type PhotonFeature = {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    name?: string; street?: string; housenumber?: string;
    city?: string; county?: string; state?: string; postcode?: string; country?: string;
  };
};

function labelFromProps(p: NonNullable<PhotonFeature["properties"]>) {
  const parts = [
    [p.housenumber, p.street].filter(Boolean).join(" "),
    p.city || p.county,
    [p.state, p.postcode].filter(Boolean).join(" "),
    p.country,
  ].filter(Boolean);
  return parts.join(", ");
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const q = (u.searchParams.get("q") || "").trim();
  const limit = Math.min(Number(u.searchParams.get("limit") || 5), 10);
  const country = (u.searchParams.get("country") || "US").toUpperCase();
  const lat = u.searchParams.get("lat");
  const lon = u.searchParams.get("lon");

  if (q.length < 3) {
    return new Response(JSON.stringify({ suggestions: [] }), { headers: json() });
  }

  const params = new URLSearchParams({
    q,
    limit: String(limit),
    lang: "en",
    // bias optionnels
    ...(lat && lon ? { lat, lon } : {}),
  });

  // Filtre pays via tag OSM (Photon n'a pas countrycodes natif)
  // Mais comme beaucoup d'adresses US ressortent d'elles-mêmes, on filtre côté serveur.
  const url = `https://photon.komoot.io/api/?${params}`;

  const r = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/json" },
    cache: "no-store",
  });
  if (!r.ok) {
    return new Response(JSON.stringify({ error: `autocomplete failed (${r.status})` }), { status: 502, headers: json() });
  }
  const data = await r.json();
  const feats: PhotonFeature[] = data?.features || [];

  const suggestions = feats
    .map((f) => {
      const p = f.properties || {};
      const coords = f.geometry?.coordinates || null;
      const label = labelFromProps(p) || p.name || "";
      const countryOk = !country || (p.country || "").toUpperCase().includes(country);
      if (!coords || !label || !countryOk) return null;
      return { label, lat: coords[1], lon: coords[0] };
    })
    .filter(Boolean)
    .slice(0, limit);

  return new Response(JSON.stringify({ suggestions }), { headers: json() });
}
