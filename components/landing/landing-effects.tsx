"use client";

import { useEffect } from "react";

export function LandingEffects() {
  useEffect(() => {
    const nav = document.getElementById("daylight-nav");
    const onScroll = () => nav?.classList.toggle("stuck", window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    const reveal = document.querySelectorAll<HTMLElement>("[data-r]");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const frozen = reduced || window.location.search.includes("static");
    if (frozen) reveal.forEach((el) => el.classList.add("in"));

    let observer: IntersectionObserver | undefined;
    if (!frozen && typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            entry.target.classList.add("in");
            observer?.unobserve(entry.target);
          }
        },
        { threshold: 0.18 },
      );
      reveal.forEach((el) => observer?.observe(el));
    }

    return () => {
      window.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, []);

  return null;
}
