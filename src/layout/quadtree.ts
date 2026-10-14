const EMPTY = 0;
const LEAF = 1;
const INTERNAL = 2;
/** Leaf at maximum depth holding several (near-)coincident bodies. */
const BUCKET = 3;
const MAX_DEPTH = 40;

/**
 * Array-backed Barnes-Hut quadtree. Reused across iterations to avoid per-frame allocation.
 */
export class QuadTree {
  kind = new Uint8Array(0);
  body = new Int32Array(0);
  children = new Int32Array(0);
  mass = new Float64Array(0);
  sumX = new Float64Array(0);
  sumY = new Float64Array(0);
  cellX = new Float64Array(0);
  cellY = new Float64Array(0);
  cellSize = new Float64Array(0);
  count = 0;
  readonly #stack = new Int32Array(4 * MAX_DEPTH + 8);

  constructor(capacity = 1024) {
    this.#allocate(Math.max(16, capacity));
  }

  build(xs: Float64Array, ys: Float64Array, n: number): void {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let index = 0; index < n; index += 1) {
      minX = Math.min(minX, xs[index]!);
      maxX = Math.max(maxX, xs[index]!);
      minY = Math.min(minY, ys[index]!);
      maxY = Math.max(maxY, ys[index]!);
    }
    const size = Math.max(maxX - minX, maxY - minY, 1e-6) * 1.0001;
    this.count = 0;
    this.#newNode(minX, minY, size);
    for (let index = 0; index < n; index += 1) this.#insert(index, xs, ys);
  }

  /** Accumulates FMMM's `strength * mass / distance` repulsion on body `index` into `out`. */
  repulse(
    index: number,
    px: number,
    py: number,
    theta2: number,
    strength: number,
    out: Float64Array,
  ): void {
    const stack = this.#stack;
    const { kind, body, children, mass, sumX, sumY, cellSize } = this;
    let pointer = 0;
    let fx = 0;
    let fy = 0;
    stack[pointer++] = 0;
    while (pointer > 0) {
      const node = stack[--pointer]!;
      const nodeMass = mass[node]!;
      if (nodeMass === 0) continue;
      const nodeKind = kind[node]!;
      if (nodeKind === LEAF && body[node] === index) continue;
      const dx = px - sumX[node]! / nodeMass;
      const dy = py - sumY[node]! / nodeMass;
      const distanceSquared = dx * dx + dy * dy;
      const size = cellSize[node]!;
      if (nodeKind === INTERNAL && size * size > theta2 * distanceSquared) {
        for (let quadrant = 0; quadrant < 4; quadrant += 1) {
          const child = children[node * 4 + quadrant]!;
          if (child >= 0) stack[pointer++] = child;
        }
        continue;
      }
      if (distanceSquared < 1e-6) continue;
      const force = (strength * nodeMass) / distanceSquared;
      fx += dx * force;
      fy += dy * force;
    }
    out[0] = out[0]! + fx;
    out[1] = out[1]! + fy;
  }

  #insert(index: number, xs: Float64Array, ys: Float64Array): void {
    const px = xs[index]!;
    const py = ys[index]!;
    let node = 0;
    let depth = 0;
    for (;;) {
      const nodeKind = this.kind[node]!;
      if (nodeKind === EMPTY) {
        this.kind[node] = LEAF;
        this.body[node] = index;
        this.#addMass(node, px, py);
        return;
      }
      if (nodeKind === BUCKET) {
        this.#addMass(node, px, py);
        return;
      }
      if (nodeKind === LEAF) {
        if (depth >= MAX_DEPTH) {
          this.kind[node] = BUCKET;
          this.#addMass(node, px, py);
          return;
        }
        const other = this.body[node]!;
        this.kind[node] = INTERNAL;
        this.body[node] = -1;
        const child = this.#child(node, xs[other]!, ys[other]!);
        this.kind[child] = LEAF;
        this.body[child] = other;
        this.#addMass(child, xs[other]!, ys[other]!);
      }
      this.#addMass(node, px, py);
      node = this.#child(node, px, py);
      depth += 1;
    }
  }

  #child(node: number, px: number, py: number): number {
    const half = this.cellSize[node]! / 2;
    const right = px >= this.cellX[node]! + half ? 1 : 0;
    const top = py >= this.cellY[node]! + half ? 1 : 0;
    const slot = node * 4 + right + top * 2;
    let child = this.children[slot]!;
    if (child < 0) {
      child = this.#newNode(
        this.cellX[node]! + right * half,
        this.cellY[node]! + top * half,
        half,
      );
      this.children[slot] = child;
    }
    return child;
  }

  #addMass(node: number, px: number, py: number): void {
    this.mass[node] = this.mass[node]! + 1;
    this.sumX[node] = this.sumX[node]! + px;
    this.sumY[node] = this.sumY[node]! + py;
  }

  #newNode(x: number, y: number, size: number): number {
    if (this.count >= this.kind.length) this.#allocate(this.kind.length * 2);
    const node = this.count++;
    this.kind[node] = EMPTY;
    this.body[node] = -1;
    this.children.fill(-1, node * 4, node * 4 + 4);
    this.mass[node] = 0;
    this.sumX[node] = 0;
    this.sumY[node] = 0;
    this.cellX[node] = x;
    this.cellY[node] = y;
    this.cellSize[node] = size;
    return node;
  }

  #allocate(capacity: number): void {
    const grow = <T extends Uint8Array | Int32Array | Float64Array>(old: T, next: T): T => {
      next.set(old);
      return next;
    };
    this.kind = grow(this.kind, new Uint8Array(capacity));
    this.body = grow(this.body, new Int32Array(capacity));
    this.children = grow(this.children, new Int32Array(capacity * 4));
    this.mass = grow(this.mass, new Float64Array(capacity));
    this.sumX = grow(this.sumX, new Float64Array(capacity));
    this.sumY = grow(this.sumY, new Float64Array(capacity));
    this.cellX = grow(this.cellX, new Float64Array(capacity));
    this.cellY = grow(this.cellY, new Float64Array(capacity));
    this.cellSize = grow(this.cellSize, new Float64Array(capacity));
  }
}
