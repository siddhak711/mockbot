"use client";

import type { ReactNode, RefObject } from "react";
import type { ToolRisk } from "../src/connectors/policy";
import { CheckIcon, SearchIcon } from "./icons";

export function Monogram({
  label,
  color,
  ink = false,
  muted = false,
  large = false,
}: {
  label: string;
  color?: string;
  ink?: boolean;
  muted?: boolean;
  large?: boolean;
}) {
  const className = `monogram${large ? " lg" : ""}${ink ? " ink" : ""}${muted ? " muted" : ""}`;
  return (
    <span className={className} style={color && !ink && !muted ? { background: color } : undefined} aria-hidden="true">
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function SwitchControl({
  checked,
  label,
  disabled,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="switch"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-track">
        <span className="switch-knob" />
      </span>
    </button>
  );
}

export function RiskPill({ risk }: { risk: ToolRisk }) {
  if (risk === "destructive") return <span className="risk-pill danger">destructive · asks first</span>;
  if (risk === "write") return <span className="risk-pill">write · asks first</span>;
  return <span className="risk-pill">read</span>;
}

export function Notice({
  tone,
  children,
}: {
  tone: "warn" | "danger" | "info";
  children: ReactNode;
}) {
  return (
    <div className={tone === "info" ? "notice" : `notice ${tone}`} role={tone === "danger" ? "alert" : undefined}>
      {children}
    </div>
  );
}

export function Spinner() {
  return <span className="connector-spin" aria-hidden="true" />;
}

export function StepIcon({ state }: { state: "done" | "active" | "pending" }) {
  if (state === "done") {
    return (
      <span style={{ color: "var(--success)" }}>
        <CheckIcon />
      </span>
    );
  }
  if (state === "active") return <Spinner />;
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="12" cy="12" r="7" />
    </svg>
  );
}

export function SearchField({
  value,
  placeholder,
  invalid,
  describedBy,
  busy,
  inputRef,
  onChange,
  onSubmit,
  onCancel,
}: {
  value: string;
  placeholder: string;
  invalid?: boolean;
  describedBy?: string;
  busy?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <label className={invalid ? "connector-search invalid" : "connector-search"}>
      <SearchIcon />
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        aria-label="Search connectors"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onSubmit();
          }
          if (event.key === "Escape" && busy) {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      {busy ? <Spinner /> : null}
    </label>
  );
}
