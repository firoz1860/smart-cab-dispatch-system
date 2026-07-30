/**
 * Cache abstraction (Dependency Inversion + Open/Closed): every call site
 * below depends on the `Cache` interface, never on a concrete
 * implementation. `InMemoryCache` is the only implementation today, correct
 * for the single-process deployment this project targets (see
 * DEPLOYMENT.txt), but a horizontally-scaled deployment could swap in a
 * `RedisCache` implementing the same interface with zero changes to any
 * call site - the interface is the seam, not a rewrite.
 */
export interface Cache {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlMs: number): void;
  invalidate(key: string): void;
  /** Invalidate every key starting with `prefix` - used when a single write
   * can affect many cached entries (e.g. one keyed by a variable id). */
  invalidatePrefix(prefix: string): void;
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

const SWEEP_INTERVAL_MS = 60_000;

class InMemoryCache implements Cache {
  private store = new Map<string, Entry>();

  constructor() {
    const timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    timer.unref?.(); // never keep the process alive just for cache cleanup
  }

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  invalidatePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt < now) this.store.delete(key);
    }
  }
}

export const cache: Cache = new InMemoryCache();

/** Read-through helper: return the cached value if present, otherwise call
 * `load`, cache its result, and return it. Keeps call sites from having to
 * repeat the get-or-load dance by hand. */
export async function cached<T>(cacheImpl: Cache, key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cacheImpl.get<T>(key);
  if (hit !== undefined) return hit;
  const value = await load();
  cacheImpl.set(key, value, ttlMs);
  return value;
}
