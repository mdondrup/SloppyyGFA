# SloppyyGFA

A local-first, GPU-accelerated genome assembly graph viewer that runs entirely in modern
web browsers. GFA files never leave the user's device.

Try it at <https://mdondrup.github.io/SloppyyGFA/>.

## Current capabilities

- Streaming GFA 1.x parser in a Web Worker, including `S`, `L`, and `J` records
- Compact typed arrays for lengths, edge indexes, sequence locations, and render positions
- WebGL 2 renderer that draws Bandage-style segments: colored ribbons whose drawn length
  scales linearly with sequence length and whose width scales with read depth, using
  BandageNG's default parameters (see [Bandage parameters](#bandage-parameters))
- Each segment is a single quadratic Bézier curve (at most one handle point), joined by
  cubic links that leave and enter segments along their tangents; the force layout
  penalises curvature so linear stretches stay straight (see [Bézier segments](#bézier-segments))
- Optional log2 segment-length scaling, which compresses long contigs
- Read depth from `DP`, `dp`, `ka`, `rd`, or `KC`/`RC`/`FC` tags, shown in the selection panel
- Orientation-aware links: `+` leaves a segment at its end (3') and `-` at its start (5')
- Configurable jump (`J`) links: dashed and ignored by layout (default), dashed and used in
  layout, or hidden
- Pan, wheel zoom, fit-to-screen, segment search, and mouse selection
- Graph statistics (segments, links, jumps, total length, longest segment, and N50)
- Selectable force-directed (default), radial (star), hierarchical, and spiral layouts
  computed in a Web Worker; the force layout starts from FMMM's multilevel placement,
  pushes open segment ends apart to stretch assemblies along their longest paths, and
  centres highly connected hubs in their tangles
- Lazy sequence reads from the original browser `File`
- Responsive, accessible dark-mode interface with file picker and drag-and-drop

## Development

Requires a current Node.js LTS release.

```sh
npm install
npm run dev
```

Run the checks:

```sh
npm test
npm run build
```

## Deployment

The build in `dist/` is a static site, so any static web server can host it. Asset URLs are
relative (`base: "./"` in `vite.config.ts`), so it also works from a sub-path. It needs no
special response headers.

Every push to `main` deploys it to GitHub Pages through
`.github/workflows/pages.yml`, which installs dependencies, runs the tests, builds, and
publishes `dist/`. The repository's Pages source must be set to "GitHub Actions"
(Settings → Pages).

## Architecture

The parsing and rendering paths have no direct dependency on one another:

- `src/parser/` converts GFA bytes into the render-neutral graph structure.
- `src/layout/` computes positions from graph topology only. `point-graph.ts` turns each
  segment into a chain of points; `quadtree.ts` provides Barnes–Hut repulsion;
  `fmmm.ts` holds the shared FMMM force constants; `multilevel.ts` coarsens and places
  components level by level; `open-ends.ts` computes open-end repulsion; `curves.ts` fits,
  tessellates, and links the segments' Bézier curves.
- `src/workers/` keeps parsing, indexing, and layout off the UI thread.
- `src/model/` defines the typed-array transfer format.
- `src/storage/` resolves indexed sequence ranges only when requested.
- `src/render/` uploads graph geometry to WebGL and owns viewport interaction.
- `src/main.ts` is the UI integration layer.

The parser scans `Blob` chunks as bytes rather than splitting the entire file into strings.
Only segment IDs and graph structure remain in memory. Segment sequences are represented by
byte offset and byte length, then read with `File.slice()` when selected. Browser `File`
objects are commonly backed by the source file rather than a JavaScript heap copy, making
this the fastest portable baseline across Chrome, Safari, and Firefox.

For reopening files across sessions, the next storage tier is the Origin Private File System
(OPFS). OPFS offers fast random access in workers but requires copying the imported GFA into
site-managed storage and has differing quota/eviction behavior. IndexedDB is more portable
for small metadata but is a poor fit for multi-gigabyte sequence blobs. The current direct
`File` index avoids that import copy and preserves the application's local-only model.

## Layouts

Layouts run in a dedicated worker. Changing a layout does not parse the file again.

Every layout works on a *point graph*: each segment is a chain of points, one per 20 drawn
units, from its start to its end, so long contigs get many layout points. Links connect the
orientation-specific segment ends. Jump (`J`) links are left out of the layout unless the
**Jump links** setting is "Dashed, used in layout", as in Bandage.

- **Force-directed (default):** places each component with FMMM's multilevel start, then
  refines it with the force model of OGDF's FMMM, the solver Bandage uses (see
  [FMMM force model](#fmmm-force-model) and [Multilevel start](#multilevel-start)).
  Repulsion is computed with a Barnes–Hut tree (O(n log n) per iteration). Each component is
  then rotated to its smallest bounding box and laid flat, as in Bandage. Deterministic for
  the same input. With the defaults, about 0.3 s for the 959-segment plant sample and 10 s
  for the 103k-segment stool sample on an idle machine.

  The **Start (force)** setting chooses the initial placement: "Multilevel, tree seed"
  (default), "Multilevel, random (OGDF)" as in Bandage, or "Radial seed", the radial layout
  without coarsening (0.65 s on plant).

  The **Open-end repulsion (force)** setting ("Off", "Weak", "Medium" (default), "Strong")
  pushes the open ends of each component apart in proportion to the square of their path
  length through the graph, which stretches assemblies along their longest paths (see
  [Open-end repulsion](#open-end-repulsion)).

  The **Segment curves (force)** setting controls how strongly segments resist bending
  (see [Bézier segments](#bézier-segments)): "Balanced" (default), "Flexible", "Stiff", or
  "Straight", which draws every segment as a straight line.

  The **Connectivity (force)** setting defaults to "Hubs centred in tangles". Each
  iteration pulls every segment linked to three or more distinct segments towards the
  centroid of those neighbours, with strength growing with degree (`1 − 2/degree`). An equal
  and opposite force is shared among the neighbours, so the tangle closes around its hub
  rather than drifting. On the plant and stool samples, this reduces hubs' mean offset from
  their two-hop neighbourhood centre by roughly 20–30% at no measurable time cost.
  "Uniform" disables the extra force and leaves the plain FMMM model.
- **Radial (star):** each connected component is arranged around a root segment. Rings show
  graph distance from the root, and each subtree gets an angular wedge proportional to its
  leaf count.
- **Hierarchical:** uses the same spanning tree but draws it top-down. Each layer is one BFS
  step from the root, and each subtree gets a horizontal slice proportional to its leaf count.
- **Spiral:** a topology-independent golden-angle spiral of segments, useful as a fast
  overview.

Assembly graphs are usually cyclic and bidirected, so the radial and hierarchical layouts
use a BFS spanning tree weighted by drawn segment length. Edges in that tree never cross; other edges are still drawn. By
default, each component is rooted at its highest-degree segment. **Root at selection**
re-roots the selected segment's component. Both tree layouts run in O(segments + edges).

Every layout keeps its natural size. Components are shelf-packed into a roughly square
block in order of total sequence length, so the largest component is at the top left and
none overlap; neither the layout nor the packing depends on
the browser window. The drawing lives in an unbounded world coordinate space that grows with
the graph, and the viewport-sized WebGL canvas pans and zooms over it (GPUs cap a canvas'
pixel size, so the canvas itself is never enlarged to fit the graph).

### Bandage parameters

Defaults are taken from the BandageNG sources (`program/settings.cpp`,
`graph/assemblygraph.cpp`, `graph/graphicsitemnode.cpp`, `layout/graphlayoutworker.cpp`):

| Bandage setting | Value | Effect here |
| --- | --- | --- |
| Automatic length per Mb | `max(40 · segments, 500) / total Mb` | Linear drawn segment length |
| `minimumNodeLength` | 5 | Shortest drawn segment |
| `nodeSegmentLength` | 20 | One layout point per 20 units |
| `edgeLength` | 5 | Link rest length and layout node size (see below) |
| `componentSeparation` | 50 | Gap between packed components |
| `averageNodeWidth` | 5 | Ribbon width at mean depth |
| `depthPower` / `depthEffectOnWidth` | 0.5 / 0.5 | `width = 5 · ((d / mean)^0.5 − 1) · 0.5 + 5` |
| Component rotation steps | 50 | Smallest bounding box, wider than tall |
| Page ratio | Not used | Components pack into a square block at natural size |

The **Segment length** setting switches between Bandage's linear scale and a log2 scale.
Log2 draws each segment in proportion to `log2(1 + bp)`, auto-scaled to the same total
length, and uses a minimum of 5. A 1 Mb contig is then drawn only twice as long as a 1 kb
contig. With fewer layout points, the stool sample's force layout takes about 3 s instead of 6.5 s.

Mean depth is length-weighted, as in Bandage. Links are drawn as 1 px cubic curves, not
Bandage's 0.5 width.

### FMMM force model

Bandage lays out components with OGDF's `FMMMLayout` (`layout/graphlayoutworker.cpp`,
layout quality 2). The force layout here reproduces its force model and post-processing,
taken from `src/ogdf/energybased/FMMMLayout.cpp`:

| FMMM element | Value | Notes |
| --- | --- | --- |
| Repulsion between all points | `1 / d` | Long-range, so sub-tangles push each other apart |
| Attraction along each edge | `log2(d / l) · d² / l³` | Zero at the ideal length `l`, repulsive below it |
| Ideal edge length | nominal + 7.07 | `EdgeLengthMeasurement::BoundingCircle` adds two radii of Bandage's 5 × 5 layout nodes, so pieces are 27.07 and links 12.07 |
| Force scaling | `l̄² · 0.05` | `forceScalingFactor` times the mean ideal length squared |
| Step limit | box / 5 (box / 1000 first) | `max_radius` |
| Oscillation damping | 2, 2, 1.5, 1, ⅔, ½, ⅓ | Allowed step growth per 30° turn between successive moves |
| Post-processing | 10 iterations at 0.1, rescale, 20 at 0.2 (last 5 at 0.02) | Fine tuning uses 2× springs and `min(0.2, 400 / n)` repulsion; rescaling sets the mean edge length to the ideal |

Checked against BandageNG's own output (`BandageNG layout`): for two linked 100 kb contigs
both draw pieces at 1.15–1.5× their nominal length and links at about 12 units; on the
plant sample both give a median link length of 12, a median piece length of 19–20, and
median contig straightness of 0.98–1.0.

Bandage reseeds from the clock on every run, so its layouts differ from run to run; this one
uses a fixed seed and is deterministic.

### Multilevel start

FMMM does not start from a finished layout. It coarsens the graph, places the coarsest
level, and relaxes every level before prolonging it to the next finer one. `multilevel.ts`
follows `src/ogdf/energybased/fmmm/`:

| FMMM element | Value | Notes |
| --- | --- | --- |
| Coarsening | Solar merger | Light suns at least three edges apart; their neighbours become planets, the rest moons. Each solar system becomes one node with the summed mass; coarse edges keep the sun-to-sun path length |
| Coarsest level | At most 50 nodes | `MIN_GRAPH_SIZE` |
| Iterations per level | 30 → 300, linearly with depth, at least 100 below 500 nodes | `fixedIterations` 30, `maxIterFactor` 10 |
| Coarsest placement (OGDF) | Random in a square of side `1.1 · 10 · n` | Much smaller than the coarse edges want, so the drawing starts compressed and expands |
| Prolongation | Suns at their system's position; planets and moons on the lines to neighbouring suns, in the ratio of their distance to their own sun | Advanced initial placement |
| Rescaling | None between levels or before the finest level | Only post-processing rescales |

Rescaling before the finest level, as an earlier version did, collapsed the prolonged
drawing to half its size (radius of gyration 1,215 instead of about 1,900 on plant).

From random positions, FMMM often folds plain chains in two: in tests, a chain of 40
segments spans only 42% of its drawn length, and one of six 5 kb contigs only 25%. The
default "Multilevel, tree seed" therefore starts each coarse node at the centroid of its
members in the radial tree layout. This is a hybrid of my own, not in OGDF. Every test chain
then stays straight (span 100% of length), and large tangles still expand like Bandage's.
"Multilevel, random (OGDF)" keeps the faithful random start.

### Open-end repulsion

An open end is a segment end without an `L` link; `J` links are ignored. Within a
component, every open end repels every other one with FMMM's `1 / d` repulsion, weighted
by the square of their shortest path length `g` through the graph:

`F = τ · g² / (G · l̄ · d)`

Here `G` is the component's longest open-end path, `l̄` the mean ideal edge length, and `τ`
the strength: Off 0, Weak 0.3, Medium 1 (default), Strong 3. The two ends of a fully
stretched chain (`d = g = G`) feel `τ / l̄`, the same as one FMMM repulsion at the ideal
edge length, whatever the component's size. Ends close in the graph barely interact, and
the ends of long paths are pulled taut. Path lengths come from Dijkstra on a segment-end
graph that uses the layout's ideal lengths. Components with more than 256 open ends use 256
farthest-point pivots, scaled up to the full count. The force applies on every multilevel
level. On the stool sample it adds about 15% to the layout time.

Plant sample, largest component, compared with BandageNG's own layout. Spread is the
radius of gyration over the square root of drawn length. Stretch is the median
straight-line over path distance between far-apart open ends.

| Layout | Spread | Stretch |
| --- | --- | --- |
| BandageNG | 10.83 | 0.933 |
| Radial seed, open ends off (previous default) | 3.73 | 0.632 |
| Multilevel, random (OGDF), open ends off | 8.76 | 0.870 |
| Multilevel, tree seed, open ends off | 8.74 | 0.865 |
| Multilevel, tree seed, Weak | 9.49 | 0.884 |
| **Multilevel, tree seed, Medium (default)** | **10.52** | **0.896** |
| Multilevel, random (OGDF), Medium | 10.48 | 0.901 |
| Multilevel, tree seed, Strong | 11.72 | 0.907 |

Chains, as span over drawn length:

| Start | 10 × 1 kb | 6 × 5 kb | 40 × 1 kb | 100 × 300 bp |
| --- | --- | --- | --- | --- |
| Radial seed | 1.00 | 1.00 | 0.89 | 0.70 |
| Multilevel, random (OGDF) | 0.61 | 0.25 | 0.42 | 0.54 |
| Multilevel, random, Strong open ends | 0.87 | 0.77 | 0.78 | 0.87 |
| Multilevel, tree seed (any open-end setting) | 1.00 | 1.00 | 1.00 | 1.00 |

### Bézier segments

Bandage draws most segments as smooth single curves, which makes long linear stretches easy
to follow as contigs. Here every segment's points are constrained to one quadratic Bézier
curve

`B(t) = (1 − t)² P0 + 2t(1 − t) P1 + t² P2`, with handle `P1 = (P0 + P2) / 2 + H`,

where the points sit at equal `t` steps. After each force iteration the proposed point
moves are projected onto the closest such curve (least squares over `P0`, `P2`, and `H`), so
FMMM forces can only stretch, rotate, or arc a segment, never kink it. The handle offset
`H` is then soft-thresholded, which regularises the extra degree of freedom:

| Term | Cost (per point, in FMMM force units) | Effect |
| --- | --- | --- |
| Any handle at all | `HANDLE_COST = 0.05` | Segments are straight unless the graph pulls them into an arc |
| Curvature | `CURVATURE_COST · tan²(β / 2)`, `CURVATURE_COST = 2` | `β` is the total turn between the end tangents; gentle arcs are cheap and hairpins prohibitive |

Both costs are multiplied by the **Segment curves (force)** stiffness: Balanced 1,
Flexible 0.25, Stiff 4, and Straight ∞ (no handle). In a tangle of eight segments with
chords, the summed turn falls from 690° at stiffness 0 to 200° at 1, 35° at 4, and 0° when
straight; a chain of contigs stays straight at every setting.

On the plant sample, compared with BandageNG's own layout and with the earlier unconstrained
point-chain solver:

| Layout | Total turn per long segment, p75 / p90 | Kinks over 30° between layout points | Largest clusters (segments) |
| --- | --- | --- | --- |
| BandageNG | 25° / 58° | 15 | 326, 221, 177 |
| Point chains | 136° / 211° | 120 | 776 (one fused tangle) |
| Bézier (Balanced) | 16° / 34° | 0 | 544, 221 |

Hub centring still works on top of the curves: on the plant sample, hubs' mean offset from
their neighbourhood centre drops from 0.41 to 0.27 at Balanced stiffness, and from 0.41 to
0.28 when straight.

Links are cubic curves. Each leaves its source end along that end's tangent, with an arm of
`min(5, distance / 2)` units, and enters its target end the same way, so a chain of linked
segments reads as one smooth line. Self-loops get a wider loop. Curves are tessellated
adaptively by turn and length for drawing and picking, and the other layouts (radial,
hierarchical, spiral) get the least-squares curve through their points.

## Incremental implementation plan

1. **Complete vertical slice (implemented):** worker parsing, typed graph, lazy sequence
   index, WebGL rendering, upload/search/zoom/stats/selection UI, and unit tests.
2. **Graph-aware layout (implemented):** worker-based force-directed, radial, and
   hierarchical layouts on an orientation-aware point graph with component packing, and
   FMMM multilevel coarsening; next, Sugiyama-style layering and GPU force evaluation for
   multi-million-segment graphs.
3. **Scale rendering:** add viewport culling/level-of-detail aggregation and GPU picking for
   graphs with millions of visible segments.
4. **Persistent projects:** optionally copy imported files to OPFS, persist graph indexes in
   IndexedDB, and expose explicit storage/quota controls.
5. **Format breadth:** add GFA2 edge and gap semantics, path/walk overlays, and tags.
6. **Performance gates:** benchmark parsing throughput, peak heap, sequence latency, and
   frame time with representative large assemblies in Chrome, Safari, and Firefox.

## Browser support

The initial renderer targets WebGL 2 because it is available in current Chrome, Safari,
Edge, and Firefox. WebGPU can later be added behind the same renderer interface for compute
layout and larger GPU-resident indexes without removing the WebGL 2 compatibility path.