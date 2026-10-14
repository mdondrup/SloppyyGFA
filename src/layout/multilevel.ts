import { attraction, dampingFactor, FORCE_SCALING, THETA } from "./fmmm";
import { LINK_LENGTH } from "./point-graph";
import type { QuadTree } from "./quadtree";

/*
 * Multilevel start of OGDF's FMMM as configured by BandageNG: the graph is coarsened by the
 * solar merger until at most `MIN_GRAPH_SIZE` nodes remain, the coarsest graph is placed (at
 * random, or from a seed layout), and every level is relaxed with FMMM forces before its layout
 * is prolonged to the next finer level (FMMM's advanced initial placement). Like FMMM, levels
 * are never rescaled in between. The finest level is left to the caller.
 */

/** FMMM `minGraphSize`. */
const MIN_GRAPH_SIZE = 50;
/** FMMM `randomTries`: candidates drawn per sun, the lightest wins (`NonUniformProbLowerMass`). */
const RANDOM_TRIES = 20;
/** FMMM `fixedIterations` at BandageNG layout quality 2. */
const FIXED_ITERATIONS = 30;
/** FMMM `maxIterFactor` with `LinearlyDecreasing` iterations from the coarsest level. */
const MAX_ITER_FACTOR = 10;
/**
 * FMMM `init_boxlength_and_cornercoordinate`: the coarsest level starts at random in a square
 * of side 1.1 * sum(max(node size, 10)), with BandageNG's `LINK_LENGTH` x `LINK_LENGTH` nodes.
 * That is far smaller than the coarse edges want, so the drawing starts compressed and
 * expands, which stretches chains outwards.
 */
const START_BOX_PER_NODE = 1.1 * Math.max(LINK_LENGTH, 10);

const SUN = 0;
const PLANET = 1;
const MOON = 2;

/** A level of the hierarchy in local node indices; `ideal` holds desired edge lengths. */
export interface Level {
  readonly n: number;
  readonly edgeA: Uint32Array;
  readonly edgeB: Uint32Array;
  readonly ideal: Float64Array;
  readonly mass: Float64Array;
}

/** Solar-merger links from a level to the next coarser one. */
interface Merge {
  /** Coarse node (solar system) of every fine node. */
  readonly sunOf: Uint32Array;
  readonly role: Uint8Array;
  readonly sunDistance: Float64Array;
  /** Planet of every moon, -1 otherwise. */
  readonly planetOf: Int32Array;
  /** Per fine node (CSR): position along each edge leaving its system, and the sun at the far end. */
  readonly lambdaOffsets: Uint32Array;
  readonly lambdaValue: Float64Array;
  readonly lambdaSun: Uint32Array;
  /** Fine nodes grouped by system (CSR). */
  readonly memberOffsets: Uint32Array;
  readonly members: Uint32Array;
}

/**
 * Adds forces (FMMM units, before `forceScale`) to the nodes of the current level. `rep` maps
 * every finest-level node to its node on this level (`undefined` on the finest level).
 */
export type ExtraForce = (
  xs: Float64Array,
  ys: Float64Array,
  fx: Float64Array,
  fy: Float64Array,
  rep: Uint32Array | undefined,
  meanIdeal: number,
) => void;

/** FMMM `get_max_mult_iter`: iterations at `level` of `maxLevel` for a level of `size` nodes. */
export function levelIterations(level: number, maxLevel: number, size: number): number {
  const iterations =
    maxLevel === 0
      ? FIXED_ITERATIONS * MAX_ITER_FACTOR
      : FIXED_ITERATIONS + Math.trunc((level / maxLevel) * (MAX_ITER_FACTOR - 1) * FIXED_ITERATIONS);
  return size <= 500 && iterations < 100 ? 100 : iterations;
}

export interface MultilevelResult {
  /** Positions of the finest-level nodes. */
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  /** Coarsening depth (0 when the graph is already small enough). */
  readonly maxLevel: number;
  /** Iterations FMMM would spend on the finest level. */
  readonly finestIterations: number;
}

/**
 * Places the finest level from its coarsened hierarchy. The coarsest level starts at the
 * centroids of `seed`'s finest-level positions, or at random as in OGDF without a seed.
 * `onWork` receives the node count of every relaxation iteration, for progress reporting.
 */
export function multilevelPlacement(
  finest: Level,
  random: () => number,
  quadTree: QuadTree,
  extra: ExtraForce | undefined,
  onWork: (work: number) => void,
  seed?: { readonly xs: Float64Array; readonly ys: Float64Array },
): MultilevelResult {
  const levels: Level[] = [finest];
  const merges: Merge[] = [];
  while (levels[levels.length - 1]!.n > MIN_GRAPH_SIZE) {
    const { coarse, merge } = coarsen(levels[levels.length - 1]!, random);
    if (coarse.n >= levels[levels.length - 1]!.n) break;
    levels.push(coarse);
    merges.push(merge);
  }
  const maxLevel = levels.length - 1;
  const coarsest = levels[maxLevel]!;
  let xs = new Float64Array(coarsest.n);
  let ys = new Float64Array(coarsest.n);
  if (seed) {
    // Each coarsest node starts at the centroid of the finest nodes it stands for.
    const rep = new Uint32Array(finest.n);
    for (let node = 0; node < finest.n; node += 1) rep[node] = node;
    for (const merge of merges) {
      for (let node = 0; node < finest.n; node += 1) rep[node] = merge.sunOf[rep[node]!]!;
    }
    const counts = new Float64Array(coarsest.n);
    for (let node = 0; node < finest.n; node += 1) {
      const coarse = rep[node]!;
      xs[coarse] = xs[coarse]! + seed.xs[node]!;
      ys[coarse] = ys[coarse]! + seed.ys[node]!;
      counts[coarse] = counts[coarse]! + 1;
    }
    for (let node = 0; node < coarsest.n; node += 1) {
      xs[node] = xs[node]! / counts[node]! + (random() - 0.5) * 1e-3;
      ys[node] = ys[node]! / counts[node]! + (random() - 0.5) * 1e-3;
    }
  } else {
    // OGDF: random positions in a square of side 1.1 * sum of the node sizes.
    const side = Math.ceil(START_BOX_PER_NODE * coarsest.n);
    for (let node = 0; node < coarsest.n; node += 1) {
      xs[node] = random() * side;
      ys[node] = random() * side;
    }
  }
  if (maxLevel === 0) {
    // Small graphs: FMMM relaxes the random placement itself before the constrained finest pass.
    relax(finest, xs, ys, levelIterations(0, 0, finest.n), quadTree, extra, undefined, onWork);
    return { xs, ys, maxLevel, finestIterations: levelIterations(0, 1, finest.n) };
  }

  // Finest-level node -> node on each coarser level, for forces defined on finest nodes.
  const reps: Uint32Array[] = [];
  if (extra) {
    let rep = new Uint32Array(finest.n);
    for (let node = 0; node < finest.n; node += 1) rep[node] = node;
    for (const merge of merges) {
      const next = new Uint32Array(finest.n);
      for (let node = 0; node < finest.n; node += 1) next[node] = merge.sunOf[rep[node]!]!;
      reps.push(next);
      rep = next;
    }
  }
  for (let level = maxLevel; level >= 1; level -= 1) {
    const graph = levels[level]!;
    relax(graph, xs, ys, levelIterations(level, maxLevel, graph.n), quadTree, extra, reps[level - 1], onWork);
    const finer = levels[level - 1]!;
    const fineXs = new Float64Array(finer.n);
    const fineYs = new Float64Array(finer.n);
    prolong(finer, merges[level - 1]!, xs, ys, fineXs, fineYs, random);
    xs = fineXs;
    ys = fineYs;
  }
  return { xs, ys, maxLevel, finestIterations: levelIterations(0, maxLevel, finest.n) };
}

function meanIdeal(level: Level): number {
  if (level.ideal.length === 0) return 1;
  let sum = 0;
  for (let edge = 0; edge < level.ideal.length; edge += 1) sum += level.ideal[edge]!;
  return sum / level.ideal.length;
}

function adjacency(level: Level): { offsets: Uint32Array; neighbours: Uint32Array; lengths: Float64Array } {
  const { n, edgeA, edgeB, ideal } = level;
  const offsets = new Uint32Array(n + 1);
  for (let edge = 0; edge < edgeA.length; edge += 1) {
    if (edgeA[edge] === edgeB[edge]) continue;
    offsets[edgeA[edge]! + 1] = offsets[edgeA[edge]! + 1]! + 1;
    offsets[edgeB[edge]! + 1] = offsets[edgeB[edge]! + 1]! + 1;
  }
  for (let node = 0; node < n; node += 1) offsets[node + 1] = offsets[node + 1]! + offsets[node]!;
  const neighbours = new Uint32Array(offsets[n]!);
  const lengths = new Float64Array(offsets[n]!);
  const fill = offsets.slice(0, n);
  for (let edge = 0; edge < edgeA.length; edge += 1) {
    const a = edgeA[edge]!;
    const b = edgeB[edge]!;
    if (a === b) continue;
    lengths[fill[a]!] = ideal[edge]!;
    neighbours[fill[a]!++] = b;
    lengths[fill[b]!] = ideal[edge]!;
    neighbours[fill[b]!++] = a;
  }
  return { offsets, neighbours, lengths };
}

/**
 * FMMM solar merger. Suns are drawn from the remaining candidates (the lightest of
 * `RANDOM_TRIES` random picks); their neighbours become planets and the planets' neighbours
 * stop being candidates, so suns are at least three edges apart. Every node left over is a
 * moon of its nearest neighbouring planet. Each solar system collapses into one coarse node;
 * an edge between systems becomes a coarse edge as long as the path between the two suns
 * (parallel edges are merged with their mean length).
 */
export function coarsen(level: Level, random: () => number): { coarse: Level; merge: Merge } {
  const { n, edgeA, edgeB, ideal, mass } = level;
  const { offsets, neighbours, lengths } = adjacency(level);
  const candidates = new Uint32Array(n);
  const slot = new Int32Array(n);
  for (let node = 0; node < n; node += 1) {
    candidates[node] = node;
    slot[node] = node;
  }
  let candidateCount = n;
  const remove = (node: number) => {
    const at = slot[node]!;
    if (at < 0) return;
    const last = candidates[--candidateCount]!;
    candidates[at] = last;
    slot[last] = at;
    slot[node] = -1;
  };

  const sunOf = new Uint32Array(n);
  const assigned = new Uint8Array(n);
  const role = new Uint8Array(n);
  const sunDistance = new Float64Array(n);
  const planetOf = new Int32Array(n).fill(-1);
  const suns: number[] = [];
  const planets: number[] = [];
  while (candidateCount > 0) {
    let sun = -1;
    for (let attempt = 0; attempt < RANDOM_TRIES; attempt += 1) {
      const pick = candidates[Math.floor(random() * candidateCount)]!;
      if (sun < 0 || mass[pick]! < mass[sun]!) sun = pick;
    }
    const system = suns.length;
    suns.push(sun);
    sunOf[sun] = system;
    assigned[sun] = 1;
    role[sun] = SUN;
    remove(sun);
    planets.length = 0;
    for (let edge = offsets[sun]!; edge < offsets[sun + 1]!; edge += 1) {
      const planet = neighbours[edge]!;
      if (!assigned[planet]) {
        assigned[planet] = 1;
        sunOf[planet] = system;
        role[planet] = PLANET;
        sunDistance[planet] = lengths[edge]!;
        remove(planet);
        planets.push(planet);
      } else if (role[planet] === PLANET && sunOf[planet] === system) {
        sunDistance[planet] = Math.min(sunDistance[planet]!, lengths[edge]!);
      }
    }
    for (const planet of planets) {
      for (let edge = offsets[planet]!; edge < offsets[planet + 1]!; edge += 1) remove(neighbours[edge]!);
    }
  }
  for (let node = 0; node < n; node += 1) {
    if (assigned[node]) continue;
    let best = -1;
    let bestLength = Infinity;
    for (let edge = offsets[node]!; edge < offsets[node + 1]!; edge += 1) {
      const neighbour = neighbours[edge]!;
      if (assigned[neighbour] && role[neighbour] === PLANET && lengths[edge]! < bestLength) {
        best = neighbour;
        bestLength = lengths[edge]!;
      }
    }
    // Unreachable for connected input: every non-candidate neighbours a sun or a planet.
    if (best < 0) throw new Error("Solar merger left a node without a planet.");
    sunOf[node] = sunOf[best]!;
    role[node] = MOON;
    planetOf[node] = best;
    sunDistance[node] = sunDistance[best]! + bestLength;
  }

  const coarseCount = suns.length;
  const coarseMass = new Float64Array(coarseCount);
  for (let node = 0; node < n; node += 1) coarseMass[sunOf[node]!] = coarseMass[sunOf[node]!]! + mass[node]!;

  const lambdaCount = new Uint32Array(n + 1);
  const pairIndex = new Map<number, number>();
  const pairA: number[] = [];
  const pairB: number[] = [];
  const pairSum: number[] = [];
  const pairCount: number[] = [];
  for (let edge = 0; edge < edgeA.length; edge += 1) {
    const a = edgeA[edge]!;
    const b = edgeB[edge]!;
    const systemA = sunOf[a]!;
    const systemB = sunOf[b]!;
    if (systemA === systemB) continue;
    lambdaCount[a + 1] = lambdaCount[a + 1]! + 1;
    lambdaCount[b + 1] = lambdaCount[b + 1]! + 1;
    const low = Math.min(systemA, systemB);
    const high = Math.max(systemA, systemB);
    const key = low * coarseCount + high;
    const length = sunDistance[a]! + ideal[edge]! + sunDistance[b]!;
    const index = pairIndex.get(key);
    if (index === undefined) {
      pairIndex.set(key, pairA.length);
      pairA.push(low);
      pairB.push(high);
      pairSum.push(length);
      pairCount.push(1);
    } else {
      pairSum[index] = pairSum[index]! + length;
      pairCount[index] = pairCount[index]! + 1;
    }
  }
  for (let node = 0; node < n; node += 1) lambdaCount[node + 1] = lambdaCount[node + 1]! + lambdaCount[node]!;
  const lambdaOffsets = lambdaCount;
  const lambdaValue = new Float64Array(lambdaOffsets[n]!);
  const lambdaSun = new Uint32Array(lambdaOffsets[n]!);
  const fill = lambdaOffsets.slice(0, n);
  for (let edge = 0; edge < edgeA.length; edge += 1) {
    const a = edgeA[edge]!;
    const b = edgeB[edge]!;
    if (sunOf[a] === sunOf[b]) continue;
    const length = sunDistance[a]! + ideal[edge]! + sunDistance[b]!;
    lambdaValue[fill[a]!] = sunDistance[a]! / length;
    lambdaSun[fill[a]!++] = sunOf[b]!;
    lambdaValue[fill[b]!] = sunDistance[b]! / length;
    lambdaSun[fill[b]!++] = sunOf[a]!;
  }

  const memberOffsets = new Uint32Array(coarseCount + 1);
  for (let node = 0; node < n; node += 1) memberOffsets[sunOf[node]! + 1] = memberOffsets[sunOf[node]! + 1]! + 1;
  for (let system = 0; system < coarseCount; system += 1) memberOffsets[system + 1] = memberOffsets[system + 1]! + memberOffsets[system]!;
  const members = new Uint32Array(n);
  const memberFill = memberOffsets.slice(0, coarseCount);
  // Suns first, then planets, then moons, so placement can rely on that order.
  for (const wanted of [SUN, PLANET, MOON]) {
    for (let node = 0; node < n; node += 1) {
      if (role[node] === wanted) members[memberFill[sunOf[node]!]!++] = node;
    }
  }

  const coarse: Level = {
    n: coarseCount,
    edgeA: Uint32Array.from(pairA),
    edgeB: Uint32Array.from(pairB),
    ideal: Float64Array.from(pairSum, (sum, index) => sum / pairCount[index]!),
    mass: coarseMass,
  };
  return {
    coarse,
    merge: { sunOf, role, sunDistance, planetOf, lambdaOffsets, lambdaValue, lambdaSun, memberOffsets, members },
  };
}

/** Plain FMMM iterations (no curve constraint) on one level. */
export function relax(
  level: Level,
  xs: Float64Array,
  ys: Float64Array,
  iterations: number,
  quadTree: QuadTree,
  extra: ExtraForce | undefined,
  rep: Uint32Array | undefined,
  onWork: (work: number) => void,
): void {
  const { n, edgeA, edgeB, ideal } = level;
  if (n < 2) return;
  const mean = meanIdeal(level);
  const forceScale = mean * mean;
  const theta2 = THETA * THETA;
  const fx = new Float64Array(n);
  const fy = new Float64Array(n);
  const lastX = new Float64Array(n);
  const lastY = new Float64Array(n);
  const force = new Float64Array(2);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let node = 0; node < n; node += 1) {
      minX = Math.min(minX, xs[node]!);
      maxX = Math.max(maxX, xs[node]!);
      minY = Math.min(minY, ys[node]!);
      maxY = Math.max(maxY, ys[node]!);
    }
    const boxLength = Math.max(maxX - minX, maxY - minY) * 1.01 + 2;
    const maxRadius = iteration === 0 ? boxLength / 1000 : boxLength / 5;
    quadTree.build(xs, ys, n);
    for (let node = 0; node < n; node += 1) {
      force[0] = 0;
      force[1] = 0;
      quadTree.repulse(node, xs[node]!, ys[node]!, theta2, 1, force);
      fx[node] = force[0];
      fy[node] = force[1];
    }
    for (let edge = 0; edge < edgeA.length; edge += 1) {
      const a = edgeA[edge]!;
      const b = edgeB[edge]!;
      const ex = xs[b]! - xs[a]!;
      const ey = ys[b]! - ys[a]!;
      const length = Math.sqrt(ex * ex + ey * ey);
      if (length < 1e-9) continue;
      const pull = attraction(length, ideal[edge]!);
      fx[a] = fx[a]! + ex * pull;
      fy[a] = fy[a]! + ey * pull;
      fx[b] = fx[b]! - ex * pull;
      fy[b] = fy[b]! - ey * pull;
    }
    extra?.(xs, ys, fx, fy, rep, mean);
    for (let node = 0; node < n; node += 1) {
      let moveX = fx[node]! * forceScale;
      let moveY = fy[node]! * forceScale;
      const norm = Math.sqrt(moveX * moveX + moveY * moveY);
      if (norm === 0) {
        lastX[node] = 0;
        lastY[node] = 0;
        continue;
      }
      const factor = Math.min(norm * FORCE_SCALING, maxRadius) / norm;
      moveX *= factor;
      moveY *= factor;
      if (iteration > 0) {
        const damping = dampingFactor(lastX[node]!, lastY[node]!, moveX, moveY);
        moveX *= damping;
        moveY *= damping;
      }
      lastX[node] = moveX;
      lastY[node] = moveY;
      xs[node] = xs[node]! + moveX;
      ys[node] = ys[node]! + moveY;
    }
    onWork(n);
  }
}

/** FMMM `adapt_drawing_to_ideal_average_edgelength`, about the centroid. */
export function rescale(level: Level, xs: Float64Array, ys: Float64Array): void {
  const { n, edgeA, edgeB, ideal } = level;
  let real = 0;
  let wanted = 0;
  for (let edge = 0; edge < edgeA.length; edge += 1) {
    real += Math.hypot(xs[edgeB[edge]!]! - xs[edgeA[edge]!]!, ys[edgeB[edge]!]! - ys[edgeA[edge]!]!);
    wanted += ideal[edge]!;
  }
  if (real === 0 || n === 0) return;
  const factor = wanted / real;
  let centerX = 0;
  let centerY = 0;
  for (let node = 0; node < n; node += 1) {
    centerX += xs[node]!;
    centerY += ys[node]!;
  }
  centerX /= n;
  centerY /= n;
  for (let node = 0; node < n; node += 1) {
    xs[node] = centerX + (xs[node]! - centerX) * factor;
    ys[node] = centerY + (ys[node]! - centerY) * factor;
  }
}

/**
 * FMMM's advanced initial placement of a finer level. Suns take their system's position.
 * A planet or moon with edges to other systems sits at the mean of the points dividing each
 * such sun-to-sun line in the ratio of its distance to its sun. Planets without such edges
 * point from the sun towards their placed moons, or else fill the largest angular gap around
 * the sun; moons without such edges continue outward from their planet.
 */
export function prolong(
  fine: Level,
  merge: Merge,
  coarseXs: Float64Array,
  coarseYs: Float64Array,
  xs: Float64Array,
  ys: Float64Array,
  random: () => number,
): void {
  const { sunOf, role, sunDistance, planetOf, lambdaOffsets, lambdaValue, lambdaSun, memberOffsets, members } = merge;
  const placed = new Uint8Array(fine.n);
  for (let node = 0; node < fine.n; node += 1) {
    const system = sunOf[node]!;
    const sunX = coarseXs[system]!;
    const sunY = coarseYs[system]!;
    if (role[node] === SUN) {
      xs[node] = sunX;
      ys[node] = sunY;
      placed[node] = 1;
      continue;
    }
    const begin = lambdaOffsets[node]!;
    const end = lambdaOffsets[node + 1]!;
    if (end === begin) continue;
    let x = 0;
    let y = 0;
    for (let cursor = begin; cursor < end; cursor += 1) {
      const other = lambdaSun[cursor]!;
      const lambda = lambdaValue[cursor]!;
      x += sunX + lambda * (coarseXs[other]! - sunX);
      y += sunY + lambda * (coarseYs[other]! - sunY);
    }
    xs[node] = x / (end - begin);
    ys[node] = y / (end - begin);
    placed[node] = 1;
  }

  const moonSumX = new Float64Array(fine.n);
  const moonSumY = new Float64Array(fine.n);
  const moonCount = new Uint32Array(fine.n);
  for (let node = 0; node < fine.n; node += 1) {
    const planet = planetOf[node]!;
    if (planet < 0 || !placed[node]) continue;
    moonSumX[planet] = moonSumX[planet]! + xs[node]!;
    moonSumY[planet] = moonSumY[planet]! + ys[node]!;
    moonCount[planet] = moonCount[planet]! + 1;
  }
  const angles: number[] = [];
  const gapPlanets: number[] = [];
  for (let system = 0; system < memberOffsets.length - 1; system += 1) {
    const sunX = coarseXs[system]!;
    const sunY = coarseYs[system]!;
    angles.length = 0;
    gapPlanets.length = 0;
    for (let cursor = memberOffsets[system]!; cursor < memberOffsets[system + 1]!; cursor += 1) {
      const node = members[cursor]!;
      if (role[node] !== PLANET) continue;
      if (!placed[node] && moonCount[node]! > 0) {
        const dx = moonSumX[node]! / moonCount[node]! - sunX;
        const dy = moonSumY[node]! / moonCount[node]! - sunY;
        const norm = Math.hypot(dx, dy);
        if (norm > 1e-9) {
          xs[node] = sunX + (dx / norm) * sunDistance[node]!;
          ys[node] = sunY + (dy / norm) * sunDistance[node]!;
          placed[node] = 1;
        }
      }
      if (placed[node]) {
        const dx = xs[node]! - sunX;
        const dy = ys[node]! - sunY;
        if (dx * dx + dy * dy > 1e-12) angles.push(Math.atan2(dy, dx));
      } else {
        gapPlanets.push(node);
      }
    }
    if (gapPlanets.length === 0) continue;
    let gapStart = random() * 2 * Math.PI;
    let gapSize = 2 * Math.PI;
    if (angles.length > 0) {
      angles.sort((a, b) => a - b);
      gapSize = angles[0]! + 2 * Math.PI - angles[angles.length - 1]!;
      gapStart = angles[angles.length - 1]!;
      for (let index = 1; index < angles.length; index += 1) {
        if (angles[index]! - angles[index - 1]! > gapSize) {
          gapSize = angles[index]! - angles[index - 1]!;
          gapStart = angles[index - 1]!;
        }
      }
    }
    for (let index = 0; index < gapPlanets.length; index += 1) {
      const node = gapPlanets[index]!;
      const angle = gapStart + (gapSize * (index + 1)) / (gapPlanets.length + 1);
      xs[node] = sunX + Math.cos(angle) * sunDistance[node]!;
      ys[node] = sunY + Math.sin(angle) * sunDistance[node]!;
      placed[node] = 1;
    }
  }

  for (let node = 0; node < fine.n; node += 1) {
    if (placed[node]) continue;
    const planet = planetOf[node]!;
    const system = sunOf[node]!;
    let dx = xs[planet]! - coarseXs[system]!;
    let dy = ys[planet]! - coarseYs[system]!;
    let norm = Math.hypot(dx, dy);
    if (norm < 1e-9) {
      const angle = random() * 2 * Math.PI;
      dx = Math.cos(angle);
      dy = Math.sin(angle);
      norm = 1;
    }
    const reach = sunDistance[node]! - sunDistance[planet]!;
    xs[node] = xs[planet]! + (dx / norm) * reach;
    ys[node] = ys[planet]! + (dy / norm) * reach;
  }

  const jitter = 1e-3 * meanIdeal(fine);
  for (let node = 0; node < fine.n; node += 1) {
    if (role[node] === SUN) continue;
    xs[node] = xs[node]! + ((random() - 0.5) * jitter);
    ys[node] = ys[node]! + ((random() - 0.5) * jitter);
  }
}
