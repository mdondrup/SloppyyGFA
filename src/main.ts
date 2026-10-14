import "./styles.css";
import {
  CURVE_STIFFNESS,
  DEFAULT_OPEN_END_REPULSION,
  FORCE_STARTS,
  LAYOUT_ALGORITHMS,
  OPEN_END_REPULSION,
  type ForceStart,
  type LayoutAlgorithm,
} from "./layout/layouts";
import { LENGTH_SCALES, type LengthScale } from "./layout/point-graph";
import type {
  GraphData,
  GraphStructure,
  LayoutRequest,
  LayoutResponse,
  ParserResponse,
} from "./model/graph";
import { GraphRenderer } from "./render/webgl-renderer";
import { FileSequenceStore } from "./storage/sequence-store";

const DEFAULT_LAYOUT: LayoutAlgorithm = "force";

type JumpMode = "dashed" | "layout" | "hidden";
const JUMP_MODES: ReadonlyArray<{ id: JumpMode; label: string }> = [
  { id: "dashed", label: "Dashed, ignored by layout" },
  { id: "layout", label: "Dashed, used in layout" },
  { id: "hidden", label: "Hidden" },
];

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <header class="topbar">
    <a class="brand" href="./" aria-label="SloppyyGFA home">
      <span class="brand-mark" aria-hidden="true"></span>
      <span>SloppyyGFA</span>
    </a>
    <label class="file-button">
      <input id="file-input" type="file" accept=".gfa,.gfa1,text/plain" />
      <span>Open GFA</span>
    </label>
    <form id="search-form" class="search" role="search">
      <input id="search-input" type="search" placeholder="Find segment ID" aria-label="Find segment ID" disabled />
      <button type="submit" aria-label="Search" disabled>Find</button>
    </form>
    <div id="status" class="status" role="status">Drop a GFA file to begin</div>
  </header>
  <main id="workspace">
    <section class="viewport" aria-label="Graph viewport">
      <canvas id="graph-canvas"></canvas>
      <div class="zoom-controls" aria-label="Zoom controls">
        <button id="zoom-in" title="Zoom in" disabled>+</button>
        <button id="zoom-out" title="Zoom out" disabled>&minus;</button>
        <button id="zoom-fit" title="Fit graph" disabled>Fit</button>
      </div>
      <div id="empty-state" class="empty-state">
        <div class="empty-icon" aria-hidden="true">GFA</div>
        <h1>Explore assembly graphs locally</h1>
        <p>Files stay on this device. Parsing runs off the main thread and rendering uses your GPU.</p>
        <label class="file-button primary">
          <input id="empty-file-input" type="file" accept=".gfa,.gfa1,text/plain" />
          <span>Choose a GFA file</span>
        </label>
      </div>
      <div id="drop-overlay" class="drop-overlay">Drop GFA to open</div>
    </section>
    <aside class="sidebar">
      <section>
        <h2>Graph</h2>
        <dl id="stats" class="stats">
          <div><dt>Segments</dt><dd>&mdash;</dd></div>
          <div><dt>Links (L)</dt><dd>&mdash;</dd></div>
          <div><dt>Jumps (J)</dt><dd>&mdash;</dd></div>
          <div><dt>Total length</dt><dd>&mdash;</dd></div>
          <div><dt>N50</dt><dd>&mdash;</dd></div>
          <div><dt>Longest</dt><dd>&mdash;</dd></div>
        </dl>
      </section>
      <section>
        <h2>Layout</h2>
        <label class="field">
          <span>Algorithm</span>
          <select id="layout-select" disabled>
            ${LAYOUT_ALGORITHMS.map(
              ({ id, label }) =>
                `<option value="${id}"${id === DEFAULT_LAYOUT ? " selected" : ""}>${label}</option>`,
            ).join("")}
          </select>
        </label>
        <label class="field">
          <span>Segment length</span>
          <select id="length-select" disabled>
            ${LENGTH_SCALES.map(({ id, label }) => `<option value="${id}">${label}</option>`).join("")}
          </select>
        </label>
        <label class="field">
          <span>Connectivity (force)</span>
          <select id="hub-select" disabled>
            <option value="hubs">Hubs centred in tangles</option>
            <option value="uniform">Uniform</option>
          </select>
        </label>
        <label class="field">
          <span>Start (force)</span>
          <select id="start-select" disabled>
            ${FORCE_STARTS.map(({ id, label }) => `<option value="${id}">${label}</option>`).join("")}
          </select>
        </label>
        <label class="field">
          <span>Open-end repulsion (force)</span>
          <select id="open-select" disabled>
            ${OPEN_END_REPULSION.map(
              ({ id, label, value }) =>
                `<option value="${id}"${value === DEFAULT_OPEN_END_REPULSION ? " selected" : ""}>${label}</option>`,
            ).join("")}
          </select>
        </label>
        <label class="field">
          <span>Segment curves (force)</span>
          <select id="curve-select" disabled>
            ${CURVE_STIFFNESS.map(({ id, label }) => `<option value="${id}">${label}</option>`).join("")}
          </select>
        </label>
        <label class="field">
          <span>Jump links (J)</span>
          <select id="jump-select" disabled>
            ${JUMP_MODES.map(({ id, label }) => `<option value="${id}">${label}</option>`).join("")}
          </select>
        </label>
        <div class="field-row">
          <span class="muted-label">Root</span>
          <span id="layout-root" class="mono">Auto (hub per component)</span>
        </div>
        <div class="button-row">
          <button id="layout-root-selected" class="secondary" disabled>Root at selection</button>
          <button id="layout-root-auto" class="secondary" disabled>Auto root</button>
        </div>
      </section>
      <section class="selection">
        <h2>Selection</h2>
        <div id="selection-empty" class="muted">Click a segment to inspect it.</div>
        <div id="selection-details" hidden>
          <div class="eyebrow">Segment</div>
          <h3 id="segment-name"></h3>
          <dl class="details">
            <div><dt>Length</dt><dd id="segment-length"></dd></div>
            <div><dt>Depth</dt><dd id="segment-depth"></dd></div>
            <div><dt>Sequence</dt><dd id="sequence-status">Not loaded</dd></div>
          </dl>
          <button id="load-sequence" class="secondary">Load sequence</button>
          <pre id="sequence" hidden></pre>
        </div>
      </section>
      <section class="privacy-note">
        <h2>Local by design</h2>
        <p>Graph data is processed entirely in your browser. Sequence bases are read lazily from the selected file.</p>
      </section>
    </aside>
  </main>
`;

const elements = {
  canvas: required<HTMLCanvasElement>("graph-canvas"),
  fileInput: required<HTMLInputElement>("file-input"),
  emptyFileInput: required<HTMLInputElement>("empty-file-input"),
  searchForm: required<HTMLFormElement>("search-form"),
  searchInput: required<HTMLInputElement>("search-input"),
  searchButton: required<HTMLButtonElement>("search-form", "button"),
  status: required<HTMLElement>("status"),
  workspace: required<HTMLElement>("workspace"),
  emptyState: required<HTMLElement>("empty-state"),
  dropOverlay: required<HTMLElement>("drop-overlay"),
  stats: required<HTMLElement>("stats"),
  selectionEmpty: required<HTMLElement>("selection-empty"),
  selectionDetails: required<HTMLElement>("selection-details"),
  segmentName: required<HTMLElement>("segment-name"),
  segmentLength: required<HTMLElement>("segment-length"),
  segmentDepth: required<HTMLElement>("segment-depth"),
  sequenceStatus: required<HTMLElement>("sequence-status"),
  sequence: required<HTMLElement>("sequence"),
  loadSequence: required<HTMLButtonElement>("load-sequence"),
  zoomIn: required<HTMLButtonElement>("zoom-in"),
  zoomOut: required<HTMLButtonElement>("zoom-out"),
  zoomFit: required<HTMLButtonElement>("zoom-fit"),
  layoutSelect: required<HTMLSelectElement>("layout-select"),
  layoutRoot: required<HTMLElement>("layout-root"),
  layoutRootSelected: required<HTMLButtonElement>("layout-root-selected"),
  layoutRootAuto: required<HTMLButtonElement>("layout-root-auto"),
  jumpSelect: required<HTMLSelectElement>("jump-select"),
  lengthSelect: required<HTMLSelectElement>("length-select"),
  hubSelect: required<HTMLSelectElement>("hub-select"),
  curveSelect: required<HTMLSelectElement>("curve-select"),
  startSelect: required<HTMLSelectElement>("start-select"),
  openSelect: required<HTMLSelectElement>("open-select"),
};

let renderer: GraphRenderer;
try {
  renderer = new GraphRenderer(elements.canvas);
} catch (error) {
  elements.status.textContent = error instanceof Error ? error.message : String(error);
  throw error;
}
let graph: GraphData | null = null;
let structure: GraphStructure | null = null;
let sequenceStore: FileSequenceStore | null = null;
let selectedIndex = -1;
let parserWorker: Worker | null = null;
let layoutWorker: Worker | null = null;
let layoutRequestId = 0;
let layoutAlgorithm: LayoutAlgorithm = DEFAULT_LAYOUT;
let layoutRoot: number | undefined;
let jumpMode: JumpMode = "dashed";
let lengthScale: LengthScale = "linear";
let hubWeighting = true;
let curveStiffness = CURVE_STIFFNESS[0]!.value;
let forceStart: ForceStart = FORCE_STARTS[0]!.id;
let openEndRepulsion = DEFAULT_OPEN_END_REPULSION;
let fileLabel = "";

renderer.onSelect = (index) => {
  if (index < 0) clearSelection();
  else void showSelection(index);
};

elements.jumpSelect.addEventListener("change", () => {
  const previous = jumpMode;
  jumpMode = elements.jumpSelect.value as JumpMode;
  renderer.setJumpsVisible(jumpMode !== "hidden");
  if ((previous === "layout") !== (jumpMode === "layout")) runLayout();
});

elements.lengthSelect.addEventListener("change", () => {
  lengthScale = elements.lengthSelect.value as LengthScale;
  runLayout();
});

elements.hubSelect.addEventListener("change", () => {
  hubWeighting = elements.hubSelect.value === "hubs";
  if (layoutAlgorithm === "force") runLayout();
});

elements.curveSelect.addEventListener("change", () => {
  curveStiffness = CURVE_STIFFNESS.find(({ id }) => id === elements.curveSelect.value)?.value ?? 1;
  if (layoutAlgorithm === "force") runLayout();
});

elements.startSelect.addEventListener("change", () => {
  forceStart = elements.startSelect.value as ForceStart;
  if (layoutAlgorithm === "force") runLayout();
});

elements.openSelect.addEventListener("change", () => {
  openEndRepulsion =
    OPEN_END_REPULSION.find(({ id }) => id === elements.openSelect.value)?.value ?? DEFAULT_OPEN_END_REPULSION;
  if (layoutAlgorithm === "force") runLayout();
});

elements.layoutSelect.addEventListener("change", () => {
  layoutAlgorithm = elements.layoutSelect.value as LayoutAlgorithm;
  runLayout();
});
elements.layoutRootSelected.addEventListener("click", () => {
  if (selectedIndex < 0) return;
  layoutRoot = selectedIndex;
  runLayout();
});
elements.layoutRootAuto.addEventListener("click", () => {
  layoutRoot = undefined;
  runLayout();
});

for (const input of [elements.fileInput, elements.emptyFileInput]) {
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) void openFile(file);
    input.value = "";
  });
}

elements.searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!graph) return;
  const query = elements.searchInput.value.trim();
  const exact = graph.names.indexOf(query);
  const index =
    exact >= 0
      ? exact
      : graph.names.findIndex((name) => name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  if (index < 0) {
    elements.status.textContent = `No segment matching "${query}"`;
    return;
  }
  renderer.focus(index);
  elements.status.textContent = `Focused segment ${graph.names[index]}`;
});

elements.zoomIn.addEventListener("click", () => renderer.zoomBy(1.35));
elements.zoomOut.addEventListener("click", () => renderer.zoomBy(1 / 1.35));
elements.zoomFit.addEventListener("click", () => renderer.fit());
elements.loadSequence.addEventListener("click", () => void loadSelectedSequence());

let dragDepth = 0;
window.addEventListener("dragenter", (event) => {
  event.preventDefault();
  dragDepth += 1;
  elements.dropOverlay.classList.add("visible");
});
window.addEventListener("dragleave", (event) => {
  event.preventDefault();
  dragDepth -= 1;
  if (dragDepth <= 0) elements.dropOverlay.classList.remove("visible");
});
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  elements.dropOverlay.classList.remove("visible");
  const file = event.dataTransfer?.files[0];
  if (file) void openFile(file);
});

async function openFile(file: File): Promise<void> {
  parserWorker?.terminate();
  layoutWorker?.terminate();
  layoutWorker = null;
  layoutRequestId += 1;
  graph = null;
  structure = null;
  sequenceStore = null;
  layoutRoot = undefined;
  clearSelection();
  elements.status.textContent = `Reading ${file.name}…`;
  elements.emptyState.hidden = true;
  setControlsEnabled(false);
  parserWorker = new Worker(new URL("./workers/parser.worker.ts", import.meta.url), {
    type: "module",
  });
  parserWorker.onmessage = (event: MessageEvent<ParserResponse>) => {
    const response = event.data;
    if (response.type === "progress") {
      const percent = Math.round((response.bytesRead / response.totalBytes) * 100);
      elements.status.textContent = `Parsing ${file.name} · ${percent}% · ${formatNumber(response.nodes)} segments`;
    } else if (response.type === "error") {
      elements.status.textContent = `Could not parse ${file.name}: ${response.message}`;
      elements.emptyState.hidden = false;
      parserWorker?.terminate();
      parserWorker = null;
    } else {
      structure = response.graph;
      sequenceStore = new FileSequenceStore(
        file,
        structure.sequenceOffsets,
        structure.sequenceByteLengths,
      );
      renderStats(structure);
      fileLabel = `${file.name} · ${formatBytes(file.size)}`;
      parserWorker?.terminate();
      parserWorker = null;
      runLayout();
    }
  };
  parserWorker.onerror = (event) => {
    elements.status.textContent = `Parser worker failed: ${event.message}`;
    elements.emptyState.hidden = false;
    parserWorker?.terminate();
    parserWorker = null;
  };
  parserWorker.postMessage(file);
}

function runLayout(): void {
  const target = structure;
  if (!target) return;
  layoutWorker?.terminate();
  const requestId = ++layoutRequestId;
  const algorithm = layoutAlgorithm;
  const label = layoutLabel(algorithm);
  elements.status.textContent = `Computing ${label} layout…`;
  updateLayoutControls();

  const worker = new Worker(new URL("./workers/layout.worker.ts", import.meta.url), {
    type: "module",
  });
  layoutWorker = worker;
  const finish = () => {
    worker.terminate();
    if (layoutWorker === worker) layoutWorker = null;
  };
  worker.onmessage = (event: MessageEvent<LayoutResponse>) => {
    const response = event.data;
    if (response.requestId !== layoutRequestId || target !== structure) {
      finish();
      return;
    }
    if (response.type === "progress") {
      elements.status.textContent = `Computing ${label} layout… ${Math.round(response.fraction * 100)}%`;
      return;
    }
    finish();
    if (response.type === "error") {
      elements.status.textContent = `Layout failed: ${response.message}`;
      return;
    }
    graph = { ...target, ...response.layout };
    renderer.setGraph(graph);
    setControlsEnabled(true);
    updateLayoutControls();
    elements.status.textContent = `${fileLabel} · ${label} layout in ${formatNumber(
      Math.round(response.elapsedMs),
    )} ms`;
  };
  worker.onerror = (event) => {
    finish();
    if (requestId === layoutRequestId) {
      elements.status.textContent = `Layout worker failed: ${event.message}`;
    }
  };
  const request: LayoutRequest = {
    requestId,
    graph: {
      lengths: target.lengths,
      edgeSources: target.edgeSources,
      edgeTargets: target.edgeTargets,
      edgeSourceReverse: target.edgeSourceReverse,
      edgeTargetReverse: target.edgeTargetReverse,
      edgeKinds: target.edgeKinds,
    },
    algorithm,
    root: algorithm === "spiral" ? undefined : layoutRoot,
    includeJumps: jumpMode === "layout",
    lengthScale,
    hubWeighting,
    curveStiffness,
    forceStart,
    openEndRepulsion,
  };
  worker.postMessage(request);
}

function updateLayoutControls(): void {
  const usesRoot = layoutAlgorithm !== "spiral";
  elements.layoutRoot.textContent = !usesRoot
    ? "Not used"
    : layoutRoot === undefined
      ? "Auto (hub per component)"
      : (structure?.names[layoutRoot] ?? "Auto (hub per component)");
  elements.layoutRootSelected.disabled =
    !graph || !usesRoot || selectedIndex < 0 || selectedIndex === layoutRoot;
  elements.layoutRootAuto.disabled = !graph || !usesRoot || layoutRoot === undefined;
}

function layoutLabel(algorithm: LayoutAlgorithm): string {
  return (LAYOUT_ALGORITHMS.find(({ id }) => id === algorithm)?.label ?? algorithm).toLowerCase();
}

function clearSelection(): void {
  selectedIndex = -1;
  renderer.clearSelection();
  elements.selectionEmpty.hidden = false;
  elements.selectionDetails.hidden = true;
  updateLayoutControls();
}

async function showSelection(index: number): Promise<void> {
  if (!graph) return;
  selectedIndex = index;
  elements.selectionEmpty.hidden = true;
  elements.selectionDetails.hidden = false;
  elements.segmentName.textContent = graph.names[index] ?? "";
  elements.segmentLength.textContent = `${formatNumber(graph.lengths[index] ?? 0)} bp`;
  const depth = graph.depths[index] ?? 0;
  elements.segmentDepth.textContent = depth > 0 ? `${depth.toFixed(1)}×` : "—";
  elements.sequenceStatus.textContent =
    graph.sequenceByteLengths[index] === 0 ? "Not present in file" : "On disk";
  elements.sequence.hidden = true;
  elements.sequence.textContent = "";
  elements.loadSequence.hidden = graph.sequenceByteLengths[index] === 0;
  updateLayoutControls();
}

async function loadSelectedSequence(): Promise<void> {
  if (!sequenceStore || selectedIndex < 0) return;
  const expectedIndex = selectedIndex;
  elements.loadSequence.disabled = true;
  elements.sequenceStatus.textContent = "Loading…";
  try {
    const sequence = await sequenceStore.get(expectedIndex);
    if (selectedIndex !== expectedIndex) return;
    elements.sequence.textContent = sequence ?? "";
    elements.sequence.hidden = false;
    elements.sequenceStatus.textContent = `${formatNumber(sequence?.length ?? 0)} bases loaded`;
  } catch (error) {
    elements.sequenceStatus.textContent =
      error instanceof Error ? `Error: ${error.message}` : "Could not load sequence";
  } finally {
    elements.loadSequence.disabled = false;
  }
}

function renderStats(value: GraphStructure): void {
  const values = [
    formatNumber(value.stats.nodeCount),
    formatNumber(value.stats.linkCount),
    formatNumber(value.stats.jumpCount),
    `${formatNumber(value.stats.totalSequenceLength)} bp`,
    `${formatNumber(value.stats.n50)} bp`,
    `${formatNumber(value.stats.longestSequence)} bp`,
  ];
  elements.stats.querySelectorAll("dd").forEach((element, index) => {
    element.textContent = values[index] ?? "—";
  });
}

function setControlsEnabled(enabled: boolean): void {
  for (const control of [
    elements.searchInput,
    elements.searchButton,
    elements.zoomIn,
    elements.zoomOut,
    elements.zoomFit,
    elements.layoutSelect,
    elements.jumpSelect,
    elements.lengthSelect,
    elements.hubSelect,
    elements.curveSelect,
    elements.startSelect,
    elements.openSelect,
  ]) {
    control.disabled = !enabled;
  }
}

function required<T extends Element>(id: string, selector?: string): T {
  const root = document.getElementById(id);
  const element = selector ? root?.querySelector(selector) : root;
  if (!element) throw new Error(`Missing required element: ${id}${selector ? ` ${selector}` : ""}`);
  return element as T;
}

const numberFormat = new Intl.NumberFormat();
function formatNumber(value: number): string {
  return numberFormat.format(value);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
