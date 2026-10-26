"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  DEFAULT_SPRITE_COLOR,
  SPRITE_PREFERRED_PX,
  spriteLabel,
  spritePixels,
  spriteSrc,
  spriteSrcSet,
  type SpriteColor,
  type SpriteState,
} from "../src/sprite";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useIsoLayoutEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);
  return reduced;
}

export function BotSprite({
  state,
  color = DEFAULT_SPRITE_COLOR,
  size = SPRITE_PREFERRED_PX,
  label,
}: {
  state: SpriteState;
  color?: SpriteColor;
  size?: number;
  /** Accessible name. Omit it when the sprite sits inside a control that already has a name. */
  label?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const px = spritePixels(size);
  const src = spriteSrc(state, color, reduced);
  const srcSet = spriteSrcSet(state, color, reduced);
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

  const name = label ?? "";

  return (
    <span
      className="bot-sprite-slot"
      style={{ width: px, height: px }}
      data-sprite-state={state}
      data-sprite-color={color}
      data-sprite-motion={reduced ? "static" : "animated"}
    >
      {previous ? (
        <img className="bot-sprite bot-sprite-out" src={previous} alt="" width={px} height={px} />
      ) : null}
      <img
        className="bot-sprite"
        src={src}
        srcSet={srcSet}
        alt={name}
        width={px}
        height={px}
        draggable={false}
      />
    </span>
  );
}

export function botSpriteLabel(name: string, state: SpriteState): string {
  return `${name}, ${spriteLabel(state)}`;
}
