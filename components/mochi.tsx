"use client";

import { useEffect, useRef, useState } from "react";
import { spriteLabel, spritePixels, spriteSrc, type SpriteState } from "../src/sprite";
import { useTheme } from "./theme";

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);
  return reduced;
}

export function Mochi({
  state,
  size = 24,
  label,
}: {
  state: SpriteState;
  size?: number;
  label?: string;
}) {
  const { scheme } = useTheme();
  const reduced = usePrefersReducedMotion();
  const px = spritePixels(size);
  const src = spriteSrc(state, scheme, reduced);
  const shown = useRef(src);
  const [previous, setPrevious] = useState<string | null>(null);

  useEffect(() => {
    if (shown.current === src) return;
    const prior = shown.current;
    shown.current = src;
    if (reduced) {
      setPrevious(null);
      return;
    }
    setPrevious(prior);
    const timer = window.setTimeout(() => setPrevious(null), 150);
    return () => window.clearTimeout(timer);
  }, [src, reduced]);

  const name = label === undefined ? "" : label || `Mochi, ${spriteLabel(state)}`;

  return (
    <span className="mochi-slot" style={{ width: px, height: px }} data-sprite-state={state}>
      {previous ? (
        <img className="mochi mochi-out" src={previous} alt="" width={px} height={px} />
      ) : null}
      <img className="mochi" src={src} alt={name} width={px} height={px} draggable={false} />
    </span>
  );
}
