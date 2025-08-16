"use client";

import { useState } from "react";

type Feature = { attributes: Record<string, any> };

export default function Home() {
  // On fixe directement l'ID du layer FEMA (Flood Hazard Zones)
  const [layerId] = useState<number>(28);
  const layerSource = "fixed-28";
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Feature[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    setError(null);
    setResult(null);
    const latNum = Number(lat);
    const lonNum = Number(lon);
    if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
      setError("Latitude/Longitude invalides.");
      return;
    }
    setLoading(true);
    try {
      const r = await fetch(`/api/fema/query?lat=${latNum}&lon=${lonNum}&layerId=${layerId}`, { cache: "n
