import { useEffect, useRef, useState } from "react";

/** Ticks a server-provided ETA (seconds) down once per second on the client,
 * so it feels live between poll/socket updates instead of a static number
 * that only changes every few seconds. Re-anchors to the fresh server value
 * whenever it changes. */
export function useLiveCountdown(etaSeconds: number | null | undefined): number | null {
  const [display, setDisplay] = useState<number | null>(etaSeconds ?? null);
  const baseRef = useRef<{ value: number; at: number } | null>(null);

  useEffect(() => {
    if (etaSeconds == null) {
      baseRef.current = null;
      setDisplay(null);
      return;
    }
    baseRef.current = { value: etaSeconds, at: Date.now() };
    setDisplay(etaSeconds);
  }, [etaSeconds]);

  useEffect(() => {
    if (etaSeconds == null) return;
    const interval = setInterval(() => {
      if (!baseRef.current) return;
      const elapsed = Math.floor((Date.now() - baseRef.current.at) / 1000);
      setDisplay(Math.max(0, baseRef.current.value - elapsed));
    }, 1000);
    return () => clearInterval(interval);
  }, [etaSeconds]);

  return display;
}
