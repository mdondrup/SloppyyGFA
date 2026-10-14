/// <reference lib="webworker" />

import { computeLayout } from "../layout/layouts";
import type { LayoutRequest, LayoutResponse } from "../model/graph";

const worker = self as DedicatedWorkerGlobalScope;

worker.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const {
    requestId,
    graph,
    algorithm,
    root,
    includeJumps,
    lengthScale,
    hubWeighting,
    curveStiffness,
    forceStart,
    openEndRepulsion,
  } = event.data;
  try {
    const started = performance.now();
    const layout = computeLayout(graph, {
      algorithm,
      root,
      includeJumps,
      lengthScale,
      hubWeighting,
      curveStiffness,
      forceStart,
      openEndRepulsion,
      onProgress(fraction) {
        const response: LayoutResponse = { type: "progress", requestId, fraction };
        worker.postMessage(response);
      },
    });
    const response: LayoutResponse = {
      type: "complete",
      requestId,
      layout,
      elapsedMs: performance.now() - started,
    };
    worker.postMessage(response, [layout.positions.buffer, layout.pointOffsets.buffer, layout.curves.buffer]);
  } catch (error) {
    const response: LayoutResponse = {
      type: "error",
      requestId,
      message: error instanceof Error ? error.message : String(error),
    };
    worker.postMessage(response);
  }
};
