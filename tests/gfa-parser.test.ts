import { describe, expect, it } from "vitest";

import { EDGE_JUMP, EDGE_LINK } from "../src/model/graph";
import { parseGfa } from "../src/parser/gfa-parser";

describe("parseGfa", () => {
  it("parses segments, links, jumps, lengths, and lazy sequence offsets across chunks", async () => {
    const source = [
      "H\tVN:Z:1.2",
      "S\talpha\tACGT\tDP:f:2.5",
      "S\tbeta\t*\tLN:i:120",
      "S\tgamma\tGG",
      "L\talpha\t+\tbeta\t-\t4M",
      "J\tbeta\t+\tgamma\t+\t*",
      "L\tmissing\t+\talpha\t+\t0M",
      "",
    ].join("\n");
    const blob = new Blob([source]);

    const graph = await parseGfa(blob, { chunkSize: 7 });

    expect(graph.names).toEqual(["alpha", "beta", "gamma"]);
    expect(Array.from(graph.lengths)).toEqual([4, 120, 2]);
    expect(Array.from(graph.edgeSources)).toEqual([0, 1]);
    expect(Array.from(graph.edgeTargets)).toEqual([1, 2]);
    expect(Array.from(graph.edgeSourceReverse)).toEqual([0, 0]);
    expect(Array.from(graph.edgeTargetReverse)).toEqual([1, 0]);
    expect(Array.from(graph.edgeKinds)).toEqual([EDGE_LINK, EDGE_JUMP]);
    expect(graph.stats).toEqual({
      nodeCount: 3,
      linkCount: 1,
      jumpCount: 1,
      totalSequenceLength: 126,
      longestSequence: 120,
      n50: 120,
    });
    expect(await blob.slice(graph.sequenceOffsets[0], graph.sequenceOffsets[0]! + 4).text()).toBe(
      "ACGT",
    );
    expect(graph.sequenceByteLengths[1]).toBe(0);
    expect(Array.from(graph.depths)).toEqual([2.5, 0, 0]);
  });

  it("reads depth with BandageNG's tag priority", async () => {
    const graph = await parseGfa(
      new Blob([
        [
          "S\ta\tACGT\tKC:i:40\tDP:f:7.5",
          "S\tb\t*\tKC:i:300\tLN:i:100",
          "S\tc\tAC\tdp:i:8",
          "S\td\tAC\trd:i:3",
          "S\te\tAC\tRC:i:5\tFC:i:9",
        ].join("\n"),
      ]),
    );
    expect(Array.from(graph.lengths)).toEqual([4, 100, 2, 2, 2]);
    expect(Array.from(graph.depths)).toEqual([7.5, 3, 8, 4, 2.5]);
  });

  it("handles CRLF input and a final line without a newline", async () => {
    const graph = await parseGfa(new Blob(["S\t1\tA\r\nS\t2\tCC"]));

    expect(graph.names).toEqual(["1", "2"]);
    expect(Array.from(graph.lengths)).toEqual([1, 2]);
  });
});
