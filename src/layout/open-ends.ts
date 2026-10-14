import type { PointGraph, SegmentGraph } from "./point-graph";

/*
 * Extra repulsion between the open ends of a connected component, to stretch assemblies out
 * along their longest paths. An open end is a segment end without any `L` link (`J` jump
 * links are ignored). Two open ends repel each other like FMMM's `1 / d` repulsion weighted by
 * the square of the graph path length `g` between them:
 *
 *   F = strength * g^2 / (G * meanIdeal * d)
 *
 * where `G` is the component's largest open-end path length and `meanIdeal` the mean ideal edge
 * length of the level, so the two ends of a fully stretched chain (`d = g = G`) feel a tension of
 * `strength / meanIdeal`, as from one FMMM repulsion at the ideal edge length, whatever the
 * graph's size. Every end sums the forces of all other open ends; components with more than
 * `MAX_PARTNERS` open ends use that many farthest-point pivots, scaled up to the full count.
 */

/** Most partners (pivots) per open end. */
export const MAX_PARTNERS = 256;

/** Flags every point that is an open segment end: no `L` link at that end (`J` links are ignored). */
export function openEndPoints(graph: SegmentGraph, pointOffsets: Uint32Array): Uint8Array {
  const segmentCount = graph.lengths.length;
  // Segment ends: 2 * segment is the start (5'), 2 * segment + 1 the end (3').
  const linked = new Uint8Array(segmentCount * 2);
  for (let edge = 0; edge < graph.edgeSources.length; edge += 1) {
    if (graph.edgeKinds[edge] !== 0) continue;
    linked[graph.edgeSources[edge]! * 2 + (graph.edgeSourceReverse[edge] ? 0 : 1)] = 1;
    linked[graph.edgeTargets[edge]! * 2 + (graph.edgeTargetReverse[edge] ? 1 : 0)] = 1;
  }
  const open = new Uint8Array(pointOffsets[segmentCount]!);
  for (let segment = 0; segment < segmentCount; segment += 1) {
    if (!linked[segment * 2]) open[pointOffsets[segment]!] = 1;
    if (!linked[segment * 2 + 1]) open[pointOffsets[segment + 1]! - 1] = 1;
  }
  return open;
}

/** Segment-end graph (2 nodes per segment) with the layout's ideal lengths, as CSR. */
export interface EndGraph {
  readonly offsets: Uint32Array;
  readonly neighbours: Uint32Array;
  readonly lengths: Float64Array;
}

/** Node of the segment-end graph for a segment's first or last point. */
export function endNode(graph: PointGraph, point: number): number {
  const segment = graph.segmentOf[point]!;
  return point === graph.pointOffsets[segment] ? segment * 2 : segment * 2 + 1;
}

/** Collapses every segment's chain into one edge whose length is the sum of its ideal piece lengths. */
export function buildEndGraph(graph: PointGraph, padding: number): EndGraph {
  const { edgeA, edgeB, edgeLength, pointOffsets, segmentOf } = graph;
  const segmentCount = pointOffsets.length - 1;
  const chainEdges = graph.pointCount - segmentCount;
  const nodes = segmentCount * 2;
  const interior = new Float64Array(segmentCount);
  for (let edge = 0; edge < chainEdges; edge += 1) {
    const segment = segmentOf[edgeA[edge]!]!;
    interior[segment] = interior[segment]! + edgeLength[edge]! + padding;
  }
  const from: number[] = [];
  const to: number[] = [];
  const length: number[] = [];
  for (let segment = 0; segment < segmentCount; segment += 1) {
    from.push(segment * 2);
    to.push(segment * 2 + 1);
    length.push(interior[segment]!);
  }
  for (let edge = chainEdges; edge < edgeA.length; edge += 1) {
    const a = endNode(graph, edgeA[edge]!);
    const b = endNode(graph, edgeB[edge]!);
    if (a === b) continue;
    from.push(a);
    to.push(b);
    length.push(edgeLength[edge]! + padding);
  }
  const offsets = new Uint32Array(nodes + 1);
  for (let index = 0; index < from.length; index += 1) {
    offsets[from[index]! + 1] = offsets[from[index]! + 1]! + 1;
    offsets[to[index]! + 1] = offsets[to[index]! + 1]! + 1;
  }
  for (let node = 0; node < nodes; node += 1) offsets[node + 1] = offsets[node + 1]! + offsets[node]!;
  const neighbours = new Uint32Array(offsets[nodes]!);
  const lengths = new Float64Array(offsets[nodes]!);
  const fill = offsets.slice(0, nodes);
  for (let index = 0; index < from.length; index += 1) {
    const a = from[index]!;
    const b = to[index]!;
    lengths[fill[a]!] = length[index]!;
    neighbours[fill[a]!++] = b;
    lengths[fill[b]!] = length[index]!;
    neighbours[fill[b]!++] = a;
  }
  return { offsets, neighbours, lengths };
}

/** Single-source shortest paths that only reset the nodes they touched. */
export class Dijkstra {
  readonly distance: Float64Array;
  #touched: number[] = [];
  #heapNode = new Uint32Array(64);
  #heapKey = new Float64Array(64);

  constructor(readonly graph: EndGraph) {
    this.distance = new Float64Array(graph.offsets.length - 1).fill(Infinity);
  }

  run(source: number): void {
    const { distance } = this;
    for (const node of this.#touched) distance[node] = Infinity;
    this.#touched.length = 0;
    const { offsets, neighbours, lengths } = this.graph;
    let size = 0;
    const push = (node: number, key: number) => {
      if (size === this.#heapNode.length) {
        const nodes = new Uint32Array(size * 2);
        nodes.set(this.#heapNode);
        this.#heapNode = nodes;
        const keys = new Float64Array(size * 2);
        keys.set(this.#heapKey);
        this.#heapKey = keys;
      }
      const heapNode = this.#heapNode;
      const heapKey = this.#heapKey;
      let at = size++;
      while (at > 0) {
        const parent = (at - 1) >> 1;
        if (heapKey[parent]! <= key) break;
        heapNode[at] = heapNode[parent]!;
        heapKey[at] = heapKey[parent]!;
        at = parent;
      }
      heapNode[at] = node;
      heapKey[at] = key;
    };
    distance[source] = 0;
    this.#touched.push(source);
    push(source, 0);
    while (size > 0) {
      const heapNode = this.#heapNode;
      const heapKey = this.#heapKey;
      const node = heapNode[0]!;
      const key = heapKey[0]!;
      size -= 1;
      const lastNode = heapNode[size]!;
      const lastKey = heapKey[size]!;
      let at = 0;
      for (;;) {
        let child = at * 2 + 1;
        if (child >= size) break;
        if (child + 1 < size && heapKey[child + 1]! < heapKey[child]!) child += 1;
        if (heapKey[child]! >= lastKey) break;
        heapNode[at] = heapNode[child]!;
        heapKey[at] = heapKey[child]!;
        at = child;
      }
      heapNode[at] = lastNode;
      heapKey[at] = lastKey;
      if (key > distance[node]!) continue;
      for (let edge = offsets[node]!; edge < offsets[node + 1]!; edge += 1) {
        const neighbour = neighbours[edge]!;
        const next = key + lengths[edge]!;
        if (next < distance[neighbour]!) {
          if (distance[neighbour] === Infinity) this.#touched.push(neighbour);
          distance[neighbour] = next;
          push(neighbour, next);
        }
      }
    }
  }
}

/** Open-end repulsion of one component; `nodes` are the open ends' indices on the finest level. */
export class OpenEndRepulsion {
  private constructor(
    readonly nodes: Uint32Array,
    /** Indices into `nodes` of the partners every open end is repelled by. */
    readonly pivots: Uint32Array,
    /** Path length from pivot `p` to open end `i` at `p * nodes.length + i`. */
    readonly distances: Float64Array,
    /** Largest finite path length between a pivot and an open end. */
    readonly longest: number,
    readonly strength: number,
  ) {}

  /**
   * Computes path lengths from every pivot to every open end. `ends` are the open ends'
   * segment-end graph nodes; returns `undefined` with fewer than two reachable open ends.
   */
  static build(
    nodes: Uint32Array,
    ends: Uint32Array,
    dijkstra: Dijkstra,
    strength: number,
  ): OpenEndRepulsion | undefined {
    const count = nodes.length;
    if (count < 2 || !(strength > 0)) return undefined;
    const pivotCount = Math.min(count, MAX_PARTNERS);
    const pivots = new Uint32Array(pivotCount);
    const distances = new Float64Array(pivotCount * count);
    const nearest = new Float64Array(count).fill(Infinity);
    let next = 0;
    let longest = 0;
    for (let pivot = 0; pivot < pivotCount; pivot += 1) {
      pivots[pivot] = next;
      dijkstra.run(ends[next]!);
      nearest[next] = -1;
      let farthest = -1;
      for (let end = 0; end < count; end += 1) {
        const distance = dijkstra.distance[ends[end]!]!;
        distances[pivot * count + end] = distance;
        if (distance < Infinity) longest = Math.max(longest, distance);
        if (nearest[end]! >= 0) nearest[end] = Math.min(nearest[end]!, distance);
        // Farthest-point sampling; with every end a pivot this simply walks them in order.
        if (pivotCount < count) {
          if (nearest[end]! >= 0 && (farthest < 0 || nearest[end]! > nearest[farthest]!)) farthest = end;
        } else if (farthest < 0 && nearest[end]! >= 0) {
          farthest = end;
        }
      }
      if (farthest < 0) break;
      next = farthest;
    }
    if (!(longest > 0)) return undefined;
    return new OpenEndRepulsion(nodes, pivots, distances, longest, strength);
  }

  /**
   * Adds the repulsion to `fx`/`fy` (FMMM force units). `rep` maps finest-level nodes to the
   * current level; `scale` multiplies the strength (FMMM's reduced repulsion while fine tuning).
   */
  apply(
    xs: Float64Array,
    ys: Float64Array,
    fx: Float64Array,
    fy: Float64Array,
    rep: Uint32Array | undefined,
    meanIdeal: number,
    scale = 1,
  ): void {
    const { nodes, pivots, distances, longest } = this;
    const count = nodes.length;
    const factor = (this.strength * scale) / (longest * meanIdeal);
    for (let end = 0; end < count; end += 1) {
      const a = rep ? rep[nodes[end]!]! : nodes[end]!;
      const ax = xs[a]!;
      const ay = ys[a]!;
      let sumX = 0;
      let sumY = 0;
      let partners = 0;
      for (let pivot = 0; pivot < pivots.length; pivot += 1) {
        const other = pivots[pivot]!;
        if (other === end) continue;
        const g = distances[pivot * count + end]!;
        if (!(g < Infinity)) continue;
        const b = rep ? rep[nodes[other]!]! : nodes[other]!;
        if (a === b) continue;
        const dx = ax - xs[b]!;
        const dy = ay - ys[b]!;
        const d2 = dx * dx + dy * dy;
        if (d2 < 1e-12) continue;
        const weight = (g * g) / d2;
        sumX += dx * weight;
        sumY += dy * weight;
        partners += 1;
      }
      if (partners === 0) continue;
      // Pivots sample the other open ends: scale their sum up to all of them.
      const sample = (count - 1) / partners;
      fx[a] = fx[a]! + sumX * factor * sample;
      fy[a] = fy[a]! + sumY * factor * sample;
    }
  }
}
