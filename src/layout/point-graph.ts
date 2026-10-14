/** Segment-level graph input shared by the layout worker and the renderer. */
export interface SegmentGraph {
  readonly lengths: Float64Array;
  readonly edgeSources: Uint32Array;
  readonly edgeTargets: Uint32Array;
  readonly edgeSourceReverse: Uint8Array;
  readonly edgeTargetReverse: Uint8Array;
  readonly edgeKinds: Uint8Array;
}

/** Layout graph in which every segment is a chain of points from its start (5') to its end (3'). */
export interface PointGraph {
  readonly pointCount: number;
  readonly pointOffsets: Uint32Array;
  readonly segmentOf: Uint32Array;
  readonly edgeA: Uint32Array;
  readonly edgeB: Uint32Array;
  readonly edgeLength: Float64Array;
  /** Mapping from base pairs to drawn segment length. */
  readonly scale: SegmentScale;
}

/** `linear` is Bandage's default; `log2` compresses long contigs. */
export type LengthScale = "linear" | "log2";

export const LENGTH_SCALES: ReadonlyArray<{ readonly id: LengthScale; readonly label: string }> = [
  { id: "linear", label: "Linear (Bandage)" },
  { id: "log2", label: "Log2" },
];

export interface SegmentScale {
  readonly mode: LengthScale;
  /** Drawn units per scaled base-pair unit (bp for linear, log2(1 + bp) for log2). */
  readonly factor: number;
}

/*
 * Geometry defaults from BandageNG (program/settings.cpp, layout/graphlayoutworker.cpp):
 * drawn length is linear in base pairs and auto-scaled so the mean segment is about
 * `MEAN_SEGMENT_LENGTH` units, segments are split into pieces of at most
 * `POINT_SPACING` units, and links have rest length `LINK_LENGTH`.
 */
/** `meanNodeLength` */
export const MEAN_SEGMENT_LENGTH = 40;
/** `minTotalGraphLength` */
export const MIN_TOTAL_GRAPH_LENGTH = 500;
/** `minimumNodeLength` */
export const MIN_SEGMENT_LENGTH = 5;
/** `nodeSegmentLength` */
export const POINT_SPACING = 20;
/** `edgeLength` */
export const LINK_LENGTH = 5;

function scaledBases(basePairs: number, mode: LengthScale): number {
  const bp = Math.max(0, basePairs);
  return mode === "log2" ? Math.log2(1 + bp) : bp;
}

/**
 * Auto-scaled length mapping, as Bandage's automatic "node length per megabase": the
 * graph's total drawn length is `max(segments * 40, 500)` units. In log2 mode the same
 * total is spread over `log2(1 + bp)` instead of `bp`.
 */
export function segmentScale(lengths: ArrayLike<number>, mode: LengthScale = "linear"): SegmentScale {
  let total = 0;
  for (let segment = 0; segment < lengths.length; segment += 1) total += scaledBases(lengths[segment]!, mode);
  const target = Math.max(lengths.length * MEAN_SEGMENT_LENGTH, MIN_TOTAL_GRAPH_LENGTH);
  return { mode, factor: total > 0 ? target / total : 0.01 };
}

/** Drawn segment length in world units (at least `MIN_SEGMENT_LENGTH`). */
export function segmentDrawLength(basePairs: number, scale: SegmentScale): number {
  return Math.max(MIN_SEGMENT_LENGTH, scaledBases(basePairs, scale.mode) * scale.factor);
}

/** Point ranges per segment: `ceil(drawnLength / POINT_SPACING)` pieces, as in Bandage. */
export function buildPointOffsets(lengths: Float64Array, scale = segmentScale(lengths)): Uint32Array {
  const offsets = new Uint32Array(lengths.length + 1);
  for (let segment = 0; segment < lengths.length; segment += 1) {
    const pieces = Math.max(1, Math.ceil(segmentDrawLength(lengths[segment]!, scale) / POINT_SPACING));
    offsets[segment + 1] = offsets[segment]! + pieces + 1;
  }
  return offsets;
}

/**
 * Point where an oriented edge leaves `source` and enters `target`.
 * Leaving `A+` uses A's end; leaving `A-` uses its start. Entering `B+` uses B's start;
 * entering `B-` uses its end.
 */
export function edgeEndpoints(
  pointOffsets: Uint32Array,
  source: number,
  sourceReverse: number,
  target: number,
  targetReverse: number,
): [number, number] {
  const from = sourceReverse ? pointOffsets[source]! : pointOffsets[source + 1]! - 1;
  const to = targetReverse ? pointOffsets[target + 1]! - 1 : pointOffsets[target]!;
  return [from, to];
}

export function buildPointGraph(
  graph: SegmentGraph,
  includeJumps: boolean,
  lengthScale: LengthScale = "linear",
): PointGraph {
  const segmentCount = graph.lengths.length;
  const edgeCount = graph.edgeSources.length;
  if (
    graph.edgeTargets.length !== edgeCount ||
    graph.edgeSourceReverse.length !== edgeCount ||
    graph.edgeTargetReverse.length !== edgeCount ||
    graph.edgeKinds.length !== edgeCount
  ) {
    throw new RangeError("Edge arrays must have the same length.");
  }
  const scale = segmentScale(graph.lengths, lengthScale);
  const pointOffsets = buildPointOffsets(graph.lengths, scale);
  const pointCount = pointOffsets[segmentCount]!;
  const segmentOf = new Uint32Array(pointCount);

  let usedEdges = 0;
  for (let edge = 0; edge < edgeCount; edge += 1) {
    if (graph.edgeSources[edge]! >= segmentCount || graph.edgeTargets[edge]! >= segmentCount) {
      throw new RangeError(`Edge ${edge} references a segment outside the graph.`);
    }
    if (includeJumps || graph.edgeKinds[edge] === 0) usedEdges += 1;
  }

  const total = pointCount - segmentCount + usedEdges;
  const edgeA = new Uint32Array(total);
  const edgeB = new Uint32Array(total);
  const edgeLength = new Float64Array(total);
  let cursor = 0;
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const first = pointOffsets[segment]!;
    const last = pointOffsets[segment + 1]! - 1;
    const step = segmentDrawLength(graph.lengths[segment]!, scale) / (last - first);
    for (let point = first; point <= last; point += 1) {
      segmentOf[point] = segment;
      if (point === last) continue;
      edgeA[cursor] = point;
      edgeB[cursor] = point + 1;
      edgeLength[cursor++] = step;
    }
  }
  for (let edge = 0; edge < edgeCount; edge += 1) {
    if (!includeJumps && graph.edgeKinds[edge] !== 0) continue;
    const [from, to] = edgeEndpoints(
      pointOffsets,
      graph.edgeSources[edge]!,
      graph.edgeSourceReverse[edge]!,
      graph.edgeTargets[edge]!,
      graph.edgeTargetReverse[edge]!,
    );
    edgeA[cursor] = from;
    edgeB[cursor] = to;
    edgeLength[cursor++] = LINK_LENGTH;
  }
  return { pointCount, pointOffsets, segmentOf, edgeA, edgeB, edgeLength, scale };
}
