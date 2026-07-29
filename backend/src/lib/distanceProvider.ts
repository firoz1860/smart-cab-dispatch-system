// Distance/ETA provider abstraction.
//
// Default implementation: Haversine great-circle distance + a road-network
// "windiness" factor + a time-of-day traffic multiplier + small live jitter to
// simulate changing traffic conditions between re-optimization ticks. This
// requires no external API key and is deterministic enough to test against.
//
// Production swap: set GOOGLE_MAPS_API_KEY in .env and use
// GoogleDistanceMatrixProvider, which batches origins/destinations through the
// Google Distance Matrix API (falling back to Haversine on error/quota issues
// so the dispatch engine never hard-fails on a maps outage). See docs/DESIGN.md
// for the trade-off discussion (cost/latency vs. real traffic accuracy).

export interface LatLng {
  lat: number;
  lng: number;
}

export interface EtaResult {
  distanceMeters: number;
  durationSeconds: number;
}

export interface DistanceProvider {
  getEta(origin: LatLng, dest: LatLng, atTime?: Date): Promise<EtaResult>;
  getEtaMatrix(origins: LatLng[], dests: LatLng[], atTime?: Date): Promise<EtaResult[][]>;
}

const EARTH_RADIUS_M = 6371000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

// Roads are never straight lines; scale as-the-crow-flies distance up.
const ROAD_WINDINESS_FACTOR = 1.35;
// Average city-plus-highway effective speed, in m/s (~32 km/h base).
const BASE_SPEED_MPS = 8.9;

function trafficMultiplier(atTime: Date): number {
  const hour = atTime.getHours();
  // Rush hours (7-10am, 5-9pm) slow things down; late night is faster.
  if ((hour >= 7 && hour < 10) || (hour >= 17 && hour < 21)) return 1.6;
  if (hour >= 22 || hour < 6) return 0.85;
  return 1.15;
}

// Small pseudo-random jitter so repeated calls across re-optimization ticks
// don't return byte-identical ETAs (simulating live traffic drift) while
// staying deterministic per (origin, dest, 5-min time bucket) for cacheability.
function jitter(seedKey: string): number {
  let h = 0;
  for (let i = 0; i < seedKey.length; i++) {
    h = (h * 31 + seedKey.charCodeAt(i)) | 0;
  }
  const frac = Math.abs(h % 1000) / 1000; // 0..1
  return 0.9 + frac * 0.25; // 0.9x - 1.15x
}

function timeBucketKey(d: Date): string {
  const bucketMinutes = 5;
  const bucketed = Math.floor(d.getTime() / (bucketMinutes * 60 * 1000));
  return String(bucketed);
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function pairKey(a: LatLng, b: LatLng, atTime: Date): string {
  return `${round(a.lat, 4)},${round(a.lng, 4)}|${round(b.lat, 4)},${round(b.lng, 4)}|${timeBucketKey(
    atTime
  )}`;
}

/** In-memory cache so repeated matrix computations for the same time bucket are cheap. */
const cache = new Map<string, EtaResult>();

export class HaversineDistanceProvider implements DistanceProvider {
  async getEta(origin: LatLng, dest: LatLng, atTime: Date = new Date()): Promise<EtaResult> {
    const key = pairKey(origin, dest, atTime);
    const cached = cache.get(key);
    if (cached) return cached;

    const straightLine = haversineMeters(origin, dest);
    const roadDistance = straightLine * ROAD_WINDINESS_FACTOR;
    const traffic = trafficMultiplier(atTime) * jitter(key);
    const durationSeconds = Math.round((roadDistance / BASE_SPEED_MPS) * traffic);

    const result: EtaResult = { distanceMeters: Math.round(roadDistance), durationSeconds };
    cache.set(key, result);
    return result;
  }

  async getEtaMatrix(
    origins: LatLng[],
    dests: LatLng[],
    atTime: Date = new Date()
  ): Promise<EtaResult[][]> {
    // Batched locally (no network calls), but shaped like a real matrix API
    // response so swapping in Google's Distance Matrix API is a drop-in change.
    return Promise.all(
      origins.map((o) => Promise.all(dests.map((d) => this.getEta(o, d, atTime))))
    );
  }
}

export class GoogleDistanceMatrixProvider implements DistanceProvider {
  private fallback = new HaversineDistanceProvider();
  constructor(private apiKey: string) {}

  async getEta(origin: LatLng, dest: LatLng, atTime: Date = new Date()): Promise<EtaResult> {
    const matrix = await this.getEtaMatrix([origin], [dest], atTime);
    return matrix[0][0];
  }

  async getEtaMatrix(
    origins: LatLng[],
    dests: LatLng[],
    atTime: Date = new Date()
  ): Promise<EtaResult[][]> {
    try {
      const originsParam = origins.map((o) => `${o.lat},${o.lng}`).join("|");
      const destsParam = dests.map((d) => `${d.lat},${d.lng}`).join("|");
      const url =
        `https://maps.googleapis.com/maps/api/distancematrix/json?` +
        `origins=${encodeURIComponent(originsParam)}&destinations=${encodeURIComponent(
          destsParam
        )}&departure_time=${Math.floor(atTime.getTime() / 1000)}&key=${this.apiKey}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Distance Matrix API HTTP ${res.status}`);
      const data: any = await res.json();
      if (data.status !== "OK") throw new Error(`Distance Matrix API status ${data.status}`);

      return data.rows.map((row: any) =>
        row.elements.map((el: any) => {
          if (el.status !== "OK") {
            // Element-level failure (e.g. no route) - fall back for that pair.
            return null;
          }
          return {
            distanceMeters: el.distance.value,
            durationSeconds: (el.duration_in_traffic ?? el.duration).value,
          } as EtaResult;
        })
      );
    } catch (err) {
      // Graceful degradation: never let a maps outage take down dispatch.
      console.warn("[distanceProvider] Google Distance Matrix failed, falling back:", err);
      return this.fallback.getEtaMatrix(origins, dests, atTime);
    }
  }
}

let provider: DistanceProvider | null = null;

export function getDistanceProvider(): DistanceProvider {
  if (provider) return provider;
  const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
  provider = apiKey ? new GoogleDistanceMatrixProvider(apiKey) : new HaversineDistanceProvider();
  return provider;
}
