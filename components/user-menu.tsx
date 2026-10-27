"use client";

import { useEffect, useId, useRef, useState } from "react";
import { signOutAction } from "../src/auth/actions";
import type { SignedInUser } from "../src/auth/user";

export function UserMenu({ user, detail }: { user: SignedInUser; detail?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const label = user.name?.trim() || user.email;
  const initial = label.charAt(0).toUpperCase() || "?";

  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="user-menu" ref={root}>
      <button
        type="button"
        className="me-identity user-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((current) => !current)}
      >
        {user.image ? (
          <img className="ava ava-img" src={user.image} alt="" referrerPolicy="no-referrer" />
        ) : (
          <span className="ava" aria-hidden="true">
            {initial}
          </span>
        )}
        <span className="me-copy">
          <span className="me-name">{label}</span>
        </span>
      </button>
      {open ? (
        <div className="menu user-pop" id={menuId} role="menu" aria-label="Account">
          <div className="user-pop-info">
            <span className="me-meta">{user.email}</span>
            {detail ? <span className="me-model">{detail}</span> : null}
          </div>
          <form action={signOutAction}>
            <button type="submit" role="menuitem">
              Log out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
