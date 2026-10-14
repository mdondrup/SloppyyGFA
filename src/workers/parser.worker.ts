/// <reference lib="webworker" />

import type { ParserResponse } from "../model/graph";
import { parseGfa } from "../parser/gfa-parser";

const worker = self as DedicatedWorkerGlobalScope;

worker.onmessage = async (event: MessageEvent<File>) => {
  try {
    const file = event.data;
    const graph = await parseGfa(file, {
      onProgress(bytesRead, nodes, edges) {
        const response: ParserResponse = {
          type: "progress",
          bytesRead,
          totalBytes: file.size,
          nodes,
          edges,
        };
        worker.postMessage(response);
      },
    });
    const response: ParserResponse = { type: "complete", graph };
    worker.postMessage(response, [
      graph.lengths.buffer,
      graph.depths.buffer,
      graph.sequenceOffsets.buffer,
      graph.sequenceByteLengths.buffer,
      graph.edgeSources.buffer,
      graph.edgeTargets.buffer,
      graph.edgeSourceReverse.buffer,
      graph.edgeTargetReverse.buffer,
      graph.edgeKinds.buffer,
    ]);
  } catch (error) {
    const response: ParserResponse = {
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    };
    worker.postMessage(response);
  }
};
