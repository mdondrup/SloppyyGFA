import type { ForceStart, LayoutAlgorithm } from "../layout/layouts";
import type { LengthScale, SegmentGraph } from "../layout/point-graph";

/** Edge kinds stored in `GraphStructure.edgeKinds`. */
export const EDGE_LINK = 0;
export const EDGE_JUMP = 1;

export interface GraphStructure {
  readonly names: string[];
  readonly lengths: Float64Array;
  /** Read depth from `DP`/`dp`/`ka`/`rd`/`KC`/`RC`/`FC` tags, or 0 when absent. */
  readonly depths: Float32Array;
  readonly sequenceOffsets: Float64Array;
  readonly sequenceByteLengths: Uint32Array;
  readonly edgeSources: Uint32Array;
  readonly edgeTargets: Uint32Array;
  /** 1 when the source segment is used in reverse orientation (`-`). */
  readonly edgeSourceReverse: Uint8Array;
  /** 1 when the target segment is used in reverse orientation (`-`). */
  readonly edgeTargetReverse: Uint8Array;
  /** `EDGE_LINK` for GFA `L` records, `EDGE_JUMP` for `J` records. */
  readonly edgeKinds: Uint8Array;
  readonly stats: GraphStats;
}

/**
 * Each segment is drawn as a quadratic Bézier curve from its start (5') to its end (3'):
 * `curves` holds start, handle and end (six numbers per segment; see `layout/curves.ts`).
 * `positions` samples the curves at evenly spaced layout points: points of segment `i` are
 * `pointOffsets[i]` to `pointOffsets[i + 1] - 1`.
 */
export interface GraphLayout {
  readonly positions: Float32Array;
  readonly pointOffsets: Uint32Array;
  readonly curves: Float32Array;
}

export interface GraphData extends GraphStructure, GraphLayout {}

export interface GraphStats {
  readonly nodeCount: number;
  readonly linkCount: number;
  readonly jumpCount: number;
  readonly totalSequenceLength: number;
  readonly longestSequence: number;
  readonly n50: number;
}

export interface ParseProgress {
  readonly type: "progress";
  readonly bytesRead: number;
  readonly totalBytes: number;
  readonly nodes: number;
  readonly edges: number;
}

export interface ParseComplete {
  readonly type: "complete";
  readonly graph: GraphStructure;
}

export interface ParseFailure {
  readonly type: "error";
  readonly message: string;
}

export type ParserResponse = ParseProgress | ParseComplete | ParseFailure;

export interface LayoutRequest {
  readonly requestId: number;
  readonly graph: SegmentGraph;
  readonly algorithm: LayoutAlgorithm;
  readonly root?: number;
  readonly includeJumps: boolean;
  readonly lengthScale: LengthScale;
  readonly hubWeighting: boolean;
  /** Force layout curve regularisation multiplier (`Infinity` for straight segments). */
  readonly curveStiffness: number;
  /** Initial placement of the force layout. */
  readonly forceStart: ForceStart;
  /** Force layout open-end repulsion strength (0 disables it). */
  readonly openEndRepulsion: number;
}

export type LayoutResponse =
  | { readonly type: "progress"; readonly requestId: number; readonly fraction: number }
  | {
      readonly type: "complete";
      readonly requestId: number;
      readonly layout: GraphLayout;
      readonly elapsedMs: number;
    }
  | { readonly type: "error"; readonly requestId: number; readonly message: string };
