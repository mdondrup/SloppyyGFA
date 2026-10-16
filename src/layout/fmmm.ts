/*
 * Force-model primitives of OGDF's FMMM (fast multipole multilevel method) as configured by
 * BandageNG, shared by the Bézier-constrained finest level and the multilevel coarse levels.
 * Translated from C++ to TypeScript; see the "License and acknowledgements" section of the
 * README. Upstream: OGDF (GPL-2.0-or-later, FMMM © Stefan Hachul) and BandageNG
 * (GPL-3.0-or-later, © 2017 Ryan Wick, © 2022 Anton Korobeynikov).
 */

/** OGDF FMMM `forceScalingFactor`: displacement per unit of scaled force. */
export const FORCE_SCALING = 0.05;
/** Barnes-Hut opening angle. */
export const THETA = 0.9;
/** OGDF FMMM `prevent_oscillations`: allowed step growth per 30° of turn between successive moves. */
const OSCILLATION_FACTORS = [2, 2, 1.5, 1, 2 / 3, 0.5, 1 / 3];

/** FMMM attraction along an edge, per unit of the edge vector: `log2(d / l) * d^2 / l^3` divided by `d`. */
export function attraction(length: number, ideal: number): number {
  return (Math.log2(length / ideal) * length) / (ideal * ideal * ideal);
}

/**
 * FMMM oscillation damping: the factor (at most 1) to apply to a new move given the previous
 * one, limiting growth along a straight path and shrinking moves that reverse direction.
 */
export function dampingFactor(oldX: number, oldY: number, moveX: number, moveY: number): number {
  const oldNorm = Math.sqrt(oldX * oldX + oldY * oldY);
  const newNorm = Math.sqrt(moveX * moveX + moveY * moveY);
  if (oldNorm === 0 || newNorm === 0) return 1;
  const cosine = Math.max(-1, Math.min(1, (oldX * moveX + oldY * moveY) / (oldNorm * newNorm)));
  const bin = Math.min(OSCILLATION_FACTORS.length - 1, Math.ceil(Math.acos(cosine) / (Math.PI / 6)));
  return Math.min(1, (oldNorm * OSCILLATION_FACTORS[bin]!) / newNorm);
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
