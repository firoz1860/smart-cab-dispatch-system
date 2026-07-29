import { useEffect } from "react";
import "@google/model-viewer";

const INTRO_DURATION_MS = 3000;

/** Plays once right after a successful sign-in: a 3D cab drives across the
 * screen while two panels slide open (like an automatic platform/gate)
 * to reveal the dashboard underneath. */
export function SignInIntro({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, INTRO_DURATION_MS);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <div className="signin-intro">
      <div className="signin-intro-panel signin-intro-panel-left" />
      <div className="signin-intro-panel signin-intro-panel-right" />
      <div className="signin-intro-brand">Smart Cab Dispatch</div>
      <model-viewer
        className="signin-intro-cab"
        src="/models/cab.glb"
        alt="A cab arriving"
        shadow-intensity="1"
        exposure="1"
        camera-orbit="60deg 75deg auto"
        field-of-view="30deg"
        loading="eager"
        reveal="auto"
      />
    </div>
  );
}
