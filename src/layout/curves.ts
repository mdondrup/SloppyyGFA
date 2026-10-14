import { LINK_LENGTH } from "./point-graph";

/**
 * Segments are drawn as quadratic Bézier curves. `curves` stores six numbers per segment:
 * start (x0, y0), handle (x1, y1) and end (x2, y2). A handle at the chord midpoint is a
 * straight segment.
 */
export const CURVE_STRIDE = 6;

/** Tessellated curves: points of segment `i` are `offsets[i]` to `offsets[i + 1] - 1`. */
export interface Tessellation {
  readonly offsets: Uint32Array;
  readonly points: Float32Array;
}

/** Largest turn of the tangent within one drawn piece. */
const MAX_TURN_PER_PIECE = (4 * Math.PI) / 180;
/** Largest gap, in world units, between a drawn piece and the true curve. */
const MAX_SAGITTA = 0.25;
const MAX_PIECES = 64;
/** Turns below this are drawn as one straight piece. */
const STRAIGHT_TURN = 1e-3;
/** Pieces per drawn link curve that is not straight. */
export const LINK_CURVE_PIECES = 12;

/**
 * Fits each segment's quadratic Bézier to its layout points (sampled at `t = k / pieces`)
 * with the ends fixed, and moves interior points onto the fitted curve, so `positions`
 * always sample `curves`. Exact for the force layout, whose segments are such curves.
 */
export function fitSegmentCurves(positions: Float32Array, pointOffsets: Uint32Array): Float32Array {
  const segmentCount = pointOffsets.length - 1;
  const curves = new Float32Array(segmentCount * CURVE_STRIDE);
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const first = pointOffsets[segment]!;
    const last = pointOffsets[segment + 1]! - 1;
    const pieces = last - first;
    const x0 = positions[first * 2]!;
    const y0 = positions[first * 2 + 1]!;
    const x2 = positions[last * 2]!;
    const y2 = positions[last * 2 + 1]!;
    let hx = 0;
    let hy = 0;
    if (pieces >= 2) {
      let sumX = 0;
      let sumY = 0;
      let norm = 0;
      for (let k = 1; k < pieces; k += 1) {
        const t = k / pieces;
        const bump = 2 * t * (1 - t);
        const point = first + k;
        sumX += bump * (positions[point * 2]! - (1 - t) * x0 - t * x2);
        sumY += bump * (positions[point * 2 + 1]! - (1 - t) * y0 - t * y2);
        norm += bump * bump;
      }
      hx = sumX / norm;
      hy = sumY / norm;
      for (let k = 1; k < pieces; k += 1) {
        const t = k / pieces;
        const bump = 2 * t * (1 - t);
        const point = first + k;
        positions[point * 2] = (1 - t) * x0 + t * x2 + bump * hx;
        positions[point * 2 + 1] = (1 - t) * y0 + t * y2 + bump * hy;
      }
    }
    const base = segment * CURVE_STRIDE;
    curves[base] = x0;
    curves[base + 1] = y0;
    curves[base + 2] = (x0 + x2) / 2 + hx;
    curves[base + 3] = (y0 + y2) / 2 + hy;
    curves[base + 4] = x2;
    curves[base + 5] = y2;
  }
  return curves;
}

/** Total turn of a segment's tangent from start to end, in radians (0 when straight). */
export function curveTurn(curves: ArrayLike<number>, segment: number): number {
  const base = segment * CURVE_STRIDE;
  const ux = curves[base + 2]! - curves[base]!;
  const uy = curves[base + 3]! - curves[base + 1]!;
  const vx = curves[base + 4]! - curves[base + 2]!;
  const vy = curves[base + 5]! - curves[base + 3]!;
  if ((ux === 0 && uy === 0) || (vx === 0 && vy === 0)) return 0;
  return Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy));
}

/** Number of straight pieces needed to draw a segment's curve smoothly. */
export function curvePieces(curves: ArrayLike<number>, segment: number): number {
  const turn = curveTurn(curves, segment);
  if (turn < STRAIGHT_TURN) return 1;
  const base = segment * CURVE_STRIDE;
  const length =
    Math.hypot(curves[base + 2]! - curves[base]!, curves[base + 3]! - curves[base + 1]!) +
    Math.hypot(curves[base + 4]! - curves[base + 2]!, curves[base + 5]! - curves[base + 3]!);
  return Math.min(
    MAX_PIECES,
    Math.max(2, Math.ceil(turn / MAX_TURN_PER_PIECE), Math.ceil(Math.sqrt((length * turn) / (8 * MAX_SAGITTA)))),
  );
}

/** Adaptive polyline approximation of every segment curve: straight segments get one piece. */
export function tessellateCurves(curves: Float32Array): Tessellation {
  const segmentCount = curves.length / CURVE_STRIDE;
  const offsets = new Uint32Array(segmentCount + 1);
  for (let segment = 0; segment < segmentCount; segment += 1) {
    offsets[segment + 1] = offsets[segment]! + curvePieces(curves, segment) + 1;
  }
  const points = new Float32Array(offsets[segmentCount]! * 2);
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const base = segment * CURVE_STRIDE;
    const first = offsets[segment]!;
    const pieces = offsets[segment + 1]! - first - 1;
    for (let k = 0; k <= pieces; k += 1) {
      const t = k / pieces;
      const a = (1 - t) * (1 - t);
      const b = 2 * t * (1 - t);
      const c = t * t;
      points[(first + k) * 2] = a * curves[base]! + b * curves[base + 2]! + c * curves[base + 4]!;
      points[(first + k) * 2 + 1] = a * curves[base + 1]! + b * curves[base + 3]! + c * curves[base + 5]!;
    }
  }
  return { offsets, points };
}

/**
 * Cubic Bézier controls of a link drawn as in Bandage: it leaves the source's exit end along
 * the segment's tangent and enters the target's entry end along its tangent, with control
 * arms `min(LINK_LENGTH, distance / 2)` long. Links from a segment to itself become loops.
 * Writes (x, y) of start, control 1, control 2 and end into `out`.
 */
export function linkControls(
  curves: ArrayLike<number>,
  source: number,
  sourceReverse: number,
  target: number,
  targetReverse: number,
  out: Float64Array,
): Float64Array {
  const s = source * CURVE_STRIDE;
  const t = target * CURVE_STRIDE;
  // Leaving A+ from its end along P2 - P1; leaving A- from its start along P0 - P1.
  const fromX = curves[s + (sourceReverse ? 0 : 4)]!;
  const fromY = curves[s + (sourceReverse ? 1 : 5)]!;
  let exitX = fromX - curves[s + 2]!;
  let exitY = fromY - curves[s + 3]!;
  // Entering B+ at its start or B- at its end; the arm points out of the segment there
  // (P0 - P1 or P2 - P1), so the link arrives along the segment's tangent.
  const toX = curves[t + (targetReverse ? 4 : 0)]!;
  const toY = curves[t + (targetReverse ? 5 : 1)]!;
  let backX = toX - curves[t + 2]!;
  let backY = toY - curves[t + 3]!;
  const exitNorm = Math.hypot(exitX, exitY) || 1;
  const backNorm = Math.hypot(backX, backY) || 1;
  exitX /= exitNorm;
  exitY /= exitNorm;
  backX /= backNorm;
  backY /= backNorm;
  const distance = Math.hypot(toX - fromX, toY - fromY);

  let arm = Math.min(LINK_LENGTH, distance / 2);
  let side1 = 0;
  let side2 = 0;
  if (source === target) {
    arm = 2 * LINK_LENGTH;
    if (sourceReverse === targetReverse) {
      // End back to start: bulge around the side away from the segment's handle.
      const handleSide =
        -exitY * (curves[s + 2]! - (curves[s]! + curves[s + 4]!) / 2) +
        exitX * (curves[s + 3]! - (curves[s + 1]! + curves[s + 5]!) / 2);
      const bulge = distance / 2 + 2 * LINK_LENGTH;
      side1 = handleSide > 0 ? -bulge : bulge;
      side2 = side1;
    } else {
      // A hairpin at one end: a small teardrop loop.
      side1 = LINK_LENGTH;
      side2 = -LINK_LENGTH;
    }
  }
  // Sideways offsets are along the exit normal (-exitY, exitX).
  out[0] = fromX;
  out[1] = fromY;
  out[2] = fromX + exitX * arm - exitY * side1;
  out[3] = fromY + exitY * arm + exitX * side1;
  out[4] = toX + backX * arm - exitY * side2;
  out[5] = toY + backY * arm + exitX * side2;
  out[6] = toX;
  out[7] = toY;
  return out;
}

/** True when a link's cubic is (nearly) a straight line between its ends. */
export function isStraightLink(controls: ArrayLike<number>): boolean {
  const dx = controls[6]! - controls[0]!;
  const dy = controls[7]! - controls[1]!;
  const length = Math.hypot(dx, dy);
  if (length === 0) return false;
  const offset1 = Math.abs((controls[2]! - controls[0]!) * dy - (controls[3]! - controls[1]!) * dx) / length;
  const offset2 = Math.abs((controls[4]! - controls[0]!) * dy - (controls[5]! - controls[1]!) * dx) / length;
  return Math.max(offset1, offset2) < MAX_SAGITTA;
}

/** Point of a cubic Bézier given as (x, y) of start, two controls and end. */
export function cubicPoint(controls: ArrayLike<number>, t: number, out: Float64Array): Float64Array {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  out[0] = a * controls[0]! + b * controls[2]! + c * controls[4]! + d * controls[6]!;
  out[1] = a * controls[1]! + b * controls[3]! + c * controls[5]! + d * controls[7]!;
  return out;
}
