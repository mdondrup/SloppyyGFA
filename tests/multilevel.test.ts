import { describe, expect, it } from "vitest";

import { mulberry32 } from "../src/layout/fmmm";
import { computeLayout, type ForceStart } from "../src/layout/layouts";
import { coarsen, type Level } from "../src/layout/multilevel";
import { openEndPoints } from "../src/layout/open-ends";
import type { SegmentGraph } from "../src/layout/point-graph";
import type { GraphLayout } from "../src/model/graph";

type Edge = [source: number, sourceStrand: "+" | "-", target: number, targetStrand: "+" | "-", kind?: "L" | "J"];

function graph(lengths: number[], edges: Edge[]): SegmentGraph {
  return {
    lengths: Float64Array.from(lengths),
    edgeSources: Uint32Array.from(edges.map((edge) => edge[0])),
    edgeSourceReverse: Uint8Array.from(edges.map((edge) => (edge[1] === "-" ? 1 : 0))),
    edgeTargets: Uint32Array.from(edges.map((edge) => edge[2])),
    edgeTargetReverse: Uint8Array.from(edges.map((edge) => (edge[3] === "-" ? 1 : 0))),
    edgeKinds: Uint8Array.from(edges.map((edge) => (edge[4] === "J" ? 1 : 0))),
  };
}

function chain(count: number, length: number): SegmentGraph {
  return graph(
    new Array(count).fill(length),
    Array.from({ length: count - 1 }, (_, segment): Edge => [segment, "+", segment + 1, "+"]),
  );
}

function point(layout: GraphLayout, index: number): [number, number] {
  return [layout.positions[index * 2]!, layout.positions[index * 2 + 1]!];
}

/** End-to-end distance of a chain drawing over its drawn length (1 for a straight line). */
function spanOverArc(layout: GraphLayout): number {
  const last = layout.pointOffsets[layout.pointOffsets.length - 1]! - 1;
  let arc = 0;
  for (let p = 0; p < last; p += 1) {
    const [ax, ay] = point(layout, p);
    const [bx, by] = point(layout, p + 1);
    arc += Math.hypot(bx - ax, by - ay);
  }
  const [ax, ay] = point(layout, 0);
  const [bx, by] = point(layout, last);
  return Math.hypot(bx - ax, by - ay) / arc;
}

function segmentBox(layout: GraphLayout, segments: number[]) {
  let minX = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const segment of segments) {
    for (let p = layout.pointOffsets[segment]!; p < layout.pointOffsets[segment + 1]!; p += 1) {
      const [x, y] = point(layout, p);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { minX, maxX, maxY };
}

describe("FMMM multilevel start", () => {
  it("coarsens a connected graph to at most half its nodes and keeps its mass", () => {
    const n = 100;
    const level: Level = {
      n,
      edgeA: Uint32Array.from({ length: n - 1 }, (_, index) => index),
      edgeB: Uint32Array.from({ length: n - 1 }, (_, index) => index + 1),
      ideal: new Float64Array(n - 1).fill(1),
      mass: new Float64Array(n).fill(1),
    };
    const { coarse, merge } = coarsen(level, mulberry32(1));
    expect(coarse.n).toBeGreaterThan(1);
    expect(coarse.n).toBeLessThanOrEqual(n / 2);
    expect(coarse.mass.reduce((sum, mass) => sum + mass, 0)).toBeCloseTo(n);
    expect(Math.max(...merge.sunOf)).toBe(coarse.n - 1);
  });

  it("is deterministic and finite for both multilevel starts", () => {
    const input = graph([3000, 800, 5000, 1200, 400, 9000], [
      [0, "+", 1, "+"],
      [1, "+", 2, "-"],
      [2, "-", 3, "+"],
      [3, "+", 1, "+"],
      [3, "+", 4, "+"],
      [4, "+", 5, "-"],
    ]);
    for (const forceStart of ["multilevel", "multilevel-random"] as ForceStart[]) {
      const first = computeLayout(input, { algorithm: "force", forceStart });
      const second = computeLayout(input, { algorithm: "force", forceStart });
      expect(Array.from(first.positions).every(Number.isFinite)).toBe(true);
      expect(Array.from(second.positions)).toEqual(Array.from(first.positions));
    }
  });

  it("keeps long chains straight when the coarsest level is seeded from the tree layout", () => {
    for (const [count, length] of [
      [40, 1000],
      [100, 300],
    ]) {
      const layout = computeLayout(chain(count!, length!), { algorithm: "force", forceStart: "multilevel" });
      expect(spanOverArc(layout)).toBeGreaterThan(0.95);
    }
  });
});

describe("open-end repulsion", () => {
  it("flags segment ends without L links and ignores J links", () => {
    const input = graph([10, 10, 10], [
      [0, "+", 1, "+"],
      [1, "+", 2, "+", "J"],
    ]);
    const offsets = Uint32Array.from([0, 2, 4, 6]);
    expect(Array.from(openEndPoints(input, offsets))).toEqual([1, 0, 0, 1, 1, 1]);

    // Reverse strands link a segment's start (5') instead of its end.
    const reversed = graph([10, 10], [[0, "-", 1, "-"]]);
    expect(Array.from(openEndPoints(reversed, Uint32Array.from([0, 3, 5])))).toEqual([0, 0, 1, 1, 0]);
  });

  it("pushes the open ends of a folded chain apart", () => {
    const input = chain(40, 1000);
    const span = (openEndRepulsion: number) =>
      spanOverArc(computeLayout(input, { algorithm: "force", forceStart: "multilevel-random", openEndRepulsion }));
    const off = span(0);
    const strong = span(3);
    expect(strong).toBeGreaterThan(off * 1.3);
  });
});

describe("component packing", () => {
  it("places the component with the most sequence first, at the top left", () => {
    // Component A: 30 short segments (more points, 30 kbp). Component B: one 50 kbp segment.
    const edges = Array.from({ length: 29 }, (_, segment): Edge => [segment, "+", segment + 1, "+"]);
    const input = graph([...new Array(30).fill(1000), 50_000], edges);
    const layout = computeLayout(input, { algorithm: "force" });
    expect(layout.pointOffsets[30]! - layout.pointOffsets[0]!).toBeGreaterThan(
      layout.pointOffsets[31]! - layout.pointOffsets[30]!,
    );
    const a = segmentBox(layout, [...Array(30).keys()]);
    const b = segmentBox(layout, [30]);
    expect(b.minX).toBeLessThanOrEqual(a.minX + 1e-3);
    expect(b.maxY).toBeGreaterThanOrEqual(a.maxY - 1e-3);
    expect(b.maxX < a.minX || b.maxY > a.maxY).toBe(true);
  });
});
