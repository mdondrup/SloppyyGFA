import type { GraphStats, GraphStructure } from "../model/graph";

const TAB = 9;
const LF = 10;
const CR = 13;
const decoder = new TextDecoder();

export interface ParseOptions {
  readonly onProgress?: (bytesRead: number, nodes: number, edges: number) => void;
  readonly chunkSize?: number;
}

interface MutableGraph {
  names: string[];
  lengths: number[];
  depths: number[];
  sequenceOffsets: number[];
  sequenceByteLengths: number[];
  edgeNames: Array<[string, string]>;
  /** Bit 0: source reverse, bit 1: target reverse, bit 2: jump. */
  edgeFlags: number[];
}

const MINUS = 45;

export async function parseGfa(file: Blob, options: ParseOptions = {}): Promise<GraphStructure> {
  const graph: MutableGraph = {
    names: [],
    lengths: [],
    depths: [],
    sequenceOffsets: [],
    sequenceByteLengths: [],
    edgeNames: [],
    edgeFlags: [],
  };
  const chunkSize = options.chunkSize ?? 4 * 1024 * 1024;
  let carry = new Uint8Array(0);
  let carryOffset = 0;

  for (let chunkStart = 0; chunkStart < file.size; chunkStart += chunkSize) {
    const chunk = new Uint8Array(
      await file.slice(chunkStart, Math.min(file.size, chunkStart + chunkSize)).arrayBuffer(),
    );
    const bytes = concatBytes(carry, chunk);
    const bytesStart = chunkStart - carry.length;
    let lineStart = 0;

    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== LF) continue;
      parseLine(bytes.subarray(lineStart, index), bytesStart + lineStart, graph);
      lineStart = index + 1;
    }

    carry = bytes.slice(lineStart);
    carryOffset = bytesStart + lineStart;
    options.onProgress?.(
      Math.min(file.size, chunkStart + chunk.length),
      graph.names.length,
      graph.edgeNames.length,
    );
    await yieldToEventLoop();
  }

  if (carry.length > 0) parseLine(carry, carryOffset, graph);
  return finalizeGraph(graph);
}

function parseLine(line: Uint8Array, absoluteOffset: number, graph: MutableGraph): void {
  const end = line.at(-1) === CR ? line.length - 1 : line.length;
  if (end < 2 || line[1] !== TAB) return;

  if (line[0] === 83) {
    const fields = fieldRanges(line, end, 3);
    if (fields.length < 3) return;
    const name = decodeRange(line, fields[1]!);
    const sequenceRange = fields[2]!;
    const placeholder = sequenceRange[1] - sequenceRange[0] === 1 && line[sequenceRange[0]] === 42;
    const tags = readSegmentTags(line, sequenceRange[1], end);
    const sequenceLength = placeholder ? tags.ln : sequenceRange[1] - sequenceRange[0];
    graph.names.push(name);
    graph.lengths.push(sequenceLength);
    graph.depths.push(segmentDepth(tags, sequenceLength));
    graph.sequenceOffsets.push(absoluteOffset + sequenceRange[0]);
    graph.sequenceByteLengths.push(placeholder ? 0 : sequenceRange[1] - sequenceRange[0]);
    return;
  }

  if (line[0] === 76 || line[0] === 74) {
    const fields = fieldRanges(line, end, 5);
    if (fields.length >= 4) {
      graph.edgeNames.push([
        decodeRange(line, fields[1]!),
        decodeRange(line, fields[3]!),
      ]);
      const sourceReverse = line[fields[2]![0]] === MINUS ? 1 : 0;
      const targetReverse = fields[4] && line[fields[4][0]] === MINUS ? 2 : 0;
      graph.edgeFlags.push(sourceReverse | targetReverse | (line[0] === 74 ? 4 : 0));
    }
  }
}

function fieldRanges(line: Uint8Array, end: number, limit: number): Array<[number, number]> {
  const fields: Array<[number, number]> = [];
  let start = 0;
  for (let index = 0; index <= end && fields.length < limit; index += 1) {
    if (index === end || line[index] === TAB) {
      fields.push([start, index]);
      start = index + 1;
    }
  }
  return fields;
}

function decodeRange(line: Uint8Array, range: [number, number]): string {
  return decoder.decode(line.subarray(range[0], range[1]));
}

interface SegmentTags {
  ln: number;
  /** Values of DP, dp, ka, rd, KC, RC, FC in that order; NaN when absent. */
  readonly depthTags: Float64Array;
}

const DEPTH_TAGS = ["DP", "dp", "ka", "rd", "KC", "RC", "FC"];
const DEPTH_TAG_CODES = DEPTH_TAGS.map((tag) => tag.charCodeAt(0) * 256 + tag.charCodeAt(1));
const LN_CODE = 76 * 256 + 78;

/** Reads the optional `TAG:TYPE:VALUE` fields of an `S` record that follow the sequence. */
function readSegmentTags(line: Uint8Array, sequenceEnd: number, end: number): SegmentTags {
  const tags: SegmentTags = { ln: 0, depthTags: new Float64Array(DEPTH_TAGS.length).fill(NaN) };
  let start = sequenceEnd + 1;
  while (start < end) {
    let fieldEnd = start;
    while (fieldEnd < end && line[fieldEnd] !== TAB) fieldEnd += 1;
    if (fieldEnd - start > 5 && line[start + 2] === 58 && line[start + 4] === 58) {
      const code = line[start]! * 256 + line[start + 1]!;
      const slot = code === LN_CODE ? -1 : DEPTH_TAG_CODES.indexOf(code);
      if (code === LN_CODE || slot >= 0) {
        const value = Number(decoder.decode(line.subarray(start + 5, fieldEnd)));
        if (Number.isFinite(value)) {
          if (slot < 0) tags.ln = Math.max(0, Math.trunc(value));
          else tags.depthTags[slot] = value;
        }
      }
    }
    start = fieldEnd + 1;
  }
  return tags;
}

/** Segment depth using BandageNG's tag priority: DP, dp, ka, rd + 1, then KC/RC/FC per base. */
function segmentDepth(tags: SegmentTags, length: number): number {
  const values = tags.depthTags;
  for (let slot = 0; slot < values.length; slot += 1) {
    const value = values[slot]!;
    if (Number.isNaN(value)) continue;
    if (slot <= 2) return value;
    if (slot === 3) return value + 1;
    return length > 0 ? value / length : 0;
  }
  return 0;
}

function finalizeGraph(graph: MutableGraph): GraphStructure {
  const idToIndex = new Map<string, number>();
  graph.names.forEach((name, index) => idToIndex.set(name, index));
  const sources: number[] = [];
  const targets: number[] = [];
  const flags: number[] = [];
  let jumpCount = 0;
  graph.edgeNames.forEach(([sourceName, targetName], index) => {
    const source = idToIndex.get(sourceName);
    const target = idToIndex.get(targetName);
    if (source === undefined || target === undefined) return;
    const flag = graph.edgeFlags[index]!;
    sources.push(source);
    targets.push(target);
    flags.push(flag);
    if (flag & 4) jumpCount += 1;
  });
  const lengths = Float64Array.from(graph.lengths);
  return {
    names: graph.names,
    lengths,
    depths: Float32Array.from(graph.depths),
    sequenceOffsets: Float64Array.from(graph.sequenceOffsets),
    sequenceByteLengths: Uint32Array.from(graph.sequenceByteLengths),
    edgeSources: Uint32Array.from(sources),
    edgeTargets: Uint32Array.from(targets),
    edgeSourceReverse: Uint8Array.from(flags, (flag) => flag & 1),
    edgeTargetReverse: Uint8Array.from(flags, (flag) => (flag >> 1) & 1),
    edgeKinds: Uint8Array.from(flags, (flag) => (flag >> 2) & 1),
    stats: calculateStats(lengths, sources.length - jumpCount, jumpCount),
  };
}

function calculateStats(lengths: Float64Array, linkCount: number, jumpCount: number): GraphStats {
  let totalSequenceLength = 0;
  let longestSequence = 0;
  for (const length of lengths) {
    totalSequenceLength += length;
    longestSequence = Math.max(longestSequence, length);
  }
  const sorted = Array.from(lengths).sort((a, b) => b - a);
  const midpoint = totalSequenceLength / 2;
  let cumulative = 0;
  let n50 = 0;
  for (const length of sorted) {
    cumulative += length;
    if (cumulative >= midpoint) {
      n50 = length;
      break;
    }
  }
  return {
    nodeCount: lengths.length,
    linkCount,
    jumpCount,
    totalSequenceLength,
    longestSequence,
    n50,
  };
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right;
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
