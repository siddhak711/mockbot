import type { ReactNode } from "react";

export function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function ComposeIcon() {
  return (
    <Icon>
      <path d="M12 20h9" strokeLinecap="round" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" strokeLinejoin="round" />
    </Icon>
  );
}

export function ClockIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
    </Icon>
  );
}

export function PlusIcon() {
  return (
    <Icon>
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </Icon>
  );
}

export function MenuIcon() {
  return (
    <Icon>
      <path d="M4 7h16M4 12h16M4 17h10" strokeLinecap="round" />
    </Icon>
  );
}

export function CloseIcon() {
  return (
    <Icon>
      <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
    </Icon>
  );
}

export function SendIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="M12 19V5M6 11l6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ChatIcon() {
  return (
    <Icon>
      <path d="M5 6.5h14v9H8l-3 3v-12Z" strokeLinejoin="round" />
    </Icon>
  );
}

export function TrafficLights() {
  return (
    <div className="traffic" aria-hidden="true">
      <span className="traffic-dot close" />
      <span className="traffic-dot min" />
      <span className="traffic-dot zoom" />
    </div>
  );
}
