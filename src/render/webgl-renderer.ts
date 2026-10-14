import { EDGE_JUMP, type GraphData } from "../model/graph";
import {
  cubicPoint,
  isStraightLink,
  LINK_CURVE_PIECES,
  linkControls,
  tessellateCurves,
  type Tessellation,
} from "../layout/curves";

/** Half of BandageNG's `averageNodeWidth` (5 world units; link length is 5). */
const WORLD_HALF_WIDTH = 2.5;
/** BandageNG `depthPower` and `depthEffectOnWidth`. */
const DEPTH_POWER = 0.5;
const DEPTH_EFFECT_ON_WIDTH = 0.5;
const MIN_HALF_WIDTH_PX = 1.25;
const SELECTED_EXTRA_PX = 1.5;
const PICK_TOLERANCE_PX = 6;
const DASH_PERIOD_PX = 9;

const COMMON = `#version 300 es
precision highp float;
uniform vec2 u_center;
uniform float u_scale;
uniform vec2 u_viewport;
vec4 toClip(vec2 world) {
  vec2 px = (world - u_center) * u_scale;
  return vec4(px.x / (u_viewport.x * 0.5), px.y / (u_viewport.y * 0.5), 0.0, 1.0);
}
vec3 segmentColor(float id) {
  float h = fract(id * 0.6180339887 + 0.11) * 6.0;
  vec3 rgb = clamp(abs(mod(h + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return mix(vec3(0.62), rgb, 0.68) * 0.95;
}
`;

const RIBBON_VS = `${COMMON}
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec2 a_from;
layout(location = 2) in vec2 a_to;
layout(location = 3) in float a_segment;
layout(location = 4) in float a_width;
uniform float u_halfWidth;
uniform float u_minHalfWidth;
uniform float u_maxHalfWidth;
uniform float u_extraHalfWidth;
out vec3 v_color;
void main() {
  vec2 from = (a_from - u_center) * u_scale;
  vec2 to = (a_to - u_center) * u_scale;
  vec2 d = to - from;
  float len = length(d);
  vec2 dir = len > 1e-6 ? d / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  float halfWidth = min(max(u_minHalfWidth, u_halfWidth * a_width) + u_extraHalfWidth, u_maxHalfWidth);
  vec2 px = mix(from, to, a_corner.x) + normal * a_corner.y * halfWidth;
  gl_Position = vec4(px.x / (u_viewport.x * 0.5), px.y / (u_viewport.y * 0.5), 0.0, 1.0);
  v_color = segmentColor(a_segment);
}
`;

const JOINT_VS = `${COMMON}
layout(location = 0) in vec2 a_position;
layout(location = 1) in float a_segment;
layout(location = 2) in float a_width;
uniform float u_halfWidth;
uniform float u_minHalfWidth;
uniform float u_maxHalfWidth;
uniform float u_extraHalfWidth;
out vec3 v_color;
void main() {
  gl_Position = toClip(a_position);
  gl_PointSize = 2.0 * min(max(u_minHalfWidth, u_halfWidth * a_width) + u_extraHalfWidth, u_maxHalfWidth);
  v_color = segmentColor(a_segment);
}
`;

const SOLID_FS = `#version 300 es
precision mediump float;
in vec3 v_color;
uniform vec4 u_override;
out vec4 color;
void main() {
  color = u_override.a > 0.0 ? u_override : vec4(v_color, 1.0);
}
`;

const ROUND_FS = `#version 300 es
precision mediump float;
in vec3 v_color;
uniform vec4 u_override;
out vec4 color;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  if (dot(c, c) > 1.0) discard;
  color = u_override.a > 0.0 ? u_override : vec4(v_color, 1.0);
}
`;

const EDGE_VS = `${COMMON}
layout(location = 0) in vec2 a_position;
layout(location = 1) in float a_distance;
out float v_distance;
void main() {
  gl_Position = toClip(a_position);
  v_distance = a_distance;
}
`;

const EDGE_FS = `#version 300 es
precision mediump float;
in float v_distance;
uniform vec4 u_color;
uniform highp float u_scale;
uniform float u_dashPeriod;
out vec4 color;
void main() {
  if (u_dashPeriod > 0.0 && mod(v_distance * u_scale, u_dashPeriod) > u_dashPeriod * 0.55) discard;
  color = u_color;
}
`;

interface Program {
  readonly program: WebGLProgram;
  readonly uniforms: Map<string, WebGLUniformLocation>;
}

interface Batch {
  vao: WebGLVertexArrayObject;
  buffers: WebGLBuffer[];
  count: number;
}

export class GraphRenderer {
  onSelect: ((index: number) => void) | null = null;

  private readonly gl: WebGL2RenderingContext;
  private readonly ribbonProgram: Program;
  private readonly jointProgram: Program;
  private readonly edgeProgram: Program;
  private readonly cornerBuffer: WebGLBuffer;
  private readonly maxHalfWidthPx: number;
  private readonly resizeObserver: ResizeObserver;

  private graph: GraphData | null = null;
  /** Polylines of the segment curves, used for drawing, picking and fitting. */
  private tessellation: Tessellation = { offsets: new Uint32Array(1), points: new Float32Array(0) };
  /** Per-segment ribbon width relative to `WORLD_HALF_WIDTH`, from read depth. */
  private widthFactors: Float32Array = new Float32Array(0);
  private ribbons: Batch | null = null;
  private joints: Batch | null = null;
  private links: Batch | null = null;
  private jumps: Batch | null = null;
  private selectedRibbons: Batch | null = null;
  private selectedJoints: Batch | null = null;
  private jumpsVisible = true;
  private selected = -1;
  private centerX = 0;
  private centerY = 0;
  private scale = 1;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;
  private frame = 0;
  private pointer: { id: number; x: number; y: number; moved: boolean } | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
    if (!gl) throw new Error("WebGL 2 is not available in this browser.");
    this.gl = gl;
    this.ribbonProgram = createProgram(gl, RIBBON_VS, SOLID_FS);
    this.jointProgram = createProgram(gl, JOINT_VS, ROUND_FS);
    this.edgeProgram = createProgram(gl, EDGE_VS, EDGE_FS);
    const pointRange = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array;
    this.maxHalfWidthPx = Math.max(2, (pointRange[1] ?? 64) / 2);

    // Two triangles spanning (along, side) ∈ [0, 1] × [-1, 1].
    this.cornerBuffer = createBuffer(gl, new Float32Array([0, -1, 1, -1, 1, 1, 0, -1, 1, 1, 0, 1]));

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    canvas.addEventListener("wheel", this.handleWheel, { passive: false });
    canvas.addEventListener("pointerdown", this.handlePointerDown);
    canvas.addEventListener("pointermove", this.handlePointerMove);
    canvas.addEventListener("pointerup", this.handlePointerUp);
    canvas.addEventListener("pointercancel", this.handlePointerCancel);
    this.resize();
  }

  setGraph(graph: GraphData): void {
    const keepSelection = this.graph?.names === graph.names ? this.selected : -1;
    this.disposeGraphBuffers();
    this.graph = graph;
    this.widthFactors = depthWidthFactors(graph.lengths, graph.depths);
    this.tessellation = tessellateCurves(graph.curves);
    this.selected = -1;
    this.buildBuffers(graph);
    if (keepSelection >= 0) this.select(keepSelection);
    this.fit();
  }

  setJumpsVisible(visible: boolean): void {
    this.jumpsVisible = visible;
    this.requestRender();
  }

  fit(): void {
    const positions = this.tessellation.points;
    if (!this.graph || positions.length === 0) {
      this.centerX = 0;
      this.centerY = 0;
      this.scale = 1;
      this.requestRender();
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let index = 0; index < positions.length; index += 2) {
      const x = positions[index]!;
      const y = positions[index + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    this.centerX = (minX + maxX) / 2;
    this.centerY = (minY + maxY) / 2;
    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);
    this.scale = Math.min((this.width * 0.92) / spanX, (this.height * 0.92) / spanY);
    this.requestRender();
  }

  zoomBy(factor: number, anchorX = this.width / 2, anchorY = this.height / 2): void {
    const [worldX, worldY] = this.toWorld(anchorX, anchorY);
    this.scale = Math.min(Math.max(this.scale * factor, 1e-5), 1e4);
    this.centerX = worldX - (anchorX - this.width / 2) / this.scale;
    this.centerY = worldY + (anchorY - this.height / 2) / this.scale;
    this.requestRender();
  }

  focus(index: number): void {
    const graph = this.graph;
    if (!graph || index < 0 || index >= graph.names.length) return;
    const { offsets, points } = this.tessellation;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let point = offsets[index]!; point < offsets[index + 1]!; point += 1) {
      const x = points[point * 2]!;
      const y = points[point * 2 + 1]!;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    this.centerX = (minX + maxX) / 2;
    this.centerY = (minY + maxY) / 2;
    const span = Math.max(maxX - minX, maxY - minY, 40);
    this.scale = Math.min(this.width, this.height) / (span * 4);
    this.select(index);
    this.onSelect?.(index);
  }

  select(index: number): void {
    const graph = this.graph;
    this.disposeBatch(this.selectedRibbons);
    this.disposeBatch(this.selectedJoints);
    this.selectedRibbons = null;
    this.selectedJoints = null;
    this.selected = graph && index >= 0 && index < graph.names.length ? index : -1;
    if (graph && this.selected >= 0) {
      this.selectedRibbons = this.createRibbonBatch(this.selected, this.selected + 1);
      this.selectedJoints = this.createJointBatch(this.selected, this.selected + 1);
    }
    this.requestRender();
  }

  clearSelection(): void {
    this.select(-1);
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener("wheel", this.handleWheel);
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("pointercancel", this.handlePointerCancel);
    this.disposeGraphBuffers();
    const gl = this.gl;
    gl.deleteBuffer(this.cornerBuffer);
    for (const { program } of [this.ribbonProgram, this.jointProgram, this.edgeProgram]) {
      gl.deleteProgram(program);
    }
  }

  /** Returns the segment under a canvas-relative CSS pixel position, or -1. */
  pick(canvasX: number, canvasY: number): number {
    const graph = this.graph;
    if (!graph) return -1;
    const [x, y] = this.toWorld(canvasX, canvasY);
    const minTolerance = PICK_TOLERANCE_PX / this.scale;
    const maxTolerance = this.maxHalfWidthPx / this.scale;
    let best = -1;
    let bestDistance = Infinity;
    const { offsets, points } = this.tessellation;
    const segmentCount = graph.names.length;
    for (let segment = 0; segment < segmentCount; segment += 1) {
      const tolerance = Math.min(
        Math.max(minTolerance, WORLD_HALF_WIDTH * this.widthFactors[segment]!),
        Math.max(minTolerance, maxTolerance),
      );
      const last = offsets[segment + 1]! - 1;
      for (let point = offsets[segment]!; point < last; point += 1) {
        const ax = points[point * 2]!;
        const ay = points[point * 2 + 1]!;
        const bx = points[point * 2 + 2]!;
        const by = points[point * 2 + 3]!;
        const distance = distanceToSegmentSquared(x, y, ax, ay, bx, by);
        if (distance <= tolerance * tolerance && distance < bestDistance) {
          bestDistance = distance;
          best = segment;
        }
      }
    }
    return best;
  }

  private buildBuffers(graph: GraphData): void {
    const segmentCount = graph.names.length;
    this.ribbons = this.createRibbonBatch(0, segmentCount);
    this.joints = this.createJointBatch(0, segmentCount);

    // Links are Bandage-style cubic curves, drawn as line pieces with the distance along the
    // curve for dashing.
    const controls = new Float64Array(8);
    const point = new Float64Array(2);
    const pieces = new Uint8Array(graph.edgeKinds.length);
    let linkVertices = 0;
    let jumpVertices = 0;
    for (let edge = 0; edge < graph.edgeKinds.length; edge += 1) {
      this.edgeControls(graph, edge, controls);
      pieces[edge] = isStraightLink(controls) ? 1 : LINK_CURVE_PIECES;
      if (graph.edgeKinds[edge] === EDGE_JUMP) jumpVertices += pieces[edge]! * 2;
      else linkVertices += pieces[edge]! * 2;
    }
    const linkData = new Float32Array(linkVertices * 3);
    const jumpData = new Float32Array(jumpVertices * 3);
    let linkCursor = 0;
    let jumpCursor = 0;
    for (let edge = 0; edge < graph.edgeKinds.length; edge += 1) {
      this.edgeControls(graph, edge, controls);
      const isJump = graph.edgeKinds[edge] === EDGE_JUMP;
      const target = isJump ? jumpData : linkData;
      let cursor = isJump ? jumpCursor : linkCursor;
      const count = pieces[edge]!;
      let x = controls[0]!;
      let y = controls[1]!;
      let distance = 0;
      for (let k = 1; k <= count; k += 1) {
        cubicPoint(controls, k / count, point);
        const step = Math.hypot(point[0]! - x, point[1]! - y);
        target[cursor++] = x;
        target[cursor++] = y;
        target[cursor++] = distance;
        distance += step;
        x = point[0]!;
        y = point[1]!;
        target[cursor++] = x;
        target[cursor++] = y;
        target[cursor++] = distance;
      }
      if (isJump) jumpCursor = cursor;
      else linkCursor = cursor;
    }
    this.links = this.createEdgeBatch(linkData);
    this.jumps = this.createEdgeBatch(jumpData);
  }

  private edgeControls(graph: GraphData, edge: number, out: Float64Array): Float64Array {
    return linkControls(
      graph.curves,
      graph.edgeSources[edge]!,
      graph.edgeSourceReverse[edge]!,
      graph.edgeTargets[edge]!,
      graph.edgeTargetReverse[edge]!,
      out,
    );
  }

  private createRibbonBatch(firstSegment: number, endSegment: number): Batch {
    const gl = this.gl;
    const { offsets, points } = this.tessellation;
    const pieces = offsets[endSegment]! - offsets[firstSegment]! - (endSegment - firstSegment);
    const data = new Float32Array(pieces * 6);
    let cursor = 0;
    for (let segment = firstSegment; segment < endSegment; segment += 1) {
      const width = this.widthFactors[segment]!;
      const last = offsets[segment + 1]! - 1;
      for (let point = offsets[segment]!; point < last; point += 1) {
        data[cursor++] = points[point * 2]!;
        data[cursor++] = points[point * 2 + 1]!;
        data[cursor++] = points[point * 2 + 2]!;
        data[cursor++] = points[point * 2 + 3]!;
        data[cursor++] = segment;
        data[cursor++] = width;
      }
    }
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const instances = createBuffer(gl, data);
    const stride = 6 * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 8);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 1, gl.FLOAT, false, stride, 20);
    gl.vertexAttribDivisor(4, 1);
    gl.bindVertexArray(null);
    return { vao, buffers: [instances], count: pieces };
  }

  /** Round joints at the tessellation vertices of a segment range, closing ribbon gaps. */
  private createJointBatch(firstSegment: number, endSegment: number): Batch {
    const gl = this.gl;
    const { offsets, points } = this.tessellation;
    const firstPoint = offsets[firstSegment]!;
    const count = offsets[endSegment]! - firstPoint;
    const data = new Float32Array(count * 4);
    for (let segment = firstSegment; segment < endSegment; segment += 1) {
      for (let point = offsets[segment]!; point < offsets[segment + 1]!; point += 1) {
        const offset = (point - firstPoint) * 4;
        data[offset] = points[point * 2]!;
        data[offset + 1] = points[point * 2 + 1]!;
        data[offset + 2] = segment;
        data[offset + 3] = this.widthFactors[segment]!;
      }
    }
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buffer = createBuffer(gl, data);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 16, 12);
    gl.bindVertexArray(null);
    return { vao, buffers: [buffer], count };
  }

  private createEdgeBatch(data: Float32Array): Batch {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buffer = createBuffer(gl, data);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);
    gl.bindVertexArray(null);
    return { vao, buffers: [buffer], count: data.length / 3 };
  }

  private disposeBatch(batch: Batch | null): void {
    if (!batch) return;
    this.gl.deleteVertexArray(batch.vao);
    for (const buffer of batch.buffers) this.gl.deleteBuffer(buffer);
  }

  private disposeGraphBuffers(): void {
    for (const batch of [
      this.ribbons,
      this.joints,
      this.links,
      this.jumps,
      this.selectedRibbons,
      this.selectedJoints,
    ]) {
      this.disposeBatch(batch);
    }
    this.ribbons = this.joints = this.links = this.jumps = null;
    this.selectedRibbons = this.selectedJoints = null;
  }


  private render = (): void => {
    this.frame = 0;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.043, 0.051, 0.063, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.graph) return;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const linkAlpha = Math.min(0.85, 0.35 + this.scale * 0.15);

    this.useProgram(this.edgeProgram);
    this.setEdgeStyle([0.62, 0.66, 0.72, linkAlpha], 0);
    this.drawBatch(this.links, gl.LINES);
    if (this.jumpsVisible) {
      this.setEdgeStyle([0.95, 0.45, 0.4, 0.9], DASH_PERIOD_PX * this.pixelRatio);
      this.drawBatch(this.jumps, gl.LINES);
    }

    const noOverride = [0, 0, 0, 0] as const;
    this.drawSegments(this.ribbons, this.joints, 0, noOverride);
    if (this.selected >= 0) {
      this.drawSegments(this.selectedRibbons, this.selectedJoints, SELECTED_EXTRA_PX, [1, 0.62, 0.2, 1]);
    }
  };

  private drawSegments(
    ribbons: Batch | null,
    joints: Batch | null,
    extraHalfWidthPx: number,
    override: readonly number[],
  ): void {
    const gl = this.gl;
    if (ribbons && ribbons.count > 0) {
      this.useProgram(this.ribbonProgram);
      this.setWidthUniforms(this.ribbonProgram, extraHalfWidthPx);
      gl.uniform4fv(this.uniform(this.ribbonProgram, "u_override"), override);
      gl.bindVertexArray(ribbons.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, ribbons.count);
    }
    if (joints && joints.count > 0) {
      this.useProgram(this.jointProgram);
      this.setWidthUniforms(this.jointProgram, extraHalfWidthPx);
      gl.uniform4fv(this.uniform(this.jointProgram, "u_override"), override);
      gl.bindVertexArray(joints.vao);
      gl.drawArrays(gl.POINTS, 0, joints.count);
    }
    gl.bindVertexArray(null);
  }

  private setWidthUniforms(program: Program, extraHalfWidthPx: number): void {
    const gl = this.gl;
    const ratio = this.pixelRatio;
    gl.uniform1f(this.uniform(program, "u_halfWidth"), WORLD_HALF_WIDTH * this.scale * ratio);
    gl.uniform1f(this.uniform(program, "u_minHalfWidth"), MIN_HALF_WIDTH_PX * ratio);
    gl.uniform1f(this.uniform(program, "u_maxHalfWidth"), this.maxHalfWidthPx * ratio);
    gl.uniform1f(this.uniform(program, "u_extraHalfWidth"), extraHalfWidthPx * ratio);
  }

  private setEdgeStyle(color: readonly number[], dashPeriod: number): void {
    const gl = this.gl;
    gl.uniform4fv(this.uniform(this.edgeProgram, "u_color"), color);
    gl.uniform1f(this.uniform(this.edgeProgram, "u_dashPeriod"), dashPeriod);
  }

  private drawBatch(batch: Batch | null, mode: number): void {
    if (!batch || batch.count === 0) return;
    this.gl.bindVertexArray(batch.vao);
    this.gl.drawArrays(mode, 0, batch.count);
    this.gl.bindVertexArray(null);
  }

  private useProgram(program: Program): void {
    const gl = this.gl;
    gl.useProgram(program.program);
    gl.uniform2f(this.uniform(program, "u_center"), this.centerX, this.centerY);
    gl.uniform1f(this.uniform(program, "u_scale"), this.scale * this.pixelRatio);
    gl.uniform2f(this.uniform(program, "u_viewport"), this.canvas.width, this.canvas.height);
  }

  private uniform(program: Program, name: string): WebGLUniformLocation | null {
    let location = program.uniforms.get(name);
    if (location === undefined) {
      const found = this.gl.getUniformLocation(program.program, name);
      if (!found) return null;
      location = found;
      program.uniforms.set(name, location);
    }
    return location;
  }

  private requestRender(): void {
    if (!this.frame) this.frame = requestAnimationFrame(this.render);
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.width = Math.max(rect.width, 1);
    this.height = Math.max(rect.height, 1);
    this.canvas.width = Math.round(this.width * this.pixelRatio);
    this.canvas.height = Math.round(this.height * this.pixelRatio);
    this.requestRender();
  }

  private toWorld(canvasX: number, canvasY: number): [number, number] {
    return [
      this.centerX + (canvasX - this.width / 2) / this.scale,
      this.centerY - (canvasY - this.height / 2) / this.scale,
    ];
  }

  private handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    this.zoomBy(Math.exp(-delta * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
  };

  private handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    this.canvas.setPointerCapture(event.pointerId);
    this.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  };

  private handlePointerMove = (event: PointerEvent): void => {
    const pointer = this.pointer;
    if (!pointer || pointer.id !== event.pointerId) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    if (!pointer.moved && Math.hypot(dx, dy) < 4) return;
    pointer.moved = true;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    this.centerX -= dx / this.scale;
    this.centerY += dy / this.scale;
    this.canvas.classList.add("panning");
    this.requestRender();
  };

  private handlePointerUp = (event: PointerEvent): void => {
    const pointer = this.pointer;
    if (!pointer || pointer.id !== event.pointerId) return;
    this.pointer = null;
    this.canvas.classList.remove("panning");
    if (pointer.moved) return;
    const rect = this.canvas.getBoundingClientRect();
    const index = this.pick(event.clientX - rect.left, event.clientY - rect.top);
    this.select(index);
    this.onSelect?.(index);
  };

  private handlePointerCancel = (): void => {
    this.pointer = null;
    this.canvas.classList.remove("panning");
  };
}

function distanceToSegmentSquared(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  let t = lengthSquared > 0 ? ((px - ax) * dx + (py - ay) * dy) / lengthSquared : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx - px;
  const cy = ay + t * dy - py;
  return cx * cx + cy * cy;
}

function createBuffer(gl: WebGL2RenderingContext, data: Float32Array): WebGLBuffer {
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error("Could not allocate a WebGL buffer.");
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  return buffer;
}

function createProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string): Program {
  const program = gl.createProgram();
  if (!program) throw new Error("Could not create a WebGL program.");
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertex],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("Could not create a WebGL shader.");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(shader) ?? "unknown"}`);
    }
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Program link failed: ${gl.getProgramInfoLog(program) ?? "unknown"}`);
  }
  return { program, uniforms: new Map() };
}

/**
 * Ribbon width relative to the average, as BandageNG's `GraphicsItemNode::getNodeWidth`:
 * `((depth / meanDepth) ^ depthPower - 1) * depthEffectOnWidth + 1`, where the mean depth is
 * weighted by segment length. Graphs without depth tags get uniform width.
 */
export function depthWidthFactors(lengths: Float64Array, depths: Float32Array): Float32Array {
  let weighted = 0;
  let total = 0;
  for (let segment = 0; segment < lengths.length; segment += 1) {
    weighted += lengths[segment]! * depths[segment]!;
    total += lengths[segment]!;
  }
  const mean = total > 0 ? weighted / total : 0;
  const factors = new Float32Array(lengths.length);
  for (let segment = 0; segment < lengths.length; segment += 1) {
    const relative = mean > 0 ? Math.max(0, depths[segment]! / mean) : 1;
    factors[segment] = (Math.pow(relative, DEPTH_POWER) - 1) * DEPTH_EFFECT_ON_WIDTH + 1;
  }
  return factors;
}
