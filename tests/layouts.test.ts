import { describe, expect, it } from "vitest";

import { CURVE_STRIDE, curveTurn } from "../src/layout/curves";
import { computeLayout, CURVE_STIFFNESS, hubNeighbours, type LayoutAlgorithm } from "../src/layout/layouts";
import {
  buildPointGraph,
  edgeEndpoints,
  buildPointOffsets,
  LINK_LENGTH,
  POINT_SPACING,
  segmentDrawLength,
  segmentScale,
  type SegmentGraph,
} from "../src/layout/point-graph";
import type { GraphLayout } from "../src/model/graph";
import { depthWidthFactors } from "../src/render/webgl-renderer";

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

function point(layout: GraphLayout, index: number): [number, number] {
  return [layout.positions[index * 2]!, layout.positions[index * 2 + 1]!];
}

function distance(layout: GraphLayout, a: number, b: number): number {
  const [ax, ay] = point(layout, a);
  const [bx, by] = point(layout, b);
  return Math.hypot(ax - bx, ay - by);
}

function drawnLength(layout: GraphLayout, segment: number): number {
  let total = 0;
  for (let p = layout.pointOffsets[segment]!; p < layout.pointOffsets[segment + 1]! - 1; p += 1) {
    total += distance(layout, p, p + 1);
  }
  return total;
}

function segmentBox(layout: GraphLayout, segments: number[]) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const segment of segments) {
    for (let p = layout.pointOffsets[segment]!; p < layout.pointOffsets[segment + 1]!; p += 1) {
      xs.push(point(layout, p)[0]);
      ys.push(point(layout, p)[1]);
    }
  }
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

const ALL: LayoutAlgorithm[] = ["force", "radial", "hierarchical", "spiral"];

describe("point graph", () => {
  it("attaches oriented links to segment starts and ends", () => {
    const offsets = Uint32Array.from([0, 3, 5]);
    expect(edgeEndpoints(offsets, 0, 0, 1, 0)).toEqual([2, 3]); // A+ -> B+: A end, B start
    expect(edgeEndpoints(offsets, 0, 1, 1, 1)).toEqual([0, 4]); // A- -> B-: A start, B end
    expect(edgeEndpoints(offsets, 1, 0, 0, 1)).toEqual([4, 2]); // B+ -> A-: B end, A end
  });

  it("chains segment points, scales point count with length, and filters jumps", () => {
    const input = graph(
      [10, 1_000_000],
      [
        [0, "+", 1, "+"],
        [1, "+", 0, "+", "J"],
      ],
    );
    const withoutJumps = buildPointGraph(input, false);
    const withJumps = buildPointGraph(input, true);
    const shortPoints = withoutJumps.pointOffsets[1]! - withoutJumps.pointOffsets[0]!;
    const longPoints = withoutJumps.pointOffsets[2]! - withoutJumps.pointOffsets[1]!;
    expect(shortPoints).toBe(2);
    expect(longPoints).toBeGreaterThan(shortPoints);
    const chainEdges = withoutJumps.pointCount - 2;
    expect(withoutJumps.edgeA.length).toBe(chainEdges + 1);
    expect(withJumps.edgeA.length).toBe(chainEdges + 2);
  });
});

describe("Bandage geometry", () => {
  it("scales drawn length linearly to a mean of 40 units with a minimum of 5", () => {
    const lengths = Float64Array.from([1_000, 9_000, 10, 30_000]);
    const scale = segmentScale(lengths);
    expect(scale.factor).toBeCloseTo(500 / 40_010); // max(4 * 40, 500) units over 40,010 bp
    expect(segmentDrawLength(9_000, scale)).toBeCloseTo(9 * segmentDrawLength(1_000, scale));
    expect(segmentDrawLength(10, scale)).toBe(5);
    expect(segmentScale(Float64Array.from([100])).factor).toBeCloseTo(5);
  });

  it("optionally scales drawn length by log2 of the sequence length", () => {
    const lengths = Float64Array.from([1_023, 1_048_575, 10, 30_000]);
    const scale = segmentScale(lengths, "log2");
    const total = lengths.reduce((sum, bp) => sum + Math.log2(1 + bp), 0);
    expect(scale.factor).toBeCloseTo(500 / total);
    expect(segmentDrawLength(1_048_575, scale)).toBeCloseTo(2 * segmentDrawLength(1_023, scale));
    expect(segmentDrawLength(0, scale)).toBe(5);
    const graphPoints = buildPointGraph(graph(Array.from(lengths), []), false, "log2");
    expect(graphPoints.scale.mode).toBe("log2");
    expect(graphPoints.pointOffsets[2]! - graphPoints.pointOffsets[1]!).toBe(
      Math.ceil(segmentDrawLength(1_048_575, scale) / POINT_SPACING) + 1,
    );
  });

  it("splits segments into pieces of at most 20 units", () => {
    const lengths = Float64Array.from([1_000, 9_000, 10, 30_000]);
    const scale = segmentScale(lengths);
    const offsets = buildPointOffsets(lengths, scale);
    for (let segment = 0; segment < lengths.length; segment += 1) {
      const pieces = offsets[segment + 1]! - offsets[segment]! - 1;
      expect(pieces).toBe(Math.ceil(segmentDrawLength(lengths[segment]!, scale) / POINT_SPACING));
    }
  });

  it("widens segments with depth like Bandage and stays uniform without depth", () => {
    const factors = depthWidthFactors(Float64Array.from([100, 100, 100]), Float32Array.from([10, 40, 0]));
    const mean = 50 / 3;
    expect(factors[0]).toBeCloseTo((Math.sqrt(10 / mean) - 1) * 0.5 + 1);
    expect(factors[1]).toBeCloseTo((Math.sqrt(40 / mean) - 1) * 0.5 + 1);
    expect(factors[2]).toBeCloseTo(0.5);
    expect(Array.from(depthWidthFactors(Float64Array.from([1, 2]), new Float32Array(2)))).toEqual([1, 1]);
  });
});

describe("computeLayout", () => {
  it.each(ALL)("draws segments with length-proportional size (%s)", (algorithm) => {
    const layout = computeLayout(
      graph([100, 400_000, 5_000], [
        [0, "+", 1, "+"],
        [1, "+", 2, "-"],
      ]),
      { algorithm },
    );
    expect(Array.from(layout.positions).every(Number.isFinite)).toBe(true);
    const short = drawnLength(layout, 0);
    const long = drawnLength(layout, 1);
    expect(long).toBeGreaterThan(short * 5);
    if (algorithm !== "force") {
      const scale = segmentScale(Float64Array.from([100, 400_000, 5_000]));
      expect(long).toBeCloseTo(segmentDrawLength(400_000, scale), 0);
    }
  });

  it("keeps linked segment ends close in the force layout", () => {
    const edges: Edge[] = [];
    for (let segment = 0; segment < 20; segment += 1) {
      edges.push([segment, "+", (segment + 1) % 20, segment % 3 === 0 ? "-" : "+"]);
    }
    const input = graph(Array.from({ length: 20 }, (_, index) => 500 + index * 300), edges);
    const layout = computeLayout(input, { algorithm: "force" });
    for (let edge = 0; edge < edges.length; edge += 1) {
      const [from, to] = edgeEndpoints(
        layout.pointOffsets,
        input.edgeSources[edge]!,
        input.edgeSourceReverse[edge]!,
        input.edgeTargets[edge]!,
        input.edgeTargetReverse[edge]!,
      );
      expect(distance(layout, from, to)).toBeLessThan(LINK_LENGTH * 4);
    }
    const again = computeLayout(input, { algorithm: "force" });
    expect(Array.from(again.positions)).toEqual(Array.from(layout.positions));
  });

  it("lists distinct linked neighbours per segment, ignoring self-links", () => {
    const input = graph([50, 50, 50], [
      [0, "+", 1, "+"],
      [1, "-", 0, "-"],
      [0, "+", 2, "-"],
      [2, "+", 2, "+"],
    ]);
    const { offsets, neighbours } = hubNeighbours(buildPointGraph(input, true));
    const of = (segment: number) => Array.from(neighbours.subarray(offsets[segment]!, offsets[segment + 1]!)).sort();
    expect(of(0)).toEqual([1, 2]);
    expect(of(1)).toEqual([0]);
    expect(of(2)).toEqual([0]);
  });

  it("pulls highly connected hubs towards the centre of their tangle", () => {
    // A hub linked to every segment of a ring with long tails hanging off one side; averaged
    // over ring sizes because a single small tangle has several near-equal equilibria.
    const offset = (ring: number, hubWeighting: boolean) => {
      const lengths = [2000, ...Array.from({ length: ring }, () => 2000), ...Array.from({ length: 6 }, () => 8000)];
      const edges: Edge[] = [];
      for (let leaf = 1; leaf <= ring; leaf += 1) {
        edges.push([0, leaf % 2 ? "+" : "-", leaf, "+"]);
        edges.push([leaf, "+", (leaf % ring) + 1, "+"]);
      }
      for (let tail = 0; tail < 6; tail += 1) edges.push([1 + (tail % 3), "-", ring + 1 + tail, "+"]);
      const input = graph(lengths, edges);
      const layout = computeLayout(input, { algorithm: "force", hubWeighting });
      const centre = (segment: number) => {
        let x = 0;
        let y = 0;
        const begin = layout.pointOffsets[segment]!;
        const end = layout.pointOffsets[segment + 1]!;
        for (let p = begin; p < end; p += 1) [x, y] = [x + point(layout, p)[0], y + point(layout, p)[1]];
        return [x / (end - begin), y / (end - begin)] as const;
      };
      const leaves = Array.from({ length: ring }, (_, index) => centre(index + 1));
      const cx = leaves.reduce((sum, leaf) => sum + leaf[0], 0) / ring;
      const cy = leaves.reduce((sum, leaf) => sum + leaf[1], 0) / ring;
      const radius = leaves.reduce((sum, leaf) => sum + Math.hypot(leaf[0] - cx, leaf[1] - cy), 0) / ring;
      const [hx, hy] = centre(0);
      return Math.hypot(hx - cx, hy - cy) / radius;
    };
    const mean = (hubWeighting: boolean) =>
      [6, 8, 10, 12, 16].reduce((sum, ring) => sum + offset(ring, hubWeighting), 0) / 5;
    expect(mean(true)).toBeLessThan(mean(false) * 0.8);
  });

  it("reaches FMMM's equilibrium for two linked contigs, like BandageNG", () => {
    // BandageNG draws the same graph with pieces 1.15-1.5x their nominal length (FMMM pads
    // every ideal edge length by two node radii) and both contigs straight.
    const input = graph([100000, 100000], [[0, "+", 1, "+"]]);
    const points = buildPointGraph(input, false, "linear");
    const layout = computeLayout(input, { algorithm: "force" });
    const chainEdges = points.pointCount - 2;
    for (let edge = 0; edge < chainEdges; edge += 1) {
      const ratio = distance(layout, points.edgeA[edge]!, points.edgeB[edge]!) / points.edgeLength[edge]!;
      expect(ratio).toBeGreaterThan(1.05);
      expect(ratio).toBeLessThan(1.7);
    }
    const link = distance(layout, points.edgeA[chainEdges]!, points.edgeB[chainEdges]!);
    expect(link).toBeGreaterThan(LINK_LENGTH * 1.5);
    expect(link).toBeLessThan(LINK_LENGTH * 3.5);
    for (const segment of [0, 1]) {
      const [first, last] = [layout.pointOffsets[segment]!, layout.pointOffsets[segment + 1]! - 1];
      expect(distance(layout, first, last) / drawnLength(layout, segment)).toBeGreaterThan(0.95);
    }
  });

  it("places the requested root at the top of a hierarchical layout", () => {
    const input = graph([50, 50, 50], [
      [0, "+", 1, "+"],
      [1, "+", 2, "+"],
    ]);
    for (const root of [0, 2]) {
      const layout = computeLayout(input, { algorithm: "hierarchical", root });
      const other = root === 0 ? 2 : 0;
      expect(segmentBox(layout, [root]).maxY).toBeGreaterThan(segmentBox(layout, [1]).maxY);
      expect(segmentBox(layout, [1]).maxY).toBeGreaterThan(segmentBox(layout, [other]).maxY);
    }
  });

  it("places star leaves at equal distance from a radial hub", () => {
    const layout = computeLayout(
      graph([10, 10, 10, 10, 10], [
        [0, "+", 1, "+"],
        [2, "+", 0, "+"],
        [0, "+", 3, "+"],
        [4, "+", 0, "+"],
      ]),
      { algorithm: "radial", root: 0 },
    );
    const hubStart = layout.pointOffsets[0]!;
    const leafTips = [1, 3].map((segment) => layout.pointOffsets[segment + 1]! - 1);
    const distances = leafTips.map((tip) => distance(layout, hubStart, tip));
    expect(distances[0]).toBeCloseTo(distances[1]!, 3);
    const otherTips = [2, 4].map((segment) => layout.pointOffsets[segment]!);
    const others = otherTips.map((tip) => distance(layout, hubStart, tip));
    expect(others[0]).toBeCloseTo(others[1]!, 3);
  });

  it.each<LayoutAlgorithm>(["force", "radial", "hierarchical"])(
    "separates connected components and honours the jump setting (%s)",
    (algorithm) => {
      const input = graph([200, 200, 200, 200], [
        [0, "+", 1, "+"],
        [2, "+", 3, "+"],
        [1, "+", 2, "+", "J"],
      ]);
      const layout = computeLayout(input, { algorithm });
      const a = segmentBox(layout, [0, 1]);
      const b = segmentBox(layout, [2, 3]);
      const overlaps = a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
      expect(overlaps).toBe(false);

      const joined = computeLayout(input, { algorithm, includeJumps: true });
      const [from, to] = edgeEndpoints(joined.pointOffsets, 1, 0, 2, 0);
      expect(distance(joined, from, to)).toBeLessThan(LINK_LENGTH * 4);
    },
  );

  it.each(ALL)("handles cycles, self-loops, duplicates, and isolated segments (%s)", (algorithm) => {
    const layout = computeLayout(
      graph([5, 50, 500, 0, 7], [
        [0, "+", 1, "+"],
        [1, "+", 2, "-"],
        [2, "-", 0, "+"],
        [2, "+", 2, "-"],
        [0, "+", 1, "+"],
      ]),
      { algorithm },
    );
    expect(layout.pointOffsets).toHaveLength(6);
    expect(Array.from(layout.positions).every(Number.isFinite)).toBe(true);
  });

  it("lays force components out flat at their natural size, independent of any viewport", () => {
    const chainOf = (count: number) => {
      const edges: Edge[] = [];
      for (let segment = 0; segment < count * 10; segment += 1) {
        if (segment % 10 !== 9) edges.push([segment, "+", segment + 1, "+"]);
      }
      return graph(new Array(count * 10).fill(1_000), edges);
    };
    // Two copies, so the automatic length scale (Bandage's 40 units per segment) matches below.
    const single = computeLayout(chainOf(2), { algorithm: "force" });
    const singleBox = segmentBox(single, [...Array(10).keys()]);
    expect(singleBox.maxX - singleBox.minX).toBeGreaterThan((singleBox.maxY - singleBox.minY) * 4);
    const singleLength = [...Array(10).keys()].reduce((sum, segment) => sum + drawnLength(single, segment), 0);

    // Many copies are packed into a roughly square drawing without shrinking any of them.
    const layout = computeLayout(chainOf(16), { algorithm: "force" });
    const all = segmentBox(layout, [...Array(160).keys()]);
    const ratio = (all.maxX - all.minX) / (all.maxY - all.minY);
    expect(ratio).toBeGreaterThan(1 / 3);
    expect(ratio).toBeLessThan(3);
    for (const copy of [0, 7, 15]) {
      const length = [...Array(10).keys()].reduce((sum, index) => sum + drawnLength(layout, copy * 10 + index), 0);
      expect(length / singleLength).toBeGreaterThan(0.9);
      expect(length / singleLength).toBeLessThan(1.1);
    }
  });

  it.each(ALL)("samples every segment's quadratic Bézier curve (%s)", (algorithm) => {
    const input = graph([5, 5000, 20000, 800, 3000], [
      [0, "+", 1, "+"],
      [1, "+", 2, "-"],
      [2, "-", 3, "+"],
      [3, "+", 1, "+"],
      [4, "+", 4, "-"],
    ]);
    const layout = computeLayout(input, { algorithm });
    expect(layout.curves).toHaveLength(5 * CURVE_STRIDE);
    for (let segment = 0; segment < 5; segment += 1) {
      const begin = layout.pointOffsets[segment]!;
      const pieces = layout.pointOffsets[segment + 1]! - 1 - begin;
      const c = Array.from(layout.curves.subarray(segment * CURVE_STRIDE, (segment + 1) * CURVE_STRIDE));
      for (let k = 0; k <= pieces; k += 1) {
        const t = k / pieces;
        const [x, y] = [
          (1 - t) ** 2 * c[0]! + 2 * t * (1 - t) * c[2]! + t * t * c[4]!,
          (1 - t) ** 2 * c[1]! + 2 * t * (1 - t) * c[3]! + t * t * c[5]!,
        ];
        expect(point(layout, begin + k)[0]).toBeCloseTo(x, 1);
        expect(point(layout, begin + k)[1]).toBeCloseTo(y, 1);
      }
    }
  });

  it("keeps linear stretches straight and penalises bent segments by the curve stiffness", () => {
    const chain = computeLayout(graph(new Array(6).fill(5000), [0, 1, 2, 3, 4].map((s) => [s, "+", s + 1, "+"])), {
      algorithm: "force",
    });
    for (let segment = 0; segment < 6; segment += 1) expect(curveTurn(chain.curves, segment)).toBeLessThan(0.02);

    // A tangle: a ring of long segments with chords that force some of them to bend.
    const edges: Edge[] = [];
    for (let segment = 0; segment < 8; segment += 1) edges.push([segment, "+", (segment + 1) % 8, "+"]);
    for (let segment = 0; segment < 8; segment += 2) edges.push([segment, "+", (segment + 3) % 8, "-"]);
    const tangle = graph(Array.from({ length: 8 }, (_, index) => 3000 + 1000 * index), edges);
    const totalTurn = (curveStiffness: number) => {
      const layout = computeLayout(tangle, { algorithm: "force", curveStiffness });
      return [...Array(8).keys()].reduce((sum, segment) => sum + curveTurn(layout.curves, segment), 0);
    };
    const stiffness = (id: string) => CURVE_STIFFNESS.find((option) => option.id === id)!.value;
    const turns = ["flexible", "balanced", "stiff"].map((id) => totalTurn(stiffness(id)));
    expect(turns[0]).toBeGreaterThan(turns[1]! * 1.5);
    expect(turns[1]).toBeGreaterThan(turns[2]! * 1.5);
    expect(totalTurn(stiffness("straight"))).toBeLessThan(1e-4);
  });

  it("handles empty graphs and rejects invalid input", () => {
    expect(computeLayout(graph([], []), { algorithm: "force" }).positions).toHaveLength(0);
    expect(() => computeLayout(graph([1, 1], [[0, "+", 2, "+"]]), { algorithm: "radial" })).toThrow(
      RangeError,
    );
    expect(() => computeLayout(graph([1, 1], []), { algorithm: "radial", root: 2 })).toThrow(
      RangeError,
    );
  });
});
