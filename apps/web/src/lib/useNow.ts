'use client';

import { useEffect, useState } from 'react';

/** A ticking clock for countdown bars. Respects reduced motion by ticking less often. */
export const useNow = (intervalMs = 250): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const prefersReducedMotion =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const id = window.setInterval(() => setNow(Date.now()), prefersReducedMotion ? 1000 : intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
};
