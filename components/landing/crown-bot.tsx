import { useId } from "react";
import type { CrownColor, CrownState } from "../../src/landing/content";

const BODY: Record<CrownColor, { light: string; deep: string }> = {
  violet: { light: "#C4B2FF", deep: "#6E4DF5" },
  blue: { light: "#B7D0FF", deep: "#3A6FE0" },
  green: { light: "#B6E7C8", deep: "#2F9A62" },
  pink: { light: "#FFC6D8", deep: "#E56B96" },
  teal: { light: "#B7F0EC", deep: "#1AA3A3" },
};

export function CrownBot({
  color = "violet",
  state = "idle",
  size = 44,
  className = "",
  alt = "",
}: {
  color?: CrownColor;
  state?: CrownState;
  size?: number;
  className?: string;
  alt?: string;
}) {
  const id = useId().replace(/:/g, "");
  const body = BODY[color];
  const label = alt
    ? { role: "img" as const, "aria-label": alt }
    : { "aria-hidden": true as const };

  return (
    <svg
      className={`bot${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      {...label}
    >
      <defs>
        <linearGradient
          id={`${id}-body`}
          x1="32"
          y1="26"
          x2="32"
          y2="60"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor={body.light} />
          <stop offset="1" stopColor={body.deep} />
        </linearGradient>
        <linearGradient
          id={`${id}-gold`}
          x1="32"
          y1="6"
          x2="32"
          y2="28"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FFE38A" />
          <stop offset="1" stopColor="#E2A322" />
        </linearGradient>
      </defs>
      <ellipse cx="32" cy="58" rx="16" ry="3.2" fill="#3C288C" opacity="0.12" />
      <path fill={`url(#${id}-gold)`} d="M13 25.5 19.5 12l6.2 8.2L32 6l6.3 14.2L44.5 12 51 25.5Z" />
      <circle cx="19.5" cy="12" r="2.7" fill="#FFE38A" />
      <circle cx="32" cy="6.2" r="2.9" fill="#FFE38A" />
      <circle cx="44.5" cy="12" r="2.7" fill="#FFE38A" />
      <rect x="12.5" y="23.2" width="39" height="6.2" rx="2.2" fill="#E8B23C" />
      <circle cx="32" cy="26.2" r="1.8" fill="#E24B4B" />
      <rect x="10" y="28" width="44" height="28" rx="12" fill={`url(#${id}-body)`} />
      <path
        d="M16 34c4.5-3 10-4 16-4"
        stroke="#fff"
        strokeOpacity=".45"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <Eyes state={state} />
    </svg>
  );
}

function Eyes({ state }: { state: CrownState }) {
  if (state === "done") {
    return (
      <g fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round">
        <path d="M20 41.5c1.6 2.4 4.2 2.4 5.8 0" />
        <path d="M38.2 41.5c1.6 2.4 4.2 2.4 5.8 0" />
      </g>
    );
  }
  if (state === "working") {
    return (
      <g fill="#fff">
        <rect x="20" y="39" width="7" height="3.4" rx="1.7" />
        <rect x="37" y="39" width="7" height="3.4" rx="1.7" />
      </g>
    );
  }
  const y = state === "thinking" ? 36.5 : 39.5;
  return (
    <g fill="#fff">
      <rect x="21" y={y} width="6.2" height="11" rx="3.1" />
      <rect x="36.8" y={y} width="6.2" height="11" rx="3.1" />
    </g>
  );
}
