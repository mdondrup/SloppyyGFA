import type { GraphLayout } from "../model/graph";
import { fitSegmentCurves } from "./curves";
import { attraction, dampingFactor, FORCE_SCALING, mulberry32, THETA } from "./fmmm";
import { multilevelPlacement, type Level } from "./multilevel";
import { buildEndGraph, Dijkstra, endNode, OpenEndRepulsion, openEndPoints } from "./open-ends";
import {
  buildPointGraph,
  LINK_LENGTH,
  POINT_SPACING,
  segmentDrawLength,
  type LengthScale,
  type PointGraph,
  type SegmentGraph,
} from "./point-graph";
import { QuadTree } from "./quadtree";

export type LayoutAlgorithm = "force" | "radial" | "hierarchical" | "spiral";

export const LAYOUT_ALGORITHMS: ReadonlyArray<{
  readonly id: LayoutAlgorithm;
  readonly label: string;
}> = [
  { id: "force", label: "Force-directed" },
  { id: "radial", label: "Radial (star)" },
  { id: "hierarchical", label: "Hierarchical" },
  { id: "spiral", label: "Spiral" },
];

export interface LayoutOptions {
  readonly algorithm: LayoutAlgorithm;
  /** Root segment index. Applies to its connected component; others use their highest-degree point. */
  readonly root?: number;
  /** Treat GFA `J` jump records as layout edges. Defaults to false, as in Bandage. */
  readonly includeJumps?: boolean;
  /** Mapping from base pairs to drawn segment length. Defaults to Bandage's linear scale. */
  readonly lengthScale?: LengthScale;
  /**
   * Pull segments linked to three or more others towards the centroid of their neighbours
   * in the force layout, so highly connected hubs sit at the centre of tangles. Defaults to true.
   */
  readonly hubWeighting?: boolean;
  /**
   * Multiplier of the force layout's curve regularisation (handle and curvature costs).
   * Larger values keep segments straighter; `Infinity` draws every segment straight. Defaults to 1.
   */
  readonly curveStiffness?: number;
  /**
   * Initial placement of the force layout: FMMM's multilevel start (coarsen, place the coarsest
   * level, refine level by level) with the coarsest level seeded from the radial tree layout
   * (`multilevel`) or placed at random as in OGDF (`multilevel-random`), or the radial tree
   * layout alone (`radial`). Defaults to `multilevel`.
   */
  readonly forceStart?: ForceStart;
  /**
   * Strength of the extra repulsion between open segment ends of the same component,
   * weighted by the square of their graph path length. 0 disables it. Defaults to 1.
   */
  readonly openEndRepulsion?: number;
  readonly onProgress?: (fraction: number) => void;
}

export type ForceStart = "multilevel" | "multilevel-random" | "radial";

export const FORCE_STARTS: ReadonlyArray<{ readonly id: ForceStart; readonly label: string }> = [
  { id: "multilevel", label: "Multilevel, tree seed" },
  { id: "multilevel-random", label: "Multilevel, random (OGDF)" },
  { id: "radial", label: "Radial seed" },
];

export const CURVE_STIFFNESS: ReadonlyArray<{ readonly id: string; readonly label: string; readonly value: number }> = [
  { id: "balanced", label: "Balanced", value: 1 },
  { id: "flexible", label: "Flexible", value: 0.25 },
  { id: "stiff", label: "Stiff", value: 4 },
  { id: "straight", label: "Straight", value: Infinity },
];

export const OPEN_END_REPULSION: ReadonlyArray<{ readonly id: string; readonly label: string; readonly value: number }> = [
  { id: "off", label: "Off", value: 0 },
  { id: "weak", label: "Weak", value: 0.3 },
  { id: "medium", label: "Medium", value: 1 },
  { id: "strong", label: "Strong", value: 3 },
];

export const DEFAULT_OPEN_END_REPULSION = 1;

export const NODE_SPACING = 10;
/** Bandage `componentSeparation` (FMMM `minDistCC`). */
const COMPONENT_PADDING = 50;
/** FMMM `stepsForRotatingComponents` as configured by Bandage. */
const ROTATION_STEPS = 50;

/**
 * OGDF FMMM measures ideal edge lengths between node bounding circles, and BandageNG gives
 * every layout node a 5 x 5 box (its `edgeLength`), so each ideal length grows by two radii.
 */
const EDGE_LENGTH_PADDING = 2 * Math.hypot(LINK_LENGTH / 2, LINK_LENGTH / 2);
/** OGDF FMMM `fineTuneScalar`: step cooling while fine tuning (a tenth of it for the last 5 iterations). */
const FINE_TUNE_SCALAR = 0.2;
/** OGDF FMMM `postSpringStrength`: attraction weight while fine tuning. */
const POST_SPRING_STRENGTH = 2;
/** OGDF FMMM post-processing iterations before the first rescale. */
const POST_ITERATIONS = 10;
/** OGDF FMMM `fineTuningIterations` at BandageNG layout quality 2. */
const FINE_TUNE_ITERATIONS = 20;
/** Hub centring: scaled force per unit offset of a hub from its neighbours' centroid. */
const HUB_PULL = 10;
const HUB_MIN_DEGREE = 3;
/** Radial seed: iteration budget per component, in points times log2(points) per iteration. */
const FORCE_WORK_BUDGET = 8e6;
/** Multilevel start: estimated coarse-level work per finest-level point, for progress reports. */
const MULTILEVEL_COARSE_WORK = 60;
const MIN_ITERATIONS = 40;
const MAX_ITERATIONS = 400;
/**
 * Segment curve regularisation, in per-point force units (FMMM forces before `forceScale`).
 * Any handle offset costs `HANDLE_COST`; bending costs `CURVATURE_COST * tan^2(beta / 2)` more
 * for a total turn `beta`. Tuned on the plant metagenome against BandageNG: segments stay
 * straight unless pulled, gentle arcs remain cheap and hairpins become prohibitive.
 */
const HANDLE_COST = 0.05;
const CURVATURE_COST = 2;

interface ComponentBox {
  begin: number;
  end: number;
  /** Total sequence length of the component's segments, in base pairs. */
  bases: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface Adjacency {
  readonly offsets: Uint32Array;
  readonly neighbors: Uint32Array;
  readonly lengths: Float64Array;
}

interface TreeResult {
  readonly positions: Float32Array;
  readonly order: Uint32Array;
  readonly component: Int32Array;
  readonly boxes: ComponentBox[];
}

export function computeLayout(graph: SegmentGraph, options: LayoutOptions): GraphLayout {
  const segmentCount = graph.lengths.length;
  if (options.root !== undefined && (options.root < 0 || options.root >= segmentCount)) {
    throw new RangeError(`Layout root ${options.root} is out of range.`);
  }
  const points = buildPointGraph(graph, options.includeJumps ?? false, options.lengthScale);
  if (options.algorithm === "spiral") {
    const positions = spiralLayout(graph, points);
    const curves = fitSegmentCurves(positions, points.pointOffsets);
    options.onProgress?.(1);
    return { positions, pointOffsets: points.pointOffsets, curves };
  }

  const rootPoint =
    options.root === undefined
      ? undefined
      : points.pointOffsets[options.root]! +
        Math.floor((points.pointOffsets[options.root + 1]! - points.pointOffsets[options.root]! - 1) / 2);
  const adjacency = buildAdjacency(points);
  const tree = treeLayout(
    points,
    adjacency,
    options.algorithm === "hierarchical" ? "hierarchical" : "radial",
    rootPoint,
  );
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const box = tree.boxes[tree.component[points.pointOffsets[segment]!]!]!;
    box.bases += graph.lengths[segment]!;
  }
  if (options.algorithm === "force") {
    const stiffness = options.curveStiffness ?? 1;
    const openEnds = options.openEndRepulsion ?? DEFAULT_OPEN_END_REPULSION;
    forceRefine(points, tree, {
      hubWeighting: options.hubWeighting ?? true,
      stiffness: Number.isNaN(stiffness) || stiffness < 0 ? 1 : stiffness,
      start: options.forceStart ?? "multilevel",
      openEndStrength: Number.isFinite(openEnds) && openEnds > 0 ? openEnds : 0,
      openEnds: openEnds > 0 ? openEndPoints(graph, points.pointOffsets) : undefined,
      onProgress: options.onProgress,
    });
    for (const box of tree.boxes) rotateComponent(tree.positions, tree.order, box);
  }
  packComponents(tree.positions, tree.order, tree.boxes);
  const curves = fitSegmentCurves(tree.positions, points.pointOffsets);
  options.onProgress?.(1);
  return { positions: tree.positions, pointOffsets: points.pointOffsets, curves };
}

/** Segment midpoints on a golden-angle spiral; each segment is drawn horizontally. */
function spiralLayout(graph: SegmentGraph, points: PointGraph): Float32Array {
  const segmentCount = graph.lengths.length;
  const positions = new Float32Array(points.pointCount * 2);
  let meanLength = 0;
  for (let segment = 0; segment < segmentCount; segment += 1) {
    meanLength += segmentDrawLength(graph.lengths[segment]!, points.scale);
  }
  meanLength /= Math.max(1, segmentCount);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const spacing = Math.max(8, meanLength * 1.2, 120 / Math.sqrt(Math.max(1, segmentCount)));
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const radius = spacing * Math.sqrt(segment);
    const angle = segment * goldenAngle;
    const centerX = Math.cos(angle) * radius;
    const centerY = Math.sin(angle) * radius;
    const length = segmentDrawLength(graph.lengths[segment]!, points.scale);
    const first = points.pointOffsets[segment]!;
    const last = points.pointOffsets[segment + 1]! - 1;
    for (let point = first; point <= last; point += 1) {
      positions[point * 2] = centerX - length / 2 + (length * (point - first)) / (last - first);
      positions[point * 2 + 1] = centerY;
    }
  }
  return positions;
}

/**
 * Lays out each connected component as a BFS spanning tree in O(n + m).
 * Distance from the root follows edge lengths, so drawn segment length is preserved along
 * tree paths. Every subtree receives an angular (radial) or horizontal (hierarchical) slice
 * proportional to its leaf count, so spanning-tree edges never cross.
 */
function treeLayout(
  graph: PointGraph,
  adjacency: Adjacency,
  algorithm: "radial" | "hierarchical",
  requestedRoot: number | undefined,
): TreeResult {
  const n = graph.pointCount;
  const positions = new Float32Array(n * 2);
  const { offsets, neighbors, lengths } = adjacency;
  const component = new Int32Array(n).fill(-1);
  const parent = new Int32Array(n).fill(-1);
  const distance = new Float64Array(n);
  const order = new Uint32Array(n);
  const queue = new Uint32Array(n);
  const visited = new Uint8Array(n);
  const weight = new Float64Array(n);
  const start = new Float64Array(n);
  const span = new Float64Array(n);
  const cursor = new Float64Array(n);
  const boxes: ComponentBox[] = [];
  let orderEnd = 0;

  for (let seed = 0; seed < n; seed += 1) {
    if (component[seed] !== -1) continue;
    const id = boxes.length;

    let head = 0;
    let tail = 0;
    let root = seed;
    let rootDegree = -1;
    let containsRequestedRoot = false;
    queue[tail++] = seed;
    component[seed] = id;
    while (head < tail) {
      const node = queue[head++]!;
      const degree = offsets[node + 1]! - offsets[node]!;
      if (degree > rootDegree) {
        root = node;
        rootDegree = degree;
      }
      if (node === requestedRoot) containsRequestedRoot = true;
      for (let edge = offsets[node]!; edge < offsets[node + 1]!; edge += 1) {
        const neighbor = neighbors[edge]!;
        if (component[neighbor] === -1) {
          component[neighbor] = id;
          queue[tail++] = neighbor;
        }
      }
    }
    if (containsRequestedRoot) root = requestedRoot!;

    const begin = orderEnd;
    visited[root] = 1;
    order[orderEnd++] = root;
    for (let index = begin; index < orderEnd; index += 1) {
      const node = order[index]!;
      for (let edge = offsets[node]!; edge < offsets[node + 1]!; edge += 1) {
        const neighbor = neighbors[edge]!;
        if (visited[neighbor]) continue;
        visited[neighbor] = 1;
        parent[neighbor] = node;
        distance[neighbor] = distance[node]! + lengths[edge]!;
        order[orderEnd++] = neighbor;
      }
    }
    const end = orderEnd;

    let maxDistance = 0;
    for (let index = end - 1; index >= begin; index -= 1) {
      const node = order[index]!;
      if (weight[node] === 0) weight[node] = 1;
      maxDistance = Math.max(maxDistance, distance[node]!);
      const parentNode = parent[node]!;
      if (parentNode >= 0) weight[parentNode] = weight[parentNode]! + weight[node]!;
    }

    start[root] = 0;
    span[root] = 1;
    cursor[root] = 0;
    for (let index = begin + 1; index < end; index += 1) {
      const node = order[index]!;
      const parentNode = parent[node]!;
      start[node] = cursor[parentNode]!;
      span[node] = (span[parentNode]! * weight[node]!) / weight[parentNode]!;
      cursor[parentNode] = cursor[parentNode]! + span[node]!;
      cursor[node] = start[node]!;
    }

    const leaves = weight[root]!;
    const box: ComponentBox = {
      begin,
      end,
      bases: 0,
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
    };
    if (algorithm === "radial") {
      const outerRadius = Math.max(maxDistance, (leaves * NODE_SPACING) / (2 * Math.PI));
      const scale = maxDistance > 0 ? outerRadius / maxDistance : 0;
      for (let index = begin; index < end; index += 1) {
        const node = order[index]!;
        const angle = 2 * Math.PI * (start[node]! + span[node]! / 2);
        const radius = distance[node]! * scale;
        positions[node * 2] = Math.cos(angle) * radius;
        positions[node * 2 + 1] = Math.sin(angle) * radius;
      }
    } else {
      const width = leaves * NODE_SPACING;
      for (let index = begin; index < end; index += 1) {
        const node = order[index]!;
        positions[node * 2] = (start[node]! + span[node]! / 2) * width - width / 2;
        positions[node * 2 + 1] = -distance[node]!;
      }
    }
    updateBox(box, positions, order);
    boxes.push(box);
  }

  return { positions, order, component, boxes };
}

interface ForceSettings {
  readonly hubWeighting: boolean;
  readonly stiffness: number;
  readonly start: ForceStart;
  readonly openEndStrength: number;
  /** Open-end flag per point, when open-end repulsion is enabled. */
  readonly openEnds: Uint8Array | undefined;
  readonly onProgress: ((fraction: number) => void) | undefined;
}

/**
 * Refines each multi-segment component in place with the force model of OGDF's FMMM as
 * configured by BandageNG (repulsion `1/d` between sample points via Barnes-Hut, attraction
 * `log2(d/l) * d^2 / l^3` along every chain piece and link, forces scaled by the mean ideal
 * edge length squared, steps capped at a fifth of the component box, oscillation damping,
 * post-processing with rescaling and fine tuning), but with every segment constrained to a
 * quadratic Bézier curve: its start, its end and one handle. The sample points feel FMMM's
 * forces; each step moves the curve to the least-squares fit of the samples' moves. The
 * handle is regularised towards the chord midpoint (a straight segment) by soft-thresholding:
 * a constant cost for any handle offset plus a cost that grows with the bend angle at the
 * handle, so segments stay straight unless the forces bending them outweigh it.
 * The start is FMMM's multilevel placement (unconstrained points on the coarse levels, with
 * the finest level's FMMM iteration count) or the radial tree layout. Components are refined
 * from the longest (total base pairs) to the shortest.
 */
function forceRefine(graph: PointGraph, tree: TreeResult, settings: ForceSettings): void {
  const { hubWeighting, stiffness, start, openEndStrength, openEnds, onProgress } = settings;
  const { positions, order, component, boxes } = tree;
  const { edgeA, edgeB, edgeLength, pointOffsets, segmentOf } = graph;
  const segmentCount = pointOffsets.length - 1;
  const hubs = hubWeighting ? hubNeighbours(graph) : undefined;
  const hubsByComponent: number[][] = boxes.map(() => []);
  const segmentsByComponent: number[][] = boxes.map(() => []);
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const id = component[pointOffsets[segment]!]!;
    segmentsByComponent[id]!.push(segment);
    if (hubs && hubs.offsets[segment + 1]! - hubs.offsets[segment]! >= HUB_MIN_DEGREE) {
      hubsByComponent[id]!.push(segment);
    }
  }
  const segmentX = new Float64Array(hubs ? segmentCount : 0);
  const segmentY = new Float64Array(segmentX.length);
  const segmentFx = new Float64Array(segmentX.length);
  const segmentFy = new Float64Array(segmentX.length);

  const edgeOffsets = new Uint32Array(boxes.length + 1);
  for (let edge = 0; edge < edgeA.length; edge += 1) {
    if (edgeA[edge] === edgeB[edge]) continue;
    const id = component[edgeA[edge]!]!;
    edgeOffsets[id + 1] = edgeOffsets[id + 1]! + 1;
  }
  for (let id = 0; id < boxes.length; id += 1) {
    edgeOffsets[id + 1] = edgeOffsets[id + 1]! + edgeOffsets[id]!;
  }
  const edgeOrder = new Uint32Array(edgeOffsets[boxes.length]!);
  const fill = edgeOffsets.slice(0, boxes.length);
  for (let edge = 0; edge < edgeA.length; edge += 1) {
    if (edgeA[edge] === edgeB[edge]) continue;
    edgeOrder[fill[component[edgeA[edge]!]!]!++] = edge;
  }

  const multilevel = start !== "radial";
  const iterationsFor = (size: number) =>
    multilevel
      ? size <= 500
        ? 100
        : 30
      : Math.round(
          Math.min(MAX_ITERATIONS, Math.max(MIN_ITERATIONS, FORCE_WORK_BUDGET / (size * Math.log2(size + 1)))),
        );
  // Longest components first; ties by point count, then input order.
  const ids = boxes
    .map((_, id) => id)
    .filter((id) => segmentsByComponent[id]!.length > 1)
    .sort(
      (a, b) =>
        boxes[b]!.bases - boxes[a]!.bases ||
        boxes[b]!.end - boxes[b]!.begin - (boxes[a]!.end - boxes[a]!.begin) ||
        a - b,
    );
  let totalWork = 0;
  let largest = 0;
  for (const id of ids) {
    const size = boxes[id]!.end - boxes[id]!.begin;
    const coarse = multilevel ? MULTILEVEL_COARSE_WORK : 0;
    totalWork += size * (iterationsFor(size) + coarse + POST_ITERATIONS + FINE_TUNE_ITERATIONS);
    largest = Math.max(largest, size);
  }
  if (totalWork === 0) return;

  const local = new Int32Array(graph.pointCount);
  const xs = new Float64Array(largest);
  const ys = new Float64Array(largest);
  const fx = new Float64Array(largest);
  const fy = new Float64Array(largest);
  // Curve controls per segment: start, end, and handle offset from the chord midpoint.
  const startX = new Float64Array(segmentCount);
  const startY = new Float64Array(segmentCount);
  const endX = new Float64Array(segmentCount);
  const endY = new Float64Array(segmentCount);
  const handleX = new Float64Array(segmentCount);
  const handleY = new Float64Array(segmentCount);
  // Previous moves of start, end and handle, for oscillation damping.
  const lastMove = new Float64Array(segmentCount * 6);
  const controls = new Float64Array(6);
  const force = new Float64Array(2);
  const quadTree = new QuadTree(largest * 2);
  const random = mulberry32(0x9e3779b9);
  const theta2 = THETA * THETA;
  const fits = new Map<number, Float64Array>();
  const dijkstra = openEnds ? new Dijkstra(buildEndGraph(graph, EDGE_LENGTH_PADDING)) : undefined;
  let doneWork = 0;
  let lastReport = 0;
  const addWork = (work: number) => {
    doneWork += work;
    if (onProgress && doneWork - lastReport > totalWork / 50) {
      lastReport = doneWork;
      onProgress(Math.min(0.99, doneWork / totalWork));
    }
  };

  for (const id of ids) {
    const box = boxes[id]!;
    const size = box.end - box.begin;
    const segments = segmentsByComponent[id]!;
    for (let index = 0; index < size; index += 1) local[order[box.begin + index]!] = index;
    const sample = () => {
      for (const segment of segments) {
        const first = pointOffsets[segment]!;
        const pieces = pointOffsets[segment + 1]! - 1 - first;
        for (let k = 0; k <= pieces; k += 1) {
          const t = k / pieces;
          const bump = 2 * t * (1 - t);
          const index = local[first + k]!;
          xs[index] = (1 - t) * startX[segment]! + t * endX[segment]! + bump * handleX[segment]!;
          ys[index] = (1 - t) * startY[segment]! + t * endY[segment]! + bump * handleY[segment]!;
        }
      }
    };

    const edgeBegin = edgeOffsets[id]!;
    const edgeEnd = edgeOffsets[id + 1]!;
    const componentHubs = hubsByComponent[id]!;
    let idealSum = 0;
    for (let cursor = edgeBegin; cursor < edgeEnd; cursor += 1) {
      idealSum += edgeLength[edgeOrder[cursor]!]! + EDGE_LENGTH_PADDING;
    }
    const meanIdeal = edgeEnd > edgeBegin ? idealSum / (edgeEnd - edgeBegin) : POINT_SPACING;
    const forceScale = meanIdeal * meanIdeal;

    let openForce: OpenEndRepulsion | undefined;
    if (openEnds && dijkstra) {
      const nodes: number[] = [];
      const ends: number[] = [];
      for (const segment of segments) {
        for (const point of [pointOffsets[segment]!, pointOffsets[segment + 1]! - 1]) {
          if (!openEnds[point]) continue;
          nodes.push(local[point]!);
          ends.push(endNode(graph, point));
        }
      }
      openForce = OpenEndRepulsion.build(
        Uint32Array.from(nodes),
        Uint32Array.from(ends),
        dijkstra,
        openEndStrength,
      );
    }

    let finestIterations: number | undefined;
    if (multilevel) {
      const count = edgeEnd - edgeBegin;
      const levelA = new Uint32Array(count);
      const levelB = new Uint32Array(count);
      const ideal = new Float64Array(count);
      for (let cursor = 0; cursor < count; cursor += 1) {
        const edge = edgeOrder[edgeBegin + cursor]!;
        levelA[cursor] = local[edgeA[edge]!]!;
        levelB[cursor] = local[edgeB[edge]!]!;
        ideal[cursor] = edgeLength[edge]! + EDGE_LENGTH_PADDING;
      }
      const finest: Level = { n: size, edgeA: levelA, edgeB: levelB, ideal, mass: new Float64Array(size).fill(1) };
      const seedXs = new Float64Array(size);
      const seedYs = new Float64Array(size);
      for (let index = 0; index < size; index += 1) {
        const point = order[box.begin + index]!;
        seedXs[index] = positions[point * 2]!;
        seedYs[index] = positions[point * 2 + 1]!;
      }
      const placed = multilevelPlacement(
        finest,
        random,
        quadTree,
        openForce ? (px, py, gx, gy, rep, mean) => openForce.apply(px, py, gx, gy, rep, mean) : undefined,
        addWork,
        start === "multilevel" ? { xs: seedXs, ys: seedYs } : undefined,
      );
      finestIterations = placed.finestIterations;
      // Each segment starts as the least-squares curve through its placed points.
      for (const segment of segments) {
        const first = pointOffsets[segment]!;
        const pieces = pointOffsets[segment + 1]! - 1 - first;
        projectSegment(curveFit(fits, pieces), first, pieces, local, placed.xs, placed.ys, controls);
        startX[segment] = controls[0]!;
        startY[segment] = controls[1]!;
        endX[segment] = controls[2]!;
        endY[segment] = controls[3]!;
        const curved = pieces >= 2 && Number.isFinite(stiffness);
        handleX[segment] = curved ? controls[4]! : 0;
        handleY[segment] = curved ? controls[5]! : 0;
        lastMove.fill(0, segment * 6, segment * 6 + 6);
      }
    } else {
      for (const segment of segments) {
        const first = pointOffsets[segment]!;
        const last = pointOffsets[segment + 1]! - 1;
        startX[segment] = positions[first * 2]! + (random() - 0.5) * 0.01;
        startY[segment] = positions[first * 2 + 1]! + (random() - 0.5) * 0.01;
        endX[segment] = positions[last * 2]! + (random() - 0.5) * 0.01;
        endY[segment] = positions[last * 2 + 1]! + (random() - 0.5) * 0.01;
        handleX[segment] = 0;
        handleY[segment] = 0;
        lastMove.fill(0, segment * 6, segment * 6 + 6);
      }
    }
    sample();

    const iterate = (iteration: number, cool: number, spring: number, repulsion: number) => {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let index = 0; index < size; index += 1) {
        minX = Math.min(minX, xs[index]!);
        maxX = Math.max(maxX, xs[index]!);
        minY = Math.min(minY, ys[index]!);
        maxY = Math.max(maxY, ys[index]!);
      }
      const boxLength = Math.max(maxX - minX, maxY - minY) * 1.01 + 2;
      const maxRadius = iteration === 0 ? boxLength / 1000 : boxLength / 5;

      quadTree.build(xs, ys, size);
      for (let index = 0; index < size; index += 1) {
        force[0] = 0;
        force[1] = 0;
        quadTree.repulse(index, xs[index]!, ys[index]!, theta2, repulsion, force);
        fx[index] = force[0];
        fy[index] = force[1];
      }
      for (let cursor = edgeBegin; cursor < edgeEnd; cursor += 1) {
        const edge = edgeOrder[cursor]!;
        const a = local[edgeA[edge]!]!;
        const b = local[edgeB[edge]!]!;
        let ex = xs[b]! - xs[a]!;
        let ey = ys[b]! - ys[a]!;
        let length = Math.sqrt(ex * ex + ey * ey);
        if (length < 1e-9) {
          ex = (random() - 0.5) * 1e-3;
          ey = (random() - 0.5) * 1e-3;
          length = Math.sqrt(ex * ex + ey * ey);
        }
        const pull = spring * attraction(length, edgeLength[edge]! + EDGE_LENGTH_PADDING);
        fx[a] = fx[a]! + ex * pull;
        fy[a] = fy[a]! + ey * pull;
        fx[b] = fx[b]! - ex * pull;
        fy[b] = fy[b]! - ey * pull;
      }
      if (hubs && componentHubs.length > 0) {
        for (const segment of segments) {
          segmentX[segment] = 0;
          segmentY[segment] = 0;
          segmentFx[segment] = 0;
          segmentFy[segment] = 0;
        }
        for (let index = 0; index < size; index += 1) {
          const segment = segmentOf[order[box.begin + index]!]!;
          segmentX[segment] = segmentX[segment]! + xs[index]!;
          segmentY[segment] = segmentY[segment]! + ys[index]!;
        }
        // Pull each hub towards the centroid of its neighbours, pushing them back equally.
        for (const hub of componentHubs) {
          const begin = hubs.offsets[hub]!;
          const end = hubs.offsets[hub + 1]!;
          const degree = end - begin;
          let targetX = 0;
          let targetY = 0;
          for (let cursor = begin; cursor < end; cursor += 1) {
            const neighbour = hubs.neighbours[cursor]!;
            const points = pointOffsets[neighbour + 1]! - pointOffsets[neighbour]!;
            targetX += segmentX[neighbour]! / points;
            targetY += segmentY[neighbour]! / points;
          }
          const hubPoints = pointOffsets[hub + 1]! - pointOffsets[hub]!;
          const strength = (HUB_PULL * (1 - 2 / degree)) / forceScale;
          const hx = strength * (targetX / degree - segmentX[hub]! / hubPoints);
          const hy = strength * (targetY / degree - segmentY[hub]! / hubPoints);
          // Forces are per segment (total), spread evenly over its points below.
          segmentFx[hub] = segmentFx[hub]! + hx * hubPoints;
          segmentFy[hub] = segmentFy[hub]! + hy * hubPoints;
          for (let cursor = begin; cursor < end; cursor += 1) {
            const neighbour = hubs.neighbours[cursor]!;
            segmentFx[neighbour] = segmentFx[neighbour]! - (hx * hubPoints) / degree;
            segmentFy[neighbour] = segmentFy[neighbour]! - (hy * hubPoints) / degree;
          }
        }
        for (let index = 0; index < size; index += 1) {
          const segment = segmentOf[order[box.begin + index]!]!;
          const points = pointOffsets[segment + 1]! - pointOffsets[segment]!;
          fx[index] = fx[index]! + segmentFx[segment]! / points;
          fy[index] = fy[index]! + segmentFy[segment]! / points;
        }
      }
      // Open-end repulsion is a repulsive force, so it follows FMMM's reduced repulsion while fine tuning.
      openForce?.apply(xs, ys, fx, fy, undefined, meanIdeal, repulsion);
      // FMMM's capped move of every sample point.
      for (let index = 0; index < size; index += 1) {
        const gx = fx[index]! * forceScale;
        const gy = fy[index]! * forceScale;
        const norm = Math.sqrt(gx * gx + gy * gy);
        const factor = norm > 0 ? Math.min(norm * cool * FORCE_SCALING, maxRadius) / norm : 0;
        fx[index] = gx * factor;
        fy[index] = gy * factor;
      }
      const shrinkScale = cool * FORCE_SCALING * forceScale * stiffness;
      const curved = Number.isFinite(stiffness);
      for (const segment of segments) {
        const first = pointOffsets[segment]!;
        const pieces = pointOffsets[segment + 1]! - 1 - first;
        // Least-squares curve move of the sample points' moves.
        projectSegment(curveFit(fits, pieces), first, pieces, local, fx, fy, controls);
        const base = segment * 6;
        for (let control = 0; control < 6; control += 2) {
          let moveX = controls[control]!;
          let moveY = controls[control + 1]!;
          const norm = Math.sqrt(moveX * moveX + moveY * moveY);
          if (norm > maxRadius) {
            moveX *= maxRadius / norm;
            moveY *= maxRadius / norm;
          }
          if (iteration > 0) {
            const damping = dampingFactor(lastMove[base + control]!, lastMove[base + control + 1]!, moveX, moveY);
            moveX *= damping;
            moveY *= damping;
          }
          lastMove[base + control] = moveX;
          lastMove[base + control + 1] = moveY;
        }
        startX[segment] = startX[segment]! + lastMove[base]!;
        startY[segment] = startY[segment]! + lastMove[base + 1]!;
        endX[segment] = endX[segment]! + lastMove[base + 2]!;
        endY[segment] = endY[segment]! + lastMove[base + 3]!;
        if (pieces < 2 || !curved) continue;
        let hx = handleX[segment]! + lastMove[base + 4]!;
        let hy = handleY[segment]! + lastMove[base + 5]!;
        const handle = Math.sqrt(hx * hx + hy * hy);
        if (handle > 0) {
          const shrink = shrinkScale * handleCost(startX[segment]!, startY[segment]!, endX[segment]!, endY[segment]!, hx, hy);
          const kept = Math.max(0, handle - shrink) / handle;
          hx *= kept;
          hy *= kept;
        }
        handleX[segment] = hx;
        handleY[segment] = hy;
      }
      sample();
      addWork(size);
    };

    // FMMM `adapt_drawing_to_ideal_average_edgelength`, about the component centroid.
    const rescale = () => {
      let real = 0;
      for (let cursor = edgeBegin; cursor < edgeEnd; cursor += 1) {
        const edge = edgeOrder[cursor]!;
        const a = local[edgeA[edge]!]!;
        const b = local[edgeB[edge]!]!;
        real += Math.hypot(xs[b]! - xs[a]!, ys[b]! - ys[a]!);
      }
      if (real === 0) return;
      const factor = idealSum / real;
      let centerX = 0;
      let centerY = 0;
      for (let index = 0; index < size; index += 1) {
        centerX += xs[index]!;
        centerY += ys[index]!;
      }
      centerX /= size;
      centerY /= size;
      for (const segment of segments) {
        startX[segment] = centerX + (startX[segment]! - centerX) * factor;
        startY[segment] = centerY + (startY[segment]! - centerY) * factor;
        endX[segment] = centerX + (endX[segment]! - centerX) * factor;
        endY[segment] = centerY + (endY[segment]! - centerY) * factor;
        handleX[segment] = handleX[segment]! * factor;
        handleY[segment] = handleY[segment]! * factor;
      }
      sample();
    };

    // The tree seed uses nominal lengths, so start it at the padded ideal edge length. FMMM never
    // rescales between levels: the prolonged multilevel start keeps the coarse levels' spread.
    if (!multilevel) rescale();
    const iterations = finestIterations ?? iterationsFor(size);
    for (let iteration = 0; iteration < iterations; iteration += 1) iterate(iteration, 1, 1, 1);
    for (let iteration = 0; iteration < POST_ITERATIONS; iteration += 1) iterate(iteration, 0.1, 1, 1);
    rescale();
    const postRepulsion = Math.min(0.2, 400 / size);
    for (let iteration = 0; iteration < FINE_TUNE_ITERATIONS; iteration += 1) {
      const cool = iteration < FINE_TUNE_ITERATIONS - 5 ? FINE_TUNE_SCALAR : FINE_TUNE_SCALAR / 10;
      iterate(iteration, cool, POST_SPRING_STRENGTH, postRepulsion);
    }
    rescale();

    for (let index = 0; index < size; index += 1) {
      const point = order[box.begin + index]!;
      positions[point * 2] = xs[index]!;
      positions[point * 2 + 1] = ys[index]!;
    }
    updateBox(box, positions, order);
  }
}

/**
 * Least-squares quadratic curve `(1-t) P0 + t P2 + 2t(1-t) H` through the values `vx`, `vy` of
 * a segment's points (local indices) at `t = k / pieces`: writes `P0`, `P2` and `H` to `out`.
 */
function projectSegment(
  inverse: Float64Array,
  first: number,
  pieces: number,
  local: Int32Array,
  vx: Float64Array,
  vy: Float64Array,
  out: Float64Array,
): void {
  let r0x = 0;
  let r0y = 0;
  let r1x = 0;
  let r1y = 0;
  let r2x = 0;
  let r2y = 0;
  for (let k = 0; k <= pieces; k += 1) {
    const t = k / pieces;
    const index = local[first + k]!;
    const mx = vx[index]!;
    const my = vy[index]!;
    const bump = 2 * t * (1 - t);
    r0x += (1 - t) * mx;
    r0y += (1 - t) * my;
    r1x += t * mx;
    r1y += t * my;
    r2x += bump * mx;
    r2y += bump * my;
  }
  out[0] = inverse[0]! * r0x + inverse[1]! * r1x + inverse[2]! * r2x;
  out[1] = inverse[0]! * r0y + inverse[1]! * r1y + inverse[2]! * r2y;
  out[2] = inverse[3]! * r0x + inverse[4]! * r1x + inverse[5]! * r2x;
  out[3] = inverse[3]! * r0y + inverse[4]! * r1y + inverse[5]! * r2y;
  out[4] = inverse[6]! * r0x + inverse[7]! * r1x + inverse[8]! * r2x;
  out[5] = inverse[6]! * r0y + inverse[7]! * r1y + inverse[8]! * r2y;
}

/**
 * Regularisation of a segment's handle, in FMMM force units per unit of handle offset
 * removed: `HANDLE_COST` for any handle at all, plus `CURVATURE_COST * tan^2(beta / 2)`
 * for the curve's total turn `beta` (the angle between the start and end tangents), so
 * gentle arcs are cheap and hairpins prohibitive.
 */
function handleCost(startX: number, startY: number, endX: number, endY: number, hx: number, hy: number): number {
  const handleX = (startX + endX) / 2 + hx;
  const handleY = (startY + endY) / 2 + hy;
  const ux = handleX - startX;
  const uy = handleY - startY;
  const vx = endX - handleX;
  const vy = endY - handleY;
  const norms = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
  const cosine = norms > 0 ? Math.max(-1, Math.min(1, (ux * vx + uy * vy) / norms)) : 1;
  return HANDLE_COST + (CURVATURE_COST * (1 - cosine)) / Math.max(1 + cosine, 1e-6);
}

/**
 * Inverse Gram matrix (row-major 3 x 3) of the quadratic Bézier basis `(1-t, t, 2t(1-t))`
 * sampled at `t = k / pieces`. Single-piece segments have no interior sample, so their
 * handle stays at zero.
 */
function curveFit(cache: Map<number, Float64Array>, pieces: number): Float64Array {
  const cached = cache.get(pieces);
  if (cached) return cached;
  const inverse = new Float64Array(9);
  if (pieces < 2) {
    inverse[0] = 1;
    inverse[4] = 1;
  } else {
    const g = new Float64Array(9);
    for (let k = 0; k <= pieces; k += 1) {
      const t = k / pieces;
      const basis = [1 - t, t, 2 * t * (1 - t)];
      for (let row = 0; row < 3; row += 1) {
        for (let column = 0; column < 3; column += 1) {
          g[row * 3 + column] = g[row * 3 + column]! + basis[row]! * basis[column]!;
        }
      }
    }
    const [a, b, c, d, e, f, h, i, j] = g as unknown as number[];
    const det = a! * (e! * j! - f! * i!) - b! * (d! * j! - f! * h!) + c! * (d! * i! - e! * h!);
    inverse.set([
      (e! * j! - f! * i!) / det,
      (c! * i! - b! * j!) / det,
      (b! * f! - c! * e!) / det,
      (f! * h! - d! * j!) / det,
      (a! * j! - c! * h!) / det,
      (c! * d! - a! * f!) / det,
      (d! * i! - e! * h!) / det,
      (b! * h! - a! * i!) / det,
      (a! * e! - b! * d!) / det,
    ]);
  }
  cache.set(pieces, inverse);
  return inverse;
}

/** Distinct linked neighbour segments of every segment (CSR), ignoring self-links. */
export function hubNeighbours(graph: PointGraph): { offsets: Uint32Array; neighbours: Uint32Array } {
  const { edgeA, edgeB, segmentOf, pointOffsets } = graph;
  const segmentCount = pointOffsets.length - 1;
  const chainEdges = graph.pointCount - segmentCount;
  const pairs: number[] = [];
  for (let edge = chainEdges; edge < edgeA.length; edge += 1) {
    const a = segmentOf[edgeA[edge]!]!;
    const b = segmentOf[edgeB[edge]!]!;
    if (a !== b) pairs.push(a, b, b, a);
  }
  const lists: number[][] = Array.from({ length: segmentCount }, () => []);
  for (let cursor = 0; cursor < pairs.length; cursor += 2) lists[pairs[cursor]!]!.push(pairs[cursor + 1]!);
  const offsets = new Uint32Array(segmentCount + 1);
  const flat: number[] = [];
  for (let segment = 0; segment < segmentCount; segment += 1) {
    for (const neighbour of new Set(lists[segment])) flat.push(neighbour);
    offsets[segment + 1] = flat.length;
  }
  return { offsets, neighbours: Uint32Array.from(flat) };
}

/**
 * Rotates a component to the orientation with the smallest bounding box, then makes it wider
 * than tall, like FMMM's component rotation that Bandage uses to lay linear components flat.
 */
function rotateComponent(positions: Float32Array, order: Uint32Array, box: ComponentBox): void {
  const size = box.end - box.begin;
  if (size < 3) return;
  const centerX = (box.minX + box.maxX) / 2;
  const centerY = (box.minY + box.maxY) / 2;
  let bestAngle = 0;
  let bestArea = Infinity;
  let bestWide = true;
  for (let step = 0; step < ROTATION_STEPS; step += 1) {
    const angle = (step / ROTATION_STEPS) * (Math.PI / 2);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (let index = box.begin; index < box.end; index += 1) {
      const point = order[index]!;
      const x = positions[point * 2]! - centerX;
      const y = positions[point * 2 + 1]! - centerY;
      const u = x * cos - y * sin;
      const v = x * sin + y * cos;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea - 1e-9) {
      bestArea = area;
      bestAngle = angle;
      bestWide = maxU - minU >= maxV - minV;
    }
  }
  if (!bestWide) bestAngle += Math.PI / 2;
  if (bestAngle === 0) return;
  const cos = Math.cos(bestAngle);
  const sin = Math.sin(bestAngle);
  for (let index = box.begin; index < box.end; index += 1) {
    const point = order[index]!;
    const x = positions[point * 2]! - centerX;
    const y = positions[point * 2 + 1]! - centerY;
    positions[point * 2] = centerX + x * cos - y * sin;
    positions[point * 2 + 1] = centerY + x * sin + y * cos;
  }
  updateBox(box, positions, order);
}

function updateBox(box: ComponentBox, positions: Float32Array, order: Uint32Array): void {
  box.minX = Infinity;
  box.minY = Infinity;
  box.maxX = -Infinity;
  box.maxY = -Infinity;
  for (let index = box.begin; index < box.end; index += 1) {
    const node = order[index]!;
    const x = positions[node * 2]!;
    const y = positions[node * 2 + 1]!;
    box.minX = Math.min(box.minX, x);
    box.minY = Math.min(box.minY, y);
    box.maxX = Math.max(box.maxX, x);
    box.maxY = Math.max(box.maxY, y);
  }
}

function buildAdjacency(graph: PointGraph): Adjacency {
  const { pointCount, edgeA, edgeB, edgeLength } = graph;
  const degree = new Uint32Array(pointCount);
  for (let edge = 0; edge < edgeA.length; edge += 1) {
    const a = edgeA[edge]!;
    const b = edgeB[edge]!;
    if (a === b) continue;
    degree[a] = degree[a]! + 1;
    degree[b] = degree[b]! + 1;
  }
  const offsets = new Uint32Array(pointCount + 1);
  for (let node = 0; node < pointCount; node += 1) {
    offsets[node + 1] = offsets[node]! + degree[node]!;
  }
  const neighbors = new Uint32Array(offsets[pointCount]!);
  const lengths = new Float64Array(offsets[pointCount]!);
  const fill = offsets.slice(0, pointCount);
  for (let edge = 0; edge < edgeA.length; edge += 1) {
    const a = edgeA[edge]!;
    const b = edgeB[edge]!;
    if (a === b) continue;
    lengths[fill[a]!] = edgeLength[edge]!;
    neighbors[fill[a]!++] = b;
    lengths[fill[b]!] = edgeLength[edge]!;
    neighbors[fill[b]!++] = a;
  }
  return { offsets, neighbors, lengths };
}

/**
 * Shelf-packs component bounding boxes, longest (total base pairs) first so the largest
 * assembly sits at the top left, in rows no wider than the widest component or the square
 * root of their total area (FMMM's default page ratio of 1).
 * Components keep their natural size: the drawing grows with the graph and never depends on
 * the viewport, which only pans and zooms over it.
 */
function packComponents(positions: Float32Array, order: Uint32Array, boxes: ComponentBox[]): void {
  if (boxes.length === 0) return;
  const sorted = boxes.slice().sort(
    (a, b) =>
      b.bases - a.bases ||
      b.end - b.begin - (a.end - a.begin) ||
      b.maxY - b.minY - (a.maxY - a.minY),
  );
  let area = 0;
  let widest = 0;
  for (const box of sorted) {
    const width = box.maxX - box.minX + COMPONENT_PADDING;
    area += width * (box.maxY - box.minY + COMPONENT_PADDING);
    widest = Math.max(widest, width);
  }
  const rowLimit = Math.max(widest, Math.sqrt(area));

  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of sorted) {
    const width = box.maxX - box.minX + COMPONENT_PADDING;
    const height = box.maxY - box.minY + COMPONENT_PADDING;
    if (x > 0 && x + width > rowLimit) {
      y -= rowHeight;
      x = 0;
      rowHeight = 0;
    }
    const dx = x + COMPONENT_PADDING / 2 - box.minX;
    const dy = y - COMPONENT_PADDING / 2 - box.maxY;
    for (let index = box.begin; index < box.end; index += 1) {
      const node = order[index]!;
      positions[node * 2] = positions[node * 2]! + dx;
      positions[node * 2 + 1] = positions[node * 2 + 1]! + dy;
    }
    minX = Math.min(minX, box.minX + dx);
    minY = Math.min(minY, box.minY + dy);
    maxX = Math.max(maxX, box.maxX + dx);
    maxY = Math.max(maxY, box.maxY + dy);
    x += width;
    rowHeight = Math.max(rowHeight, height);
  }

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  for (let index = 0; index < positions.length; index += 2) {
    positions[index] = positions[index]! - centerX;
    positions[index + 1] = positions[index + 1]! - centerY;
  }
}
