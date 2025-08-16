// après avoir récupéré `top = await fetchJSON(`${base}/MapServer?f=json`)`
const layers: any[] = top?.layers ?? [];

// 1) Match direct par nom
const direct = layers.find((L: any) => {
  const n = String(L.name).toUpperCase();
  return n === "S_FLD_HAZ_AR" || n.includes("FLOOD HAZARD ZONES");
});
if (direct) {
  return new Response(JSON.stringify({
    base,
    layerId: direct.id,
    name: direct.name,
    serviceUrl: `${base}/MapServer/${direct.id}`,
  }), { headers: json() });
}

// 2) Fallback — on inspecte et on score par champs (FLD_ZONE, SFHA_TF, etc.)
const leaves = layers.filter((L: any) => !L.subLayerIds || L.subLayerIds.length === 0);
const candidates: Array<{ id: number; name: string; score: number }> = [];

for (const L of leaves) {
  try {
    const info = await fetchJSON(`${base}/MapServer/${L.id}?f=json`);
    const geom = String(info?.geometryType || "").toLowerCase();
    if (!geom.includes("polygon")) continue;
    const names = (info?.fields || []).map((f: any) => String(f.name).toUpperCase());
    let score = 0;
    if (names.includes("FLD_ZONE")) score += 5;
    if (names.includes("SFHA_TF")) score += 3;
    if (names.includes("ZONE_SUBTY") || names.includes("ZONE_SUBTYPE")) score += 2;
    if (names.includes("BFE") || names.includes("STATIC_BFE") || names.includes("DEPTH") || names.includes("VE_ZONE")) score += 1;
    const nm = String(info?.name || "").toUpperCase();
    if (nm.includes("FLOOD") && nm.includes("HAZARD")) score += 2;
    candidates.push({ id: L.id, name: info?.name ?? L.name, score });
  } catch {}
}

candidates.sort((a, b) => b.score - a.score);
const best = candidates[0];
if (best && best.score >= 5) {
  return new Response(JSON.stringify({
    base,
    layerId: best.id,
    name: best.name,
    serviceUrl: `${base}/MapServer/${best.id}`,
  }), { headers: json() });
}

return new Response(JSON.stringify({ error: "NFHL flood layer not found on this base." }), {
  status: 404, headers: json(),
});
