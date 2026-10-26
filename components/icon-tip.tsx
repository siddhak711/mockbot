import type { ButtonHTMLAttributes, ReactNode } from "react";

export function IconTip({
  label,
  children,
  className,
  danger,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
  danger?: boolean;
}) {
  const classes = ["icon-btn", "tip", danger ? "danger" : "", className].filter(Boolean).join(" ");
  return (
    <button type="button" aria-label={label} {...props} className={classes}>
      {children}
      <span className="tip-bubble" aria-hidden="true">
        {label}
      </span>
    </button>
  );
}
