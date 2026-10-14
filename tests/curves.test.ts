import { describe, expect, it } from "vitest";

import {
  CURVE_STRIDE,
  cubicPoint,
  curvePieces,
  fitSegmentCurves,
  isStraightLink,
  linkControls,
  tessellateCurves,
} from "../src/layout/curves";
import { LINK_LENGTH } from "../src/layout/point-graph";

type Vec = [number, number];

function quadratic(p0: Vec, p1: Vec, p2: Vec, t: number): Vec {
  const u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]];
}

/** Layout positions sampling the given curves at `t = k / pieces`. */
function sampled(curves: [Vec, Vec, Vec][], pieces: number[]) {
  const offsets = new Uint32Array(curves.length + 1);
  pieces.forEach((count, index) => (offsets[index + 1] = offsets[index]! + count + 1));
  const positions = new Float32Array(offsets[curves.length]! * 2);
  curves.forEach(([p0, p1, p2], segment) => {
    for (let k = 0; k <= pieces[segment]!; k += 1) {
      const [x, y] = quadratic(p0, p1, p2, k / pieces[segment]!);
      positions[(offsets[segment]! + k) * 2] = x;
      positions[(offsets[segment]! + k) * 2 + 1] = y;
    }
  });
  return { offsets, positions };
}

function curveArray(...curves: [Vec, Vec, Vec][]): Float32Array {
  return Float32Array.from(curves.flatMap(([a, b, c]) => [...a, ...b, ...c]));
}

describe("segment curves", () => {
  it("recovers the quadratic Bézier sampled by layout points", () => {
    const bent: [Vec, Vec, Vec] = [[0, 0], [50, 40], [100, 0]];
    const straight: [Vec, Vec, Vec] = [[0, 10], [5, 10], [10, 10]];
    const { offsets, positions } = sampled([bent, straight], [5, 1]);
    const before = positions.slice();
    const curves = fitSegmentCurves(positions, offsets);
    expect(curves).toHaveLength(2 * CURVE_STRIDE);
    const expected = [...bent.flat(), ...straight.flat()];
    expected.forEach((value, index) => expect(curves[index]).toBeCloseTo(value, 3));
    positions.forEach((value, index) => expect(value).toBeCloseTo(before[index]!, 3));
  });

  it("moves interior points onto the least-squares curve with fixed ends", () => {
    const offsets = Uint32Array.from([0, 5]);
    const positions = Float32Array.from([0, 0, 10, 5, 20, -3, 30, 8, 40, 0]);
    const curves = fitSegmentCurves(positions, offsets);
    const p0: Vec = [curves[0]!, curves[1]!];
    const p1: Vec = [curves[2]!, curves[3]!];
    const p2: Vec = [curves[4]!, curves[5]!];
    expect(p0).toEqual([0, 0]);
    expect(p2).toEqual([40, 0]);
    for (let k = 0; k <= 4; k += 1) {
      const [x, y] = quadratic(p0, p1, p2, k / 4);
      expect(positions[k * 2]).toBeCloseTo(x, 4);
      expect(positions[k * 2 + 1]).toBeCloseTo(y, 4);
    }
  });

  it("tessellates straight segments as one piece and bent ones adaptively", () => {
    const curves = curveArray(
      [[0, 0], [50, 0], [100, 0]],
      [[0, 0], [50, 10], [100, 0]],
      [[0, 0], [50, 100], [100, 0]],
    );
    expect(curvePieces(curves, 0)).toBe(1);
    expect(curvePieces(curves, 1)).toBeGreaterThan(1);
    expect(curvePieces(curves, 2)).toBeGreaterThan(curvePieces(curves, 1));
    const { offsets, points } = tessellateCurves(curves);
    expect(offsets[1]! - offsets[0]!).toBe(2);
    for (let segment = 0; segment < 3; segment += 1) {
      const first = offsets[segment]!;
      const last = offsets[segment + 1]! - 1;
      expect([points[first * 2], points[first * 2 + 1]]).toEqual([0, 0]);
      expect([points[last * 2], points[last * 2 + 1]]).toEqual([100, 0]);
    }
    // Every drawn vertex lies on the curve.
    const first = offsets[2]!;
    const pieces = offsets[3]! - first - 1;
    for (let k = 0; k <= pieces; k += 1) {
      const [x, y] = quadratic([0, 0], [50, 100], [100, 0], k / pieces);
      expect(points[(first + k) * 2]).toBeCloseTo(x, 3);
      expect(points[(first + k) * 2 + 1]).toBeCloseTo(y, 3);
    }
  });
});

describe("link curves", () => {
  const out = new Float64Array(8);
  // Segment 0 runs left to right ending at x = 100, segment 1 starts at x = 120.
  const curves = curveArray(
    [[0, 0], [50, 0], [100, 0]],
    [[120, 0], [170, 0], [220, 0]],
    [[100, 50], [50, 50], [0, 50]],
  );

  it("leaves and enters segments along their tangents", () => {
    const forward = Array.from(linkControls(curves, 0, 0, 1, 0, out));
    expect(forward).toEqual([100, 0, 100 + LINK_LENGTH, 0, 120 - LINK_LENGTH, 0, 120, 0]);
    expect(isStraightLink(forward)).toBe(true);

    // 1- leaves from its start (x = 120) towards -x; 0- enters at its end (x = 100) from +x.
    const reverse = Array.from(linkControls(curves, 1, 1, 0, 1, out));
    expect(reverse).toEqual([120, 0, 120 - LINK_LENGTH, 0, 100 + LINK_LENGTH, 0, 100, 0]);
  });

  it("bends links whose ends point away from each other", () => {
    // 0+ leaves at (100, 0) heading +x; 2+ starts at (100, 50) heading -x.
    const controls = linkControls(curves, 0, 0, 2, 0, out);
    expect([controls[2], controls[3]]).toEqual([100 + LINK_LENGTH, 0]);
    expect([controls[4], controls[5]]).toEqual([100 + LINK_LENGTH, 50]);
    expect(isStraightLink(controls)).toBe(false);
  });

  it("draws self-links as visible loops", () => {
    for (const reverse of [0, 1]) {
      const controls = Array.from(linkControls(curves, 0, 0, 0, reverse, out));
      const middle = cubicPoint(controls, 0.5, new Float64Array(2));
      const [fromX, fromY] = [controls[0]!, controls[1]!];
      expect(Math.hypot(middle[0]! - fromX, middle[1]! - fromY)).toBeGreaterThan(LINK_LENGTH);
      expect(isStraightLink(controls)).toBe(false);
    }
  });

  it("evaluates cubic Bézier points", () => {
    const controls = [0, 0, 1, 2, 3, 2, 4, 0];
    expect(Array.from(cubicPoint(controls, 0, new Float64Array(2)))).toEqual([0, 0]);
    expect(Array.from(cubicPoint(controls, 1, new Float64Array(2)))).toEqual([4, 0]);
    expect(Array.from(cubicPoint(controls, 0.5, new Float64Array(2)))).toEqual([2, 1.5]);
  });
});
