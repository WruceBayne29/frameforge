/**
 * The three.js side of the 3D viewer: renderer, camera and orbit controls, the scene layers
 * built from `build.ts` arrays (merged buffers and instanced meshes), picking, hover
 * highlight, the axis triad and PNG capture. Rendering happens on demand only.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import {
  isPlane,
  modelBounds3D,
  modelSize3D,
  nodalField,
  resultScales3D,
  type DiagramKind3D,
  type Project3D,
} from '../../model3d';
import type { AnalysisResult3D } from '../../solver3d';
import type {
  CameraPreset,
  Pick3D,
  Selection3D,
  SelectionKind,
  Tool3D,
  ToolOptions3D,
  ViewOptions3D,
} from '../state';
import { pickKindsFor, usesPlane } from '../interaction';
import {
  deformedMemberSegments,
  displacedPositions,
  gridSegments,
  idLabels,
  loadArrows,
  memberDiagram,
  niceSpacing,
  nodePositions,
  plateSurface,
  reactionArrows,
  snap,
  solidSurface,
  subsetProject,
  supportGlyphs,
  symbolSizes,
} from './build';
import type {
  Arrow,
  ArrowSet,
  Glyph,
  GlyphShape,
  Label,
  Positions,
  Sizes,
  Surface,
  Vec3,
} from './build';
import type { Palette } from './palette';

export interface SceneInput {
  project: Project3D;
  result: AnalysisResult3D | null;
  view: ViewOptions3D;
  selection: Selection3D | null;
  pending: string[];
  tool: Tool3D;
  toolOptions: ToolOptions3D;
  palette: Palette;
  /** Item the solver blamed for a failed analysis, drawn in the error colour. */
  problem: Pick3D | null;
}

export interface PointerHit {
  pick: Pick3D | null;
  plane: Vec3 | null;
}

export interface ViewerCallbacks {
  onClick: (hit: PointerHit, additive: boolean) => void;
  /** Pointer moved over the scene (throttled to animation frames). */
  onHover?: (hit: PointerHit) => void;
  /**
   * Node dragging (plane frame mode, select tool): the drag starts on a node and moves it
   * over the z = 0 plane, snapped like the drawing tools.
   */
  onDragStart?: (node: string) => void;
  onDrag?: (node: string, point: Vec3) => void;
  onDragEnd?: (node: string) => void;
}

type LayerName =
  'grid' | 'model' | 'supports' | 'loads' | 'results' | 'labels' | 'selection' | 'hover';

const LAYERS: LayerName[] = [
  'grid',
  'model',
  'supports',
  'loads',
  'results',
  'labels',
  'selection',
  'hover',
];

/** Data kept on pickable objects: which item each instance / triangle belongs to. */
interface PickData {
  kind: SelectionKind;
  owners: string[];
}

const UP = new THREE.Vector3(0, 1, 0);
const tmpMatrix = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpVec = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const tmpDir = new THREE.Vector3();

/** Rotation taking +Y onto `direction` (a shared quaternion: use it before calling again). */
function orient(direction: Vec3): THREE.Quaternion {
  tmpDir.set(direction[0], direction[1], direction[2]);
  if (tmpDir.lengthSq() === 0) return tmpQuat.identity();
  return tmpQuat.setFromUnitVectors(UP, tmpDir.normalize());
}

const color = (css: string) => new THREE.Color(css);

/** Releases the GPU resources of everything in a group and removes its labels from the DOM. */
function disposeTree(root: THREE.Object3D): void {
  root.traverse((object) => {
    const o = object as THREE.Mesh;
    if (o.geometry) o.geometry.dispose();
    const material = o.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else material?.dispose();
    if (object instanceof THREE.InstancedMesh) object.dispose();
    if (object instanceof CSS2DObject) object.element.remove();
  });
}

const sameDeps = (a: unknown[] | undefined, b: unknown[]) =>
  !!a && a.length === b.length && a.every((v, k) => v === b[k]);

const CAMERA_DIRECTIONS: Record<Exclude<CameraPreset, 'fit'>, Vec3> = {
  iso: [1, 0.75, 1.25],
  top: [0, 1, 0.0001],
  front: [0, 0, 1],
  side: [1, 0, 0],
};

export class ViewerEngine {
  private readonly container: HTMLElement;
  private readonly callbacks: ViewerCallbacks;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly labelRenderer: CSS2DRenderer;
  private readonly scene = new THREE.Scene();
  private readonly perspective = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  private readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
  /** The active camera: orthographic front view in plane frame mode, perspective otherwise. */
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.perspective;
  /** Half the height of the orthographic view at zoom 1. */
  private orthoHalf = 5;
  private plane = false;
  private drag: { node: string; moved: boolean; frame: number; last: PointerEvent | null } | null =
    null;
  private readonly controls: OrbitControls;
  private readonly groups = {} as Record<LayerName, THREE.Group>;
  private readonly deps: Partial<Record<LayerName, unknown[]>> = {};
  private readonly lineMaterials = new Set<LineMaterial>();
  private readonly triadScene = new THREE.Scene();
  private readonly triadCamera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
  private readonly triad = new THREE.Group();
  private readonly resizeObserver: ResizeObserver;
  private input: SceneInput | null = null;
  private sizes: Sizes | null = null;
  private sizesFor: Project3D | null = null;
  /** Positions the elements are currently drawn at (deformed when that is shown). */
  private displayPos: Positions = new Map();
  private loadSet: ArrowSet | null = null;
  private hover: PointerHit = { pick: null, plane: null };
  private frame = 0;
  private hoverFrame = 0;
  private lastPointer: { x: number; y: number; type: string } | null = null;
  private down: { x: number; y: number; time: number } | null = null;
  private width = 1;
  private height = 1;
  private disposed = false;

  constructor(container: HTMLElement, callbacks: ViewerCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.domElement.setAttribute('aria-label', '3D model view');
    this.renderer.domElement.setAttribute('role', 'img');
    container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = 'label3d-layer';
    container.appendChild(this.labelRenderer.domElement);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8090a0, 1.6));
    for (const camera of [this.perspective, this.ortho]) {
      const sun = new THREE.DirectionalLight(0xffffff, 1.5);
      sun.position.set(0.4, 1, 0.6);
      camera.add(sun);
      this.scene.add(camera);
    }
    for (const name of LAYERS) {
      const group = new THREE.Group();
      group.name = name;
      this.groups[name] = group;
      this.scene.add(group);
    }

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => this.requestRender());

    this.triadCamera.position.set(0, 0, 5);
    this.triadCamera.lookAt(0, 0, 0);
    this.triadScene.add(this.triad);

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('contextmenu', this.onContextMenu);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  // ---- Public API ---------------------------------------------------------------------

  update(input: SceneInput): void {
    const previous = this.input;
    this.input = input;
    const { project, result, view, palette } = input;
    if (this.sizesFor !== project) {
      this.sizes = symbolSizes(project, modelSize3D(project));
      this.sizesFor = project;
    }
    if (!previous || previous.palette !== palette) {
      this.renderer.setClearColor(color(palette.background));
      this.buildTriad(palette);
    }
    this.setPlaneMode(isPlane(project));
    const plane = usesPlane(input.tool);
    const o = input.toolOptions;
    this.layer('grid', [project, plane, o.elevation, o.grid, view.grid, palette, this.plane], () =>
      this.buildGrid(),
    );
    this.layer(
      'model',
      [project, result, view.deformed, view.deformScale, view.contour, palette],
      () => this.buildModel(),
    );
    this.layer('supports', [project, view.supports, palette], () => this.buildSupports());
    this.layer('loads', [project, view.loads, palette], () => this.buildLoads());
    this.layer(
      'results',
      [
        project,
        result,
        view.deformed,
        view.deformScale,
        view.diagram,
        view.diagramScale,
        view.reactions,
        palette,
        input.selection,
      ],
      () => this.buildResults(),
    );
    this.layer('labels', [project, view.labels, palette], () => this.buildLabels());
    this.layer(
      'selection',
      [
        project,
        result,
        view.deformed,
        view.deformScale,
        view.loads,
        input.selection,
        input.pending,
        input.problem,
        palette,
      ],
      () => this.buildSelection(),
    );
    if (previous && (previous.tool !== input.tool || previous.toolOptions !== input.toolOptions)) {
      this.hover = { pick: null, plane: null };
      this.deps.hover = undefined;
    }
    this.layer(
      'hover',
      [
        this.hover.pick?.kind,
        this.hover.pick?.id,
        this.hover.plane?.join(),
        this.groups.selection.children.length,
        palette,
      ],
      () => this.buildHover(),
    );
    this.container.classList.toggle('cursor-crosshair', plane);
    this.requestRender();
  }

  /** Switches between the free 3D view and the locked orthographic front view. */
  private setPlaneMode(plane: boolean): void {
    if (plane === this.plane) return;
    this.plane = plane;
    this.camera = plane ? this.ortho : this.perspective;
    this.controls.object = this.camera;
    this.controls.enableRotate = !plane;
    this.setCamera(plane ? 'front' : 'iso');
  }

  /** Fits the orthographic front view to the model (plane frame mode). */
  private fitOrtho(bounds: { min: number[]; max: number[] }): void {
    const aspect = this.width / Math.max(this.height, 1);
    const cx = (bounds.min[0] + bounds.max[0]) / 2;
    const cy = (bounds.min[1] + bounds.max[1]) / 2;
    const w = bounds.max[0] - bounds.min[0];
    const h = bounds.max[1] - bounds.min[1];
    // Margins leave room for supports, reaction arrows and diagram labels around the frame.
    const margin = 0.14 * Math.max(w, h, 1);
    this.orthoHalf = Math.max(h / 2 + margin, (w / 2 + margin) / aspect, 1);
    const depth = Math.max(w, h, 10) * 4;
    this.ortho.position.set(cx, cy, depth);
    this.ortho.near = depth / 100;
    this.ortho.far = depth * 4;
    this.ortho.zoom = 1;
    this.updateOrthoFrustum();
    this.controls.target.set(cx, cy, 0);
    this.controls.update();
    this.requestRender();
  }

  private updateOrthoFrustum(): void {
    const aspect = this.width / Math.max(this.height, 1);
    this.ortho.top = this.orthoHalf;
    this.ortho.bottom = -this.orthoHalf;
    this.ortho.left = -this.orthoHalf * aspect;
    this.ortho.right = this.orthoHalf * aspect;
    this.ortho.updateProjectionMatrix();
  }

  /** Points the camera along a preset direction (or keeps the direction for "fit") and fits the model. */
  setCamera(preset: CameraPreset): void {
    const project = this.input?.project;
    const bounds = project ? modelBounds3D(project) : { min: [-2, 0, -2], max: [10, 6, 10] };
    if (this.plane) {
      // Plane frame mode: always the front view; every preset just fits it.
      this.fitOrtho(bounds);
      return;
    }
    const camera = this.perspective;
    const center = new THREE.Vector3(
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    );
    const radius = Math.max(
      0.5 *
        Math.hypot(
          bounds.max[0] - bounds.min[0],
          bounds.max[1] - bounds.min[1],
          bounds.max[2] - bounds.min[2],
        ),
      0.5,
    );
    const direction =
      preset === 'fit'
        ? camera.position.clone().sub(this.controls.target).normalize()
        : new THREE.Vector3(...CAMERA_DIRECTIONS[preset]).normalize();
    if (direction.lengthSq() === 0) direction.set(1, 0.75, 1.25).normalize();
    const vertical = THREE.MathUtils.degToRad(camera.fov) / 2;
    const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
    const distance = (radius * 1.12) / Math.sin(Math.min(vertical, horizontal));
    camera.position.copy(center).addScaledVector(direction, distance);
    camera.near = distance / 200;
    camera.far = distance * 200;
    camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    this.requestRender();
  }

  /** The current view as a PNG data URL, with the labels drawn in. */
  capture(): string {
    this.renderNow();
    const source = this.renderer.domElement;
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return source.toDataURL('image/png');
    ctx.drawImage(source, 0, 0);
    const ratio = source.width / Math.max(this.width, 1);
    const p = new THREE.Vector3();
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    this.scene.traverseVisible((object) => {
      if (!(object instanceof CSS2DObject)) return;
      const element = object.element;
      if (element.style.display === 'none' || !element.textContent) return;
      object.getWorldPosition(p).project(this.camera);
      if (p.z < -1 || p.z > 1) return;
      const style = getComputedStyle(element);
      const x = ((p.x + 1) / 2) * source.width;
      const y = ((1 - p.y) / 2) * source.height;
      ctx.font = `${style.fontWeight} ${11 * ratio}px system-ui, sans-serif`;
      const w = ctx.measureText(element.textContent).width;
      const nodeLabel = element.classList.contains('node');
      const lx = nodeLabel ? x + 6 * ratio : x - w / 2;
      const ly = nodeLabel ? y - 6 * ratio : y;
      ctx.strokeStyle = this.input?.palette.background ?? '#fff';
      ctx.lineWidth = 3 * ratio;
      ctx.strokeText(element.textContent, lx, ly);
      ctx.fillStyle = style.color;
      ctx.fillText(element.textContent, lx, ly);
    });
    return canvas.toDataURL('image/png');
  }

  /** Page coordinates of a node, or null when it is off screen (used by automated tests). */
  nodeScreenPosition(id: string): { x: number; y: number } | null {
    const n = this.input?.project.nodes.find((node) => node.id === id);
    if (!n) return null;
    this.camera.updateMatrixWorld();
    const p = new THREE.Vector3(n.x, n.y, n.z).project(this.camera);
    if (p.z < -1 || p.z > 1) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + ((p.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - p.y) / 2) * rect.height,
    };
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.hoverFrame);
    this.resizeObserver.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointerleave', this.onPointerLeave);
    canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.controls.dispose();
    for (const name of LAYERS) disposeTree(this.groups[name]);
    disposeTree(this.triad);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    canvas.remove();
    this.labelRenderer.domElement.remove();
  }

  // ---- Rendering ----------------------------------------------------------------------

  requestRender(): void {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderNow();
    });
  }

  private renderNow(): void {
    if (this.disposed) return;
    const r = this.renderer;
    r.setScissorTest(false);
    r.setViewport(0, 0, this.width, this.height);
    r.autoClear = true;
    r.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
    // Axis triad in the bottom-left corner, turned with the camera.
    const s = Math.min(84, Math.floor(Math.min(this.width, this.height) / 3));
    this.triad.quaternion.copy(this.camera.quaternion).invert();
    r.autoClear = false;
    r.clearDepth();
    r.setScissorTest(true);
    r.setScissor(6, 6, s, s);
    r.setViewport(6, 6, s, s);
    r.render(this.triadScene, this.triadCamera);
    r.setScissorTest(false);
    r.setViewport(0, 0, this.width, this.height);
    r.autoClear = true;
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height);
    this.labelRenderer.setSize(width, height);
    this.perspective.aspect = width / height;
    this.perspective.updateProjectionMatrix();
    this.updateOrthoFrustum();
    for (const m of this.lineMaterials) m.resolution.set(width, height);
    this.renderNow();
  }

  // ---- Layers -------------------------------------------------------------------------

  private layer(name: LayerName, deps: unknown[], build: () => THREE.Object3D[]): void {
    if (sameDeps(this.deps[name], deps)) return;
    this.deps[name] = deps;
    const group = this.groups[name];
    for (const child of [...group.children]) {
      group.remove(child);
      disposeTree(child);
    }
    for (const m of [...this.lineMaterials]) {
      // Materials of disposed lines are dropped from the resize list.
      if (!this.isAttached(m)) this.lineMaterials.delete(m);
    }
    for (const object of build()) group.add(object);
  }

  private isAttached(material: LineMaterial): boolean {
    let found = false;
    this.scene.traverse((o) => {
      if ((o as LineSegments2).material === material) found = true;
    });
    return found;
  }

  private fatLines(
    segments: Float32Array,
    css: string,
    width: number,
    opacity = 1,
  ): LineSegments2 | null {
    if (segments.length === 0) return null;
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(segments);
    const material = new LineMaterial({
      color: color(css).getHex(),
      linewidth: width,
      transparent: opacity < 1,
      opacity,
    });
    material.resolution.set(this.width, this.height);
    this.lineMaterials.add(material);
    return new LineSegments2(geometry, material);
  }

  private thinLines(segments: Float32Array, css: string, opacity = 1): THREE.LineSegments | null {
    if (segments.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(segments, 3));
    const material = new THREE.LineBasicMaterial({
      color: color(css),
      transparent: opacity < 1,
      opacity,
    });
    return new THREE.LineSegments(geometry, material);
  }

  private surfaceMesh(
    surface: Surface,
    material: THREE.Material,
    pick?: SelectionKind,
  ): THREE.Mesh | null {
    if (surface.positions.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(surface.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(surface.normals, 3));
    if (surface.colors) {
      // Contour colours are sRGB; vertex colours are expected in linear space.
      const linear = new Float32Array(surface.colors.length);
      const c = new THREE.Color();
      for (let k = 0; k < linear.length; k += 3) {
        c.setRGB(
          surface.colors[k],
          surface.colors[k + 1],
          surface.colors[k + 2],
          THREE.SRGBColorSpace,
        );
        linear[k] = c.r;
        linear[k + 1] = c.g;
        linear[k + 2] = c.b;
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(linear, 3));
    }
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    if (pick) mesh.userData.pick = { kind: pick, owners: surface.owners } satisfies PickData;
    return mesh;
  }

  /** Instanced spheres at node positions. */
  private spheres(
    ids: string[],
    pos: Positions,
    radius: number,
    css: string,
    opacity = 1,
    pick = true,
  ): THREE.InstancedMesh | null {
    const list = ids.filter((id) => pos.has(id));
    if (list.length === 0) return null;
    const mesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 14, 10),
      new THREE.MeshLambertMaterial({ color: color(css), transparent: opacity < 1, opacity }),
      list.length,
    );
    list.forEach((id, k) => {
      const p = pos.get(id) as Vec3;
      tmpMatrix.compose(
        tmpVec.set(p[0], p[1], p[2]),
        tmpQuat.identity(),
        tmpScale.set(radius, radius, radius),
      );
      mesh.setMatrixAt(k, tmpMatrix);
    });
    mesh.computeBoundingSphere();
    if (pick) mesh.userData.pick = { kind: 'node', owners: list } satisfies PickData;
    return mesh;
  }

  /** Instanced tubes for members. */
  private tubes(
    project: Project3D,
    pos: Positions,
    radius: (type: 'beam' | 'truss') => number,
    colour: (type: 'beam' | 'truss') => string,
    opacity = 1,
    pick = true,
  ): THREE.InstancedMesh | null {
    const list = project.members.filter((m) => pos.has(m.i) && pos.has(m.j));
    if (list.length === 0) return null;
    const mesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(1, 1, 1, 10, 1),
      new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: opacity < 1, opacity }),
      list.length,
    );
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Color();
    list.forEach((m, k) => {
      a.fromArray(pos.get(m.i) as Vec3);
      b.fromArray(pos.get(m.j) as Vec3);
      const length = a.distanceTo(b);
      const direction = b.clone().sub(a);
      const r = radius(m.type);
      tmpMatrix.compose(
        a.clone().add(b).multiplyScalar(0.5),
        orient([direction.x, direction.y, direction.z]),
        tmpScale.set(r, Math.max(length, 1e-9), r),
      );
      mesh.setMatrixAt(k, tmpMatrix);
      mesh.setColorAt(k, c.set(colour(m.type)));
    });
    mesh.computeBoundingSphere();
    if (pick)
      mesh.userData.pick = { kind: 'member', owners: list.map((m) => m.id) } satisfies PickData;
    return mesh;
  }

  private arrowsMesh(arrows: Arrow[], css: string, head: number, pick: boolean): THREE.Object3D[] {
    if (arrows.length === 0) return [];
    const shaft = new THREE.CylinderGeometry(1, 1, 1, 8, 1);
    shaft.translate(0, 0.5, 0);
    const cone = new THREE.ConeGeometry(1, 1, 14, 1);
    cone.translate(0, -0.5, 0);
    const material = () => new THREE.MeshLambertMaterial({ color: color(css) });
    const heads = arrows.reduce((n, a) => n + (a.moment ? 2 : 1), 0);
    const shafts = new THREE.InstancedMesh(shaft, material(), arrows.length);
    const cones = new THREE.InstancedMesh(cone, material(), heads);
    const headOwners: string[] = [];
    const rs = head * 0.09;
    const rh = head * 0.36;
    let h = 0;
    arrows.forEach((arrow, k) => {
      const d = arrow.direction;
      const length = Math.max(arrow.length, head * 1.3);
      const q = orient(d).clone();
      const tail: Vec3 = [
        arrow.tip[0] - d[0] * length,
        arrow.tip[1] - d[1] * length,
        arrow.tip[2] - d[2] * length,
      ];
      tmpMatrix.compose(tmpVec.fromArray(tail), q, tmpScale.set(rs, length - head, rs));
      shafts.setMatrixAt(k, tmpMatrix);
      tmpMatrix.compose(tmpVec.fromArray(arrow.tip), q, tmpScale.set(rh, head, rh));
      cones.setMatrixAt(h++, tmpMatrix);
      headOwners.push(arrow.owner);
      if (arrow.moment) {
        const second: Vec3 = [
          arrow.tip[0] - d[0] * head * 0.8,
          arrow.tip[1] - d[1] * head * 0.8,
          arrow.tip[2] - d[2] * head * 0.8,
        ];
        tmpMatrix.compose(tmpVec.fromArray(second), q, tmpScale.set(rh, head, rh));
        cones.setMatrixAt(h++, tmpMatrix);
        headOwners.push(arrow.owner);
      }
    });
    shafts.computeBoundingSphere();
    cones.computeBoundingSphere();
    if (pick) {
      shafts.userData.pick = {
        kind: 'load',
        owners: arrows.map((a) => a.owner),
      } satisfies PickData;
      cones.userData.pick = { kind: 'load', owners: headOwners } satisfies PickData;
    }
    return [shafts, cones];
  }

  private labels(list: Label[]): THREE.Object3D[] {
    return list.map((label) => {
      const element = document.createElement('div');
      element.className = `lbl3d ${label.kind}`;
      element.textContent = label.text;
      const object = new CSS2DObject(element);
      object.position.set(label.position[0], label.position[1], label.position[2]);
      return object;
    });
  }

  private buildGrid(): THREE.Object3D[] {
    const input = this.input as SceneInput;
    const { project, toolOptions: o, view, palette } = input;
    const plane = usesPlane(input.tool);
    if (!view.grid && !plane) return [];
    const bounds = modelBounds3D(project);
    if (this.plane) {
      // Plane frame mode: the drawing grid lies in the z = 0 plane, at the snap spacing.
      const size2 = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], 4);
      let step = o.snap ? o.grid : niceSpacing(size2, 16);
      const extent = Math.max(size2 * 0.9, 6 * step, 5);
      while (extent / step > 120) step *= 2;
      const every = Math.max(1, Math.round(niceSpacing(size2, 10) / step));
      const [minor2, major2] = gridSegments({
        cx: (bounds.min[0] + bounds.max[0]) / 2,
        cz: (bounds.min[1] + bounds.max[1]) / 2,
        half: Math.ceil(extent / (step * every)) * step * every,
        y: 0,
        spacing: step,
        majorEvery: every,
        plane: 'XY',
      });
      return [
        this.thinLines(minor2, palette.grid),
        this.thinLines(major2, palette.gridMajor),
      ].filter((x): x is THREE.LineSegments => !!x);
    }
    const size = modelSize3D(project);
    let spacing = plane ? o.grid : niceSpacing(size, 16);
    const half = Math.max(size * 0.75, 5 * spacing, 4);
    while (half / spacing > 120) spacing *= 2;
    const majorEvery = plane ? Math.max(1, Math.round(niceSpacing(size, 10) / spacing)) : 5;
    const [minor, major] = gridSegments({
      cx: (bounds.min[0] + bounds.max[0]) / 2,
      cz: (bounds.min[2] + bounds.max[2]) / 2,
      half: Math.ceil(half / (spacing * majorEvery)) * spacing * majorEvery,
      y: plane ? o.elevation : project.nodes.length > 0 ? bounds.min[1] : 0,
      spacing,
      majorEvery,
    });
    return [this.thinLines(minor, palette.grid), this.thinLines(major, palette.gridMajor)].filter(
      (x): x is THREE.LineSegments => !!x,
    );
  }

  private buildModel(): THREE.Object3D[] {
    const input = this.input as SceneInput;
    const { project, result, view, palette } = input;
    const sizes = this.sizes as Sizes;
    const out: Array<THREE.Object3D | null> = [];
    const base = nodePositions(project);
    const deformed = view.deformed && result;
    const factor = result ? resultScales3D(project, result, view.deformScale).deform : 0;
    const pos = deformed ? displacedPositions(project, result, factor) : base;
    this.displayPos = pos;

    out.push(
      this.spheres(
        project.nodes.map((n) => n.id),
        base,
        sizes.node,
        palette.node,
      ),
    );
    out.push(
      this.tubes(
        project,
        base,
        (t) => (t === 'truss' ? sizes.truss : sizes.beam),
        (t) => (t === 'truss' ? palette.truss : palette.beam),
      ),
    );

    const contour =
      view.contour !== 'none' && result ? nodalField(project, result, view.contour) : null;
    const field = contour && Object.keys(contour.values).length > 0 ? contour : null;
    if (project.plates.length > 0) {
      const surface = plateSurface(project, pos, field);
      const material = field
        ? new THREE.MeshBasicMaterial({
            vertexColors: true,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1,
          })
        : new THREE.MeshLambertMaterial({
            color: color(palette.plate),
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.55,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1,
          });
      out.push(this.surfaceMesh(surface, material, 'plate'));
      out.push(
        this.thinLines(
          surface.edges,
          field ? palette.solidEdge : palette.plateEdge,
          field ? 0.45 : 0.8,
        ),
      );
      if (deformed) out.push(this.thinLines(plateSurface(project, base).edges, palette.muted, 0.3));
    }
    if (project.solids.length > 0) {
      const surface = solidSurface(project, pos, field);
      const material = field
        ? new THREE.MeshBasicMaterial({
            vertexColors: true,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1,
          })
        : new THREE.MeshLambertMaterial({
            color: color(palette.solid),
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1,
          });
      out.push(this.surfaceMesh(surface, material, 'solid'));
      out.push(this.thinLines(surface.edges, palette.solidEdge, field ? 0.45 : 0.75));
      if (deformed) out.push(this.thinLines(solidSurface(project, base).edges, palette.muted, 0.3));
    }
    return out.filter((x): x is THREE.Object3D => !!x);
  }

  private buildSupports(): THREE.Object3D[] {
    const { project, view, palette } = this.input as SceneInput;
    if (!view.supports) return [];
    const glyphs = supportGlyphs(project);
    const g = (this.sizes as Sizes).glyph;
    const geometries: Record<GlyphShape, () => THREE.BufferGeometry> = {
      base: () => new THREE.BoxGeometry(1.5, 0.3, 1.5).translate(0, -0.15, 0),
      pyramid: () =>
        new THREE.ConeGeometry(0.62, 1, 4, 1).rotateY(Math.PI / 4).translate(0, -0.5, 0),
      roller: () =>
        new THREE.CylinderGeometry(0.14, 0.14, 1.1, 12).rotateZ(Math.PI / 2).translate(0, -1.14, 0),
      cone: () => new THREE.ConeGeometry(0.26, 0.7, 12).translate(0, -0.35 - 0.12, 0),
      cube: () => new THREE.BoxGeometry(0.42, 0.42, 0.42),
    };
    const out: THREE.Object3D[] = [];
    for (const shape of Object.keys(geometries) as GlyphShape[]) {
      const list: Glyph[] = glyphs.filter((x) => x.shape === shape);
      if (list.length === 0) continue;
      const mesh = new THREE.InstancedMesh(
        geometries[shape](),
        new THREE.MeshLambertMaterial({ color: color(palette.support) }),
        list.length,
      );
      list.forEach((glyph, k) => {
        tmpMatrix.compose(
          tmpVec.fromArray(glyph.position),
          orient(glyph.direction),
          tmpScale.set(g, g, g),
        );
        mesh.setMatrixAt(k, tmpMatrix);
      });
      mesh.computeBoundingSphere();
      mesh.userData.pick = { kind: 'node', owners: list.map((x) => x.node) } satisfies PickData;
      out.push(mesh);
    }
    return out;
  }

  private buildLoads(): THREE.Object3D[] {
    const { project, view, palette } = this.input as SceneInput;
    const sizes = this.sizes as Sizes;
    this.loadSet = loadArrows(project, sizes.arrow);
    if (!view.loads) return [];
    const set = this.loadSet;
    const out: Array<THREE.Object3D | null> = [
      ...this.arrowsMesh(set.arrows, palette.load, sizes.arrow * 0.22, true),
      this.fatLines(set.lines, palette.load, 1.5),
      ...this.labels(set.labels),
    ];
    return out.filter((x): x is THREE.Object3D => !!x);
  }

  private buildResults(): THREE.Object3D[] {
    const input = this.input as SceneInput;
    const { project, result, view, palette, selection } = input;
    if (!result) return [];
    const sizes = this.sizes as Sizes;
    const scales = resultScales3D(project, result, view.deformScale, view.diagramScale);
    const out: Array<THREE.Object3D | null> = [];
    if (view.deformed && project.members.length > 0) {
      out.push(
        this.fatLines(
          deformedMemberSegments(project, result, scales.deform),
          palette.deformed,
          2.4,
        ),
      );
    }
    if (view.diagram !== 'none' && project.members.length > 0) {
      const kind: DiagramKind3D = view.diagram;
      const emphasise = new Set(selection?.kind === 'member' ? selection.ids : []);
      const d = memberDiagram(project, result, kind, scales.diagram[kind], emphasise);
      const main =
        kind === 'N'
          ? palette.tension
          : kind === 'T'
            ? palette.torsion
            : kind.startsWith('V')
              ? palette.shear
              : palette.moment;
      const negative = kind === 'N' ? palette.compression : main;
      const fill = (array: Float32Array, css: string) => {
        if (array.length === 0) return null;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(array, 3));
        return new THREE.Mesh(
          geometry,
          new THREE.MeshBasicMaterial({
            color: color(css),
            transparent: true,
            opacity: 0.3,
            side: THREE.DoubleSide,
            depthWrite: false,
          }),
        );
      };
      out.push(fill(d.positive, main), fill(d.negative, negative));
      out.push(this.fatLines(d.outline, main, 1.4, 0.9));
      out.push(...this.labels(d.labels));
    }
    if (view.reactions) {
      const set = reactionArrows(project, result, sizes.arrow, sizes.glyph * 1.2);
      out.push(...this.arrowsMesh(set.arrows, palette.reaction, sizes.arrow * 0.22, false));
      out.push(...this.labels(set.labels));
    }
    return out.filter((x): x is THREE.Object3D => !!x);
  }

  private buildLabels(): THREE.Object3D[] {
    const { project, view } = this.input as SceneInput;
    return view.labels ? this.labels(idLabels(project)) : [];
  }

  /** Highlight geometry for some items, drawn over the model. */
  private highlight(
    kind: SelectionKind,
    ids: string[],
    css: string,
    strength: number,
  ): THREE.Object3D[] {
    const { project } = this.input as SceneInput;
    const sizes = this.sizes as Sizes;
    const base = nodePositions(project);
    switch (kind) {
      case 'node': {
        const mesh = this.spheres(ids, base, sizes.node * (1.7 + strength * 0.9), css, 0.9, false);
        return mesh ? [mesh] : [];
      }
      case 'member': {
        const subset = subsetProject(project, 'member', ids);
        const mesh = this.tubes(
          subset,
          base,
          (t) => (t === 'truss' ? sizes.truss : sizes.beam) * (1.7 + strength * 0.8),
          () => css,
          0.95,
          false,
        );
        return mesh ? [mesh] : [];
      }
      case 'plate':
      case 'solid': {
        const subset = subsetProject(project, kind, ids);
        const surface =
          kind === 'plate'
            ? plateSurface(subset, this.displayPos)
            : solidSurface(subset, this.displayPos);
        const material = new THREE.MeshBasicMaterial({
          color: color(css),
          transparent: true,
          opacity: 0.25 + 0.2 * strength,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const items: Array<THREE.Object3D | null> = [
          this.surfaceMesh(surface, material),
          this.fatLines(surface.edges, css, 2 + strength),
        ];
        return items.filter((x): x is THREE.Object3D => !!x);
      }
      case 'load': {
        const set = this.loadSet;
        if (!set || !(this.input as SceneInput).view.loads) return [];
        const keep = new Set(ids);
        return this.arrowsMesh(
          set.arrows.filter((a) => keep.has(a.owner)),
          css,
          sizes.arrow * 0.24,
          false,
        );
      }
    }
  }

  private buildSelection(): THREE.Object3D[] {
    const { selection, pending, problem, palette } = this.input as SceneInput;
    const out: THREE.Object3D[] = [];
    if (selection) out.push(...this.highlight(selection.kind, selection.ids, palette.accent, 1));
    if (pending.length > 0) out.push(...this.highlight('node', pending, palette.hover, 1));
    if (problem) out.push(...this.highlight(problem.kind, [problem.id], palette.compression, 1));
    return out;
  }

  private buildHover(): THREE.Object3D[] {
    const input = this.input as SceneInput;
    const out: THREE.Object3D[] = [];
    const { pick, plane } = this.hover;
    if (pick) out.push(...this.highlight(pick.kind, [pick.id], input.palette.hover, 0));
    else if (plane) {
      const marker = this.spheres(
        ['cursor'],
        new Map([['cursor', plane]]),
        (this.sizes as Sizes).node * 1.6,
        input.palette.accent,
        0.6,
        false,
      );
      if (marker) out.push(marker);
    }
    return out;
  }

  private buildTriad(palette: Palette): void {
    disposeTree(this.triad);
    this.triad.clear();
    const axes: Array<[Vec3, string, string]> = [
      [[1, 0, 0], palette.axisX, 'X'],
      [[0, 1, 0], palette.axisY, 'Y'],
      [[0, 0, 1], palette.axisZ, 'Z'],
    ];
    for (const [d, css, name] of axes) {
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.045, 0.045, 0.8, 8).translate(0, 0.4, 0),
        new THREE.MeshBasicMaterial({ color: color(css) }),
      );
      shaft.quaternion.copy(orient(d));
      const head = new THREE.Mesh(
        new THREE.ConeGeometry(0.13, 0.32, 12).translate(0, 0.96, 0),
        new THREE.MeshBasicMaterial({ color: color(css) }),
      );
      head.quaternion.copy(orient(d));
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.font = 'bold 44px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = css;
        ctx.fillText(name, 32, 34);
      }
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
      sprite.position.set(d[0] * 1.38, d[1] * 1.38, d[2] * 1.38);
      sprite.scale.set(0.55, 0.55, 0.55);
      this.triad.add(shaft, head, sprite);
    }
  }

  // ---- Picking ------------------------------------------------------------------------

  private ndc(x: number, y: number): THREE.Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((x - rect.left) / rect.width) * 2 - 1,
      -((y - rect.top) / rect.height) * 2 + 1,
    );
  }

  /** Nearest node to the pointer on screen, within `radius` pixels. */
  private nearestNode(x: number, y: number, radius: number): string | null {
    const input = this.input;
    if (!input) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = x - rect.left;
    const py = y - rect.top;
    const p = new THREE.Vector3();
    let best: string | null = null;
    let bestD = radius * radius;
    let bestDepth = Infinity;
    for (const n of input.project.nodes) {
      p.set(n.x, n.y, n.z).project(this.camera);
      if (p.z < -1 || p.z > 1) continue;
      const sx = ((p.x + 1) / 2) * rect.width;
      const sy = ((1 - p.y) / 2) * rect.height;
      const d = (sx - px) ** 2 + (sy - py) ** 2;
      // Prefer the closest on screen; break near-ties by depth (nearer wins).
      if (d < bestD - 1 || (Math.abs(d - bestD) <= 1 && p.z < bestDepth)) {
        best = n.id;
        bestD = d;
        bestDepth = p.z;
      }
    }
    return best;
  }

  private hitTest(x: number, y: number, touch: boolean): PointerHit {
    const input = this.input;
    if (!input) return { pick: null, plane: null };
    const kinds = pickKindsFor(input.tool, input.toolOptions);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(this.ndc(x, y), this.camera);
    const plane = usesPlane(input.tool) ? this.planePoint(raycaster) : null;

    if (kinds.includes('node')) {
      const node = this.nearestNode(x, y, touch ? 22 : 11);
      if (node) return { pick: { kind: 'node', id: node }, plane };
    }
    const sizes = this.sizes as Sizes;
    raycaster.params.Line = { threshold: sizes.node };
    const targets: THREE.Object3D[] = [];
    for (const name of ['model', 'supports', 'loads'] as LayerName[]) {
      for (const child of this.groups[name].children) {
        const data = child.userData.pick as PickData | undefined;
        if (data && kinds.includes(data.kind)) targets.push(child);
      }
    }
    for (const hit of raycaster.intersectObjects(targets, false)) {
      const data = hit.object.userData.pick as PickData;
      const index = hit.instanceId ?? hit.faceIndex ?? undefined;
      const id = index !== undefined ? data.owners[index] : undefined;
      if (id) return { pick: { kind: data.kind, id }, plane };
    }
    return { pick: null, plane };
  }

  /**
   * Snapped point on the working plane under the ray: the horizontal plane at the working
   * elevation, or the z = 0 plane in plane frame mode.
   */
  private planePoint(raycaster: THREE.Raycaster): Vec3 | null {
    const o = (this.input as SceneInput).toolOptions;
    if (this.plane) {
      const p = raycaster.ray.intersectPlane(
        new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
        new THREE.Vector3(),
      );
      if (!p) return null;
      const step = o.snap ? o.grid : 0;
      return [snap(p.x, step), snap(p.y, step), 0];
    }
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -o.elevation);
    const p = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (!p) return null;
    const step = o.snap ? o.grid : 0;
    return [snap(p.x, step), o.elevation, snap(p.z, step)];
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY, time: performance.now() };
    const input = this.input;
    if (!this.plane || !input || input.tool !== 'select' || e.button !== 0) return;
    const hit = this.hitTest(e.clientX, e.clientY, e.pointerType === 'touch');
    if (hit.pick?.kind !== 'node') return;
    // Start dragging the node: the view must not pan while it moves.
    this.drag = { node: hit.pick.id, moved: false, frame: 0, last: null };
    this.controls.enabled = false;
    this.renderer.domElement.setPointerCapture?.(e.pointerId);
  };

  /** Moves the dragged node to the plane point under the pointer (once per frame). */
  private dragTo(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    const down = this.down;
    if (!drag.moved) {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) <= 4) return;
      drag.moved = true;
      this.callbacks.onDragStart?.(drag.node);
    }
    drag.last = e;
    if (drag.frame) return;
    drag.frame = requestAnimationFrame(() => {
      drag.frame = 0;
      const last = drag.last;
      if (!last || this.drag !== drag) return;
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(this.ndc(last.clientX, last.clientY), this.camera);
      const point = this.planePoint(raycaster);
      if (point) this.callbacks.onDrag?.(drag.node, point);
    });
  }

  private readonly onPointerMove = (e: PointerEvent) => {
    if (this.drag) {
      this.dragTo(e);
      return;
    }
    if (e.pointerType === 'touch') return;
    this.lastPointer = { x: e.clientX, y: e.clientY, type: e.pointerType };
    if (e.buttons !== 0) return;
    if (this.hoverFrame) return;
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0;
      const pointer = this.lastPointer;
      if (!pointer || !this.input) return;
      const hit = this.hitTest(pointer.x, pointer.y, false);
      const same =
        hit.pick?.kind === this.hover.pick?.kind &&
        hit.pick?.id === this.hover.pick?.id &&
        hit.plane?.join() === this.hover.plane?.join();
      if (same) return;
      this.hover = hit;
      this.container.classList.toggle('cursor-pointer', !!hit.pick);
      this.update(this.input);
      this.callbacks.onHover?.(hit);
    });
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    const drag = this.drag;
    if (drag) {
      this.drag = null;
      this.controls.enabled = true;
      cancelAnimationFrame(drag.frame);
      if (drag.moved) {
        // Apply the final position, then finish (no click).
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(this.ndc(e.clientX, e.clientY), this.camera);
        const point = this.planePoint(raycaster);
        if (point) this.callbacks.onDrag?.(drag.node, point);
        this.callbacks.onDragEnd?.(drag.node);
        this.down = null;
        return;
      }
    }
    const down = this.down;
    this.down = null;
    if (!down || e.button !== 0) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    if (moved > (e.pointerType === 'touch' ? 10 : 5)) return;
    const hit = this.hitTest(e.clientX, e.clientY, e.pointerType === 'touch');
    this.callbacks.onClick(hit, e.shiftKey || e.metaKey || e.ctrlKey);
  };

  private readonly onPointerLeave = () => {
    this.lastPointer = null;
    if (!this.hover.pick && !this.hover.plane) return;
    this.hover = { pick: null, plane: null };
    this.container.classList.remove('cursor-pointer');
    if (this.input) this.update(this.input);
    this.callbacks.onHover?.(this.hover);
  };

  private readonly onContextMenu = (e: Event) => e.preventDefault();
}
