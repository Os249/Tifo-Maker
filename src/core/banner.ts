/**
 * Banners — the data model for a printed banner, its rig, and where it hangs.
 *
 * A tifo has two halves. One is the card mosaic the crowd holds, which is what
 * `DesignStore` models: one byte per seat. The other is the BANNER — a printed
 * sheet of fabric that is hauled up, dropped down, passed over the crowd's
 * heads or hung off the roof. This module is the second half.
 *
 * ## Why a display list and not a bitmap
 *
 * A banner is stored as an ordered list of items — polyline strokes, text,
 * shapes, images — rather than as pixels. That single choice does four jobs:
 *
 * - it is what "draw on it properly, not pixel art" means: a stroke is a curve
 *   with a width, so it is smooth at any zoom;
 * - it re-renders crisply at every size the app needs it — a 900 px artboard, a
 *   2048 px texture in the bowl, an A4 print panel at 300 dpi;
 * - it serialises to a few kilobytes, so banners can travel with the design in
 *   the save payload instead of a few hundred kilobytes of PNG;
 * - and it can be edited after the fact, which a flattened bitmap cannot.
 *
 * ## Coordinates
 *
 * Item coordinates are normalised so the banner's WIDTH is exactly 1, and y
 * runs 0..`aspect` downward (aspect = heightM / widthM). Square units, so a
 * circle is a circle. Resizing the banner therefore rescales the art with it
 * rather than stranding it in a corner, and one multiply by `widthM` converts
 * anything to metres — which is the unit every real constraint is stated in.
 *
 * This file is pure and DOM-free: it runs in the browser, in the server's
 * validator and in `npm run verify` with no canvas anywhere.
 */

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

/**
 * The eight banner families, taken from how they are actually rigged rather
 * than from how they look.
 *
 * The important pair is `overhead-pass` versus `lift`. The DFB's own glossary
 * defines a Blockfahne as fabric drawn across a section "or passed over the
 * heads" of the crowd — and those are two different objects:
 *
 * - an **Überziehfahne** (`overhead-pass`) is passed BACKWARDS over the heads
 *   of the whole block. It ends up lying on top of the people, so the crowd —
 *   and any card mosaic they were holding — is underneath it and hidden.
 * - an **Aufziehfahne** (`lift`) is anchored at the front rail and hauled UP on
 *   ropes in front of the block. The crowd behind it still has their hands
 *   free, which is why this is the only one that can sit in front of a mosaic.
 *
 * `occludesCrowd` below is that distinction, and it is the reason this is a
 * property of the type rather than a checkbox.
 */
export type BannerKind =
  /**
   * The sheet that covers a block of the terracing.
   *
   * A Blockfahne: hung from the back rail of a tier and drawn down over the
   * people in front of it, or laid on the seats when the stand is empty. The
   * one in most photographs of a tifo, and the one that unrolls.
   */
  | 'stand'
  /**
   * The flat sheet that hangs in the air on ropes.
   *
   * From the roof steel, or over the front of a tier. It never touches the
   * terracing, which is why it reads completely differently: a taut printed
   * wall rather than fabric lying on a crowd.
   */
  | 'hanging';

export const BANNER_KINDS: BannerKind[] = ['stand', 'hanging'];

/**
 * Solid fabric or perforated mesh.
 *
 * Not a finish. A banner projecting into the airflow is a sail: the perforated
 * polyesters exist precisely so that "large 3D Tifos can be carried out
 * carefree" (FlagTex Air, 110 g/m²). Mesh cuts wind load by roughly 30-50%,
 * typically at a 70/30 or 60/40 print-to-hole ratio — and loses that same
 * fraction of its ink-bearing surface, which is why thin type degrades on it.
 */
export type BannerMaterial = 'solid' | 'mesh';

/** How a banner arrives. One scalar, so every one of these can be scrubbed. */
export type BannerReveal =
  | 'unroll' // the covered fraction advances behind a shrinking roll
  | 'lower'  // the sheet descends from its rigging on ropes
  | 'cut';   // already in place when the cameras find it

/** Which stand: 0 East, 1 North, 2 West, 3 South — the app's existing order. */
export type StandIndex = 0 | 1 | 2 | 3;

/**
 * Where a banner goes: a SLOT, not a position.
 *
 * This is the whole difference between this version and the four before it.
 * A banner used to have a continuous position and a free size, which made the
 * space of configurations infinite: I could test points in it, and the user
 * walked around in it and found the points I had not tested.
 *
 * A slot is a stand, a run of the blocks that stand is divided into by its
 * aisles, and a tier. That is a FINITE set — about 864 per ground — small
 * enough to enumerate and test exhaustively rather than sample. The size is
 * not in here at all: a banner is as wide as the blocks it covers, and its
 * height follows the proportions of the artwork drawn on it.
 */
export interface BannerSlot {
  stand: StandIndex;
  /** First block of the run. Negative means "centre the run on the stand". */
  blockFrom: number;
  /** How many consecutive blocks the run covers. At least one. */
  blockSpan: number;
  /**
   * Which tier.
   *
   * For a stand banner: the tier whose face it covers, or -1 for the whole
   * stand. For a hanging banner: the tier over whose front it hangs, or -1 to
   * fly it from the roof.
   */
  tier: number;
}

// ---------------------------------------------------------------------------
// Display-list items
// ---------------------------------------------------------------------------

interface ItemBase {
  id: string;
  /** Hidden without being deleted. */
  hidden?: boolean;
}

/** A freehand stroke: a polyline with a width, drawn smooth. */
export interface StrokeItem extends ItemBase {
  kind: 'stroke';
  color: string;
  /** Width in banner units (1 = the banner's full width). */
  width: number;
  /** Flat [x0,y0,x1,y1,...] in banner units. */
  pts: number[];
  /** An eraser stroke: punches through everything below it. */
  erase?: boolean;
}

/** A flat fill of the whole banner, as an item so it undoes and layers. */
export interface FillItem extends ItemBase {
  kind: 'fill';
  color: string;
}

interface PlacedItem extends ItemBase {
  /** Centre, in banner units. */
  cx: number;
  cy: number;
  /** Footprint in banner units. */
  w: number;
  h: number;
  /** Rotation in degrees, clockwise. */
  rot: number;
}

export interface TextItem extends PlacedItem {
  kind: 'text';
  text: string;
  /** A `TIFO_FONTS` id, so a banner and the seat grid share one type library. */
  fontId: string;
  /** Arc in degrees, the same control the seat editor's text tool has. */
  arcDeg: number;
  color: string;
  /** Outline width in banner units; 0 = none. */
  outline?: number;
  outlineColor?: string;
}

export interface ShapeItem extends PlacedItem {
  kind: 'shape';
  /** A `SHAPE_NAMES` entry — the same catalogue the seat editor stamps. */
  shape: string;
  color: string;
  outline?: number;
  outlineColor?: string;
}

export interface ImageItem extends PlacedItem {
  kind: 'image';
  /** Data URL. Downscaled on import, so a design row stays small. */
  src: string;
  name?: string;
  opacity?: number;
}

/**
 * A raster patch, which is what the fill tool leaves behind.
 *
 * Flood fill has no vector meaning — "the region bounded by what is already
 * drawn" is a pixel question. So the tool renders the banner, floods it, and
 * keeps only the filled pixels as a patch. It is the one rasterised thing in
 * the document and it is deliberately confined to its own bounding box.
 */
export interface PatchItem extends ItemBase {
  kind: 'patch';
  src: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type BannerItem = StrokeItem | FillItem | TextItem | ShapeItem | ImageItem | PatchItem;

/** Items you can select, move and resize (a stroke or a fill is not one). */
export function isPlaced(it: BannerItem): it is TextItem | ShapeItem | ImageItem {
  return it.kind === 'text' || it.kind === 'shape' || it.kind === 'image';
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export interface BannerDoc {
  id: string;
  name: string;
  kind: BannerKind;
  /**
   * The shape of the artwork, as height divided by width.
   *
   * NOT a size. A banner's size comes from the slot it is in — it is as wide
   * as the blocks it covers — and this is the only thing the editor gets to
   * say about its geometry. That is deliberate: size as an independent number
   * is what made the configuration space infinite, and an infinite space is
   * one I can sample but never prove.
   *
   * Real banners sit between about 1:4 and 4:1.
   */
  aspect: number;
  material: BannerMaterial;
  /** Fabric weight in g/m². The real options are 60, 70, 90, 110 and 230. */
  fabricGsm: number;
  /**
   * A rope net behind the sheet.
   *
   * A 70 g/m² fabric has almost no tensile strength over tens of metres, so a
   * large banner hung from its own edge tears. The net takes the load in both
   * axes and the fabric is laced to it, carrying only its own weight locally.
   * Suppliers sell the net, the ropes and the fastening system as the kit.
   */
  netBacked: boolean;
  /** A weighted bar in the bottom hem: what makes a drop fall straight. */
  weightBar: boolean;
  /** Backdrop colour; null = transparent (the stand shows through). */
  bg: string | null;
  items: BannerItem[];
  slot: BannerSlot;
  reveal: BannerReveal;
  /** Reveal length in milliseconds. */
  revealMs: number;
  /** Wind 0..1. Above ~0.6 a large solid sheet stops behaving. */
  wind: number;
  visible: boolean;
}

export interface BannerSceneModel {
  version: 1;
  banners: BannerDoc[];
}

// ---------------------------------------------------------------------------
// Per-kind defaults, from real banners
// ---------------------------------------------------------------------------

export interface KindProfile {
  /** The shape the type starts at, height over width. */
  aspect: number;
  reveal: BannerReveal;
  /** How many blocks of the stand this type covers by default. */
  blockSpan: number;
  /** Which tier it starts on; -1 is the whole stand, or the roof. */
  tier: number;
  netBacked: boolean;
  weightBar: boolean;
  fabricGsm: number;
  /** True when the sheet ends up on top of the crowd, hiding the mosaic. */
  occludesCrowd: boolean;
  /** Ropes are part of this banner's look. */
  roped: boolean;
}

/**
 * Sizes are the middle of the band real banners occupy, not records.
 *
 * Anchors used: the Norbert-Thines choreo at Kaiserslautern was a 40 m block
 * flag with 4 m lettering; a Polish supplier's standard centre-circle banner is
 * 18.3 m across (the Laws of the Game centre circle is 9.15 m radius); fence
 * flags run from a metre to a whole fence and the DFB explicitly refuses to
 * bound them; Section 8 Chicago's overhead is 8 x 8 m.
 */
export const KIND_PROFILE: Record<BannerKind, KindProfile> = {
  /**
   * Two blocks, hung on the upper tier, roughly 2:1.
   *
   * Two blocks of a generic bowl is about 37 m of stand, and 2:1 puts it at
   * 18 m deep — which is a Blockfahne, and which is what the Kaiserslautern
   * choreo's 40 m block flag with 4 m lettering actually was.
   */
  stand: {
    aspect: 0.5, reveal: 'unroll', blockSpan: 2, tier: -1,
    netBacked: false, weightBar: true, fabricGsm: 110,
    occludesCrowd: true, roped: false,
  },
  /**
   * Two blocks, flown from the roof, roughly 5:3.
   *
   * Squarer than a Blockfahne because it is read from across the ground
   * rather than down a rake, and it has no terracing to follow.
   */
  hanging: {
    aspect: 0.6, reveal: 'lower', blockSpan: 2, tier: -1,
    netBacked: true, weightBar: true, fabricGsm: 110,
    occludesCrowd: false, roped: true,
  },
};


/** Does this banner end up lying on top of the crowd (and its mosaic)? */
export function occludesCrowd(doc: BannerDoc): boolean {
  return KIND_PROFILE[doc.kind].occludesCrowd;
}

// ---------------------------------------------------------------------------
// Physical facts
// ---------------------------------------------------------------------------

/**
 * The widest fabric anyone prints, in metres.
 *
 * Three independent suppliers give the same figure: 310 cm seamless (DE),
 * 3-metre panels "to significantly reduce the number of seams" (ultrasshop),
 * and 3.2 m printed trimming to 3.0 m finished (PL). Anything wider is sewn
 * from panels with a colour-matched seam. It is the hardest constraint in tifo
 * design and the app has never shown it.
 */
export const PANEL_MAX_M = 3.0;

/** The real fabric weights, g/m². */
export const FABRIC_GSM = [60, 70, 90, 110, 230] as const;

/**
 * Kilograms one person carries.
 *
 * Peñarol's record flag was 1,880 kg and took 300 fans to carry into the
 * ground: 6.3 kg each. Six is the round number under it.
 */
export const KG_PER_CARRIER = 6;

export interface BannerFacts {
  areaM2: number;
  /** Vertical panels the banner is sewn from. */
  panels: number;
  /** Seam positions in metres from the left edge. */
  seamsM: number[];
  weightKg: number;
  carriers: number;
  /** Cap height in metres for the headline to read at `viewDistanceM`. */
  headlineCapM: number;
  /** The same as a fraction of the banner's width, which is how you draw it. */
  headlineCapFrac: number;
  /** Below this, type will not survive the broadcast. */
  minTypeFrac: number;
  notes: BannerNote[];
}

export interface BannerNote {
  /** i18n key under `bn.note.` */
  key: string;
  level: 'info' | 'warn';
  /** Numbers for the sentence's named placeholders. */
  vals?: Record<string, string | number>;
}

/**
 * Cap-height divisor for tifo.
 *
 * Signage practice is 1 inch of cap height per 10 ft of maximum legible
 * distance — a 1:120 ratio — with comfortable reading 30-50% closer. Tifo is
 * neither: it is glanced at for two or three minutes, across a moving crowd,
 * under floodlights, then downscaled by a broadcast encoder. Real banners sit
 * at D/25 to D/40; Kaiserslautern's 4 m lettering across a Bundesliga pitch is
 * squarely in that band. D/40 is the floor this app recommends.
 */
const TIFO_CAP_DIVISOR = 40;

/** Type below this fraction of the banner's width does not survive TV. */
const MIN_TYPE_FRAC = 0.02;

/**
 * A banner's real size, in metres.
 *
 * Passed IN rather than read off the document, because a banner no longer
 * carries a size: it is as wide as the blocks it covers, and only the stand
 * knows how wide those are. Match Day passes the exact figure; the editor,
 * which has no bowl to ask, passes `estimateSize` below and says so.
 */
export interface BannerSize {
  widthM: number;
  heightM: number;
}

/** Metres of stand in one block, averaged over the catalogue. */
export const TYPICAL_BLOCK_M = 18.5;

/**
 * What a banner will PROBABLY come out at, for the editor's panel.
 *
 * The editor has the artwork and the slot but not the ground, so it cannot
 * know the real width. Eighteen and a half metres a block is the average
 * across every template in the catalogue, and it is close enough for a seam
 * count and a weight — which are the only things the panel prints.
 */
export function estimateSize(doc: BannerDoc): BannerSize {
  const widthM = Math.max(1, doc.slot.blockSpan) * TYPICAL_BLOCK_M;
  return { widthM, heightM: widthM * clamp(doc.aspect, 0.05, 6) };
}

/**
 * Everything the panel prints about a banner, derived rather than asserted.
 *
 * `viewDistanceM` is how far away the people reading it are — across the pitch
 * from the opposite stand, which the simulator can measure and which defaults
 * to 100 m here so this function stays pure.
 */
export function bannerFacts(doc: BannerDoc, size: BannerSize, viewDistanceM = 100): BannerFacts {
  const w = Math.max(0.1, size.widthM);
  const h = Math.max(0.1, size.heightM);
  const areaM2 = w * h;
  const panels = Math.max(1, Math.ceil(w / PANEL_MAX_M - 1e-9));
  const seamsM: number[] = [];
  for (let k = 1; k < panels; k++) seamsM.push((k * w) / panels);
  const weightKg = (areaM2 * doc.fabricGsm) / 1000;
  const carriers = Math.max(1, Math.ceil(weightKg / KG_PER_CARRIER));
  const headlineCapM = viewDistanceM / TIFO_CAP_DIVISOR;
  const headlineCapFrac = headlineCapM / w;

  const notes: BannerNote[] = [];
  if (panels > 1) {
    notes.push({ key: 'seams', level: 'info', vals: { panels, panelM: PANEL_MAX_M } });
  }
  if (weightKg >= 50) {
    notes.push({ key: 'carry', level: 'info', vals: { kg: Math.round(weightKg), people: carriers } });
  }
  if (doc.material === 'mesh') {
    notes.push({ key: 'mesh', level: 'info' });
  }
  // A sail. Mesh is the documented answer; so is not flying it in the wind.
  if (doc.material === 'solid' && doc.kind === 'hanging' && areaM2 > 120) {
    notes.push({ key: 'wind', level: 'warn', vals: { area: Math.round(areaM2) } });
  }
  if (doc.material === 'solid' && areaM2 > 400 && !doc.netBacked) {
    notes.push({ key: 'net', level: 'warn', vals: { area: Math.round(areaM2) } });
  }
  if (KIND_PROFILE[doc.kind].occludesCrowd) {
    notes.push({ key: 'occludes', level: 'warn' });
  }
  notes.push({ key: 'fire', level: 'info' });
  return { areaM2, panels, seamsM, weightKg, carriers, headlineCapM, headlineCapFrac, minTypeFrac: MIN_TYPE_FRAC, notes };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

let counter = 0;
function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;
}

export function newBanner(kind: BannerKind = 'stand', name = 'Banner'): BannerDoc {
  const p = KIND_PROFILE[kind];
  return {
    id: newId('bn_'),
    name,
    kind,
    aspect: p.aspect,
    material: 'solid',
    fabricGsm: p.fabricGsm,
    netBacked: p.netBacked,
    weightBar: p.weightBar,
    bg: null,
    items: [],
    slot: {
      stand: 1,
      // -1 means "centred". A tifo goes in the middle of the kop unless
      // someone moves it, and the number of blocks depends on the ground, so
      // a fixed index would be wrong on some of them.
      blockFrom: -1,
      blockSpan: p.blockSpan,
      tier: p.tier,
    },
    reveal: p.reveal,
    revealMs: physicalRevealMs(kind, {
      widthM: p.blockSpan * TYPICAL_BLOCK_M,
      heightM: p.blockSpan * TYPICAL_BLOCK_M * p.aspect,
    }),
    wind: 0.25,
    visible: true,
  };
}

/**
 * Re-profile a banner when its type changes.
 *
 * The artwork is kept and so is the slot — moving a banner from the terracing
 * into the air should not also move it to a different part of the ground. The
 * rig and the reveal follow the new type, because those are what the type IS.
 */
export function applyKind(doc: BannerDoc, kind: BannerKind): BannerDoc {
  const from = KIND_PROFILE[doc.kind];
  const to = KIND_PROFILE[kind];
  const next: BannerDoc = {
    ...doc,
    kind,
    aspect: doc.aspect === from.aspect ? to.aspect : doc.aspect,
    fabricGsm: doc.fabricGsm === from.fabricGsm ? to.fabricGsm : doc.fabricGsm,
    netBacked: to.netBacked,
    weightBar: to.weightBar,
    reveal: to.reveal,
    revealMs: doc.revealMs,
    slot: { ...doc.slot },
  };
  // The duration follows the new rig unless the user moved the slider off the
  // old rig's own physical figure: an unroll and a rope lower are not the same
  // event at different speeds, they are seconds and a minute apart.
  const wasDefault = doc.revealMs === physicalRevealMs(doc.kind, estimateSize(doc));
  if (wasDefault) next.revealMs = physicalRevealMs(kind, estimateSize(next));
  return next;
}

/** Aspect in banner units: y runs 0..aspect. */
export function aspectOf(doc: BannerDoc): number {
  return clamp(doc.aspect, 0.05, 6);
}

export function makeStroke(color: string, width: number, erase = false): StrokeItem {
  return { id: newId('s'), kind: 'stroke', color, width, pts: [], erase };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type Listener = () => void;

/**
 * Holds every banner on the design, the selection, and one undo stack.
 *
 * The contract deliberately matches `DesignStore`: a gesture is opened, edited
 * live, then committed as ONE history entry. `onHistoryChange` fires from every
 * place the stacks move — the September editor audit found the Undo button a
 * full stroke behind because `onDirty` was being asked a question it cannot
 * answer, and there is no reason to learn that twice.
 */
export class BannerStore {
  private banners: BannerDoc[] = [];
  private activeId: string | null = null;
  private selectedItemId: string | null = null;
  private listeners: Listener[] = [];
  private historyListeners: Listener[] = [];
  private undoStack: BannerDoc[][] = [];
  private redoStack: BannerDoc[][] = [];
  private gestureOpen = false;

  private static readonly MAX_UNDO = 120;

  list(): readonly BannerDoc[] {
    return this.banners;
  }
  get count(): number {
    return this.banners.length;
  }
  get(id: string): BannerDoc | undefined {
    return this.banners.find((b) => b.id === id);
  }
  get active(): BannerDoc | null {
    return this.activeId ? this.get(this.activeId) ?? null : null;
  }
  get activeId_(): string | null {
    return this.activeId;
  }
  get selectedItem(): BannerItem | null {
    const a = this.active;
    if (!a || !this.selectedItemId) return null;
    return a.items.find((i) => i.id === this.selectedItemId) ?? null;
  }
  get selectedItemId_(): string | null {
    return this.selectedItemId;
  }

  onChange(fn: Listener): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
  onHistoryChange(fn: Listener): void {
    this.historyListeners.push(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
  private emitHistory(): void {
    for (const fn of this.historyListeners) fn();
  }

  private snapshot(): BannerDoc[] {
    return this.banners.map((b) => ({ ...b, slot: { ...b.slot }, items: b.items.map((i) => ({ ...i })) }));
  }

  /**
   * Open a gesture. Everything until `commit()` collapses into one undo entry.
   * Nested calls are ignored, so a tool that begins a gesture inside another
   * one cannot split a drag into two history entries.
   */
  begin(): void {
    if (this.gestureOpen) return;
    this.gestureOpen = true;
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > BannerStore.MAX_UNDO) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** Close the gesture. Drops the entry if nothing actually changed. */
  commit(): void {
    if (!this.gestureOpen) return;
    this.gestureOpen = false;
    const before = this.undoStack[this.undoStack.length - 1];
    if (before && sameScene(before, this.banners)) this.undoStack.pop();
    this.emitHistory();
    this.emit();
  }

  /** Abandon the gesture and put everything back. */
  cancel(): void {
    if (!this.gestureOpen) return;
    this.gestureOpen = false;
    const before = this.undoStack.pop();
    if (before) this.banners = before;
    this.emitHistory();
    this.emit();
  }

  /**
   * Add a banner, normalised.
   *
   * Anything that reaches the store is filled in and clamped first, so the
   * renderer can never be handed a document with a missing `aspect` or a slot
   * on a stand that does not exist. Trusting the caller here cost an
   * afternoon: a harness left `aspect` off, `resolveSlot` multiplied by
   * undefined, and every vertex came out NaN — which draws as nothing at all
   * rather than as an error.
   */
  add(doc: BannerDoc): BannerDoc {
    doc = normalise(doc);
    this.begin();
    this.banners.push(doc);
    this.activeId = doc.id;
    this.selectedItemId = null;
    this.commit();
    return doc;
  }

  remove(id: string): void {
    const i = this.banners.findIndex((b) => b.id === id);
    if (i < 0) return;
    this.begin();
    this.banners.splice(i, 1);
    if (this.activeId === id) this.activeId = this.banners[Math.min(i, this.banners.length - 1)]?.id ?? null;
    this.selectedItemId = null;
    this.commit();
  }

  setActive(id: string | null): void {
    if (this.activeId === id) return;
    this.activeId = id;
    this.selectedItemId = null;
    this.emit();
  }

  selectItem(id: string | null): void {
    if (this.selectedItemId === id) return;
    this.selectedItemId = id;
    this.emit();
  }

  /** Patch the active banner. Live during a gesture; call `commit()` to close. */
  patch(p: Partial<BannerDoc>): void {
    const a = this.active;
    if (!a) return;
    Object.assign(a, p);
    this.emit();
  }

  patchSlot(p: Partial<BannerSlot>): void {
    const a = this.active;
    if (!a) return;
    a.slot = { ...a.slot, ...p };
    this.emit();
  }

  addItem(it: BannerItem): void {
    const a = this.active;
    if (!a) return;
    a.items.push(it);
    this.selectedItemId = it.id;
    this.emit();
  }

  patchItem(id: string, p: Partial<BannerItem>): void {
    const a = this.active;
    if (!a) return;
    const it = a.items.find((i) => i.id === id);
    if (!it) return;
    Object.assign(it, p);
    this.emit();
  }

  removeItem(id: string): void {
    const a = this.active;
    if (!a) return;
    const i = a.items.findIndex((it) => it.id === id);
    if (i < 0) return;
    this.begin();
    a.items.splice(i, 1);
    if (this.selectedItemId === id) this.selectedItemId = null;
    this.commit();
  }

  /** Move the selected item through the stacking order. */
  reorderItem(id: string, dir: 'front' | 'back' | 'up' | 'down'): void {
    const a = this.active;
    if (!a) return;
    const i = a.items.findIndex((it) => it.id === id);
    if (i < 0) return;
    this.begin();
    const [it] = a.items.splice(i, 1);
    const to =
      dir === 'front' ? a.items.length
      : dir === 'back' ? 0
      : dir === 'up' ? Math.min(a.items.length, i + 1)
      : Math.max(0, i - 1);
    a.items.splice(to, 0, it);
    this.commit();
  }

  clearArt(): void {
    const a = this.active;
    if (!a) return;
    this.begin();
    a.items = [];
    this.selectedItemId = null;
    this.commit();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.snapshot());
    this.banners = prev;
    if (!this.banners.some((b) => b.id === this.activeId)) this.activeId = this.banners[0]?.id ?? null;
    this.selectedItemId = null;
    this.emitHistory();
    this.emit();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.snapshot());
    this.banners = next;
    if (!this.banners.some((b) => b.id === this.activeId)) this.activeId = this.banners[0]?.id ?? null;
    this.selectedItemId = null;
    this.emitHistory();
    this.emit();
  }

  toJSON(): BannerSceneModel {
    return { version: 1, banners: this.snapshot() };
  }

  loadJSON(m: BannerSceneModel | null | undefined): void {
    this.banners = m && Array.isArray(m.banners) ? m.banners.map(normalise) : [];
    this.activeId = this.banners[0]?.id ?? null;
    this.selectedItemId = null;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.emitHistory();
    this.emit();
  }

  clear(): void {
    this.banners = [];
    this.activeId = null;
    this.selectedItemId = null;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.emitHistory();
    this.emit();
  }
}

function sameScene(a: BannerDoc[], b: BannerDoc[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Fill in anything a stored banner is missing.
 *
 * Banners arrive from three places — this session, localStorage from an older
 * build, and the server — and the older two can predate any field added since.
 * Every read goes through here so the rest of the code can assume a complete
 * document.
 */
export function normalise(raw: Partial<BannerDoc>): BannerDoc {
  const kind = (raw.kind && KIND_PROFILE[raw.kind] ? raw.kind : 'stand') as BannerKind;
  const p = KIND_PROFILE[kind];
  const base = newBanner(kind, raw.name ?? 'Banner');
  // A banner saved by an older build has a free position and a size in
  // metres, neither of which exists any more. Its ARTWORK still does, so the
  // artwork comes forward and the placement is simply the default slot —
  // which is the clean break rather than a migration shim kept alive forever.
  const legacy = raw as unknown as { widthM?: number; heightM?: number; place?: { stand?: number } };
  const aspect = raw.aspect !== undefined
    ? clamp(num(raw.aspect, p.aspect), 0.05, 6)
    : legacy.widthM && legacy.heightM
      ? clamp(legacy.heightM / legacy.widthM, 0.05, 6)
      : p.aspect;
  return {
    ...base,
    ...raw,
    id: raw.id ?? base.id,
    kind,
    aspect,
    fabricGsm: clamp(num(raw.fabricGsm, p.fabricGsm), 40, 600),
    material: raw.material === 'mesh' ? 'mesh' : 'solid',
    netBacked: raw.netBacked ?? p.netBacked,
    weightBar: raw.weightBar ?? p.weightBar,
    bg: raw.bg ?? null,
    items: Array.isArray(raw.items) ? raw.items.filter(validItem) : [],
    wind: clamp(num(raw.wind, 0.25), 0, 1),
    revealMs: clamp(num(raw.revealMs, base.revealMs), 200, 180000),
    reveal: raw.reveal === 'unroll' || raw.reveal === 'lower' || raw.reveal === 'cut' ? raw.reveal : p.reveal,
    visible: raw.visible !== false,
    slot: {
      stand: (((raw.slot?.stand ?? legacy.place?.stand ?? 1) % 4) + 4) % 4 as StandIndex,
      blockFrom: Math.round(clamp(num(raw.slot?.blockFrom, -1), -1, 63)),
      blockSpan: Math.round(clamp(num(raw.slot?.blockSpan, p.blockSpan), 1, 32)),
      tier: Math.round(clamp(num(raw.slot?.tier, p.tier), -1, 7)),
    },
  };
}


function validItem(it: BannerItem): boolean {
  if (!it || typeof it !== 'object' || typeof it.id !== 'string') return false;
  switch (it.kind) {
    case 'stroke': return Array.isArray(it.pts);
    case 'fill': return typeof it.color === 'string';
    case 'text': return typeof it.text === 'string';
    case 'shape': return typeof it.shape === 'string';
    case 'image': return typeof it.src === 'string';
    case 'patch': return typeof it.src === 'string';
    default: return false;
  }
}

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Reveal curves
// ---------------------------------------------------------------------------

/**
 * Shape a reveal's 0..1 progress.
 *
 * Each of these is the motion of a physical thing, which is why none of them is
 * linear. A drop accelerates as the roll unwinds and the falling length grows;
 * a rope lift is people hauling, which starts hard and eases as the sheet's
 * weight comes off the ground; a crowd pass is a wave travelling at a roughly
 * constant speed with a soft start and stop; a hoist from the roof is a mass on
 * a rope, so it overshoots and settles.
 */
export function revealEase(mode: BannerReveal, t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  switch (mode) {
    // Gravity on an unwinding roll: slow at first, then away, because the
    // falling length grows as the roll pays out.
    case 'unroll':
      return x * x * (1.7 - 0.7 * x);
    /**
     * A mass on a rope: it arrives, overshoots once and settles.
     *
     * A damped harmonic oscillator rather than the usual "elastic" easing,
     * whose first peak is early and enormous — measured, it threw the banner
     * 36% PAST its rigging point before coming back, which for something on
     * ropes reads as a mistake rather than as weight. This overshoots by
     * about 8%, which is what a banner lowered onto its lines does.
     */
    case 'lower': {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      const damped = (u: number): number =>
        1 - Math.exp(-5 * u) * (Math.cos(6 * u) + (5 / 6) * Math.sin(6 * u));
      return damped(x) / damped(1);
    }
    case 'cut':
    default:
      return x;
  }
}

// ---------------------------------------------------------------------------
// How long a reveal actually takes
// ---------------------------------------------------------------------------

/**
 * Deployment speeds, in metres per second.
 *
 * These are the numbers that were missing when every reveal in this editor ran
 * for 4.2 seconds regardless of what it was. Four seconds is roughly right for
 * a drop, because a drop is gravity and gravity is fast. It is about an order
 * of magnitude wrong for a rope lift, which is people hauling hand over hand
 * and takes the better part of a minute on a big one.
 *
 * `haul` is a line pulled over a rail by supporters standing on the terrace.
 * Timed off deployment footage, the bar rises at 0.3–0.8 m/s depending on how
 * many hands are on the rope and how much the sheet is still dragging; 0.5 is
 * the middle of that and the figure a 36 x 18 m Aufziehfahne comes out at.
 *
 * `hoist` is slower because a roof line is longer, the crew is smaller and
 * the load is swinging in free air with nothing to steady it.
 *
 * `pass` is the speed of the fold-front of an Überziehfahne travelling back
 * over raised hands — 0.7–1.4 m/s, which is a fast walk, because that is what
 * it is: each row passing the roll to the row behind.
 *
 * `pole` is a sweep at arm speed, the one that is quick because one person
 * does the whole thing.
 */
export const DEPLOY_SPEED = {
  haul: 0.5,
  hoist: 0.35,
  pass: 1.0,
  pole: 0.55,
} as const;

/** Standard gravity, the only number in a drop that is not negotiable. */
const G = 9.81;

/**
 * Time for a released bundle to fall `dropM`, paying fabric out behind it.
 *
 * The bundle is in free fall — the fabric above it is slack until the last
 * instant — so this is the plain kinematic answer, and it is a hard floor on
 * how fast a drop banner can possibly deploy.
 */
export function freeFallSeconds(dropM: number): number {
  return Math.sqrt((2 * Math.max(0.1, dropM)) / G);
}

/**
 * How long a hanging sheet keeps moving after it arrives.
 *
 * A banner hung from its top edge swings as a hanging chain, whose first mode
 * has period T = 2π / (1.2025 √(g/L)) — longer than the simple pendulum of the
 * same length, because the mass is distributed. A 12 m drop comes out at 5.8 s
 * per swing. It does not take a whole period to look settled, and air drag on
 * a sheet that size is not gentle, so the allowance is a little over half of
 * one, capped: past about four seconds the eye has stopped waiting.
 */
export function settleSeconds(heightM: number): number {
  const L = Math.max(0.5, heightM);
  const period = (2 * Math.PI) / (1.2025 * Math.sqrt(G / L));
  return Math.min(4, 0.6 * period);
}

/**
 * The duration a reveal would take in a real stadium, in milliseconds.
 *
 * Every branch is a distance over a speed, or gravity, rather than a number
 * chosen because it felt about right in a preview window.
 */
export function physicalRevealMs(kind: BannerKind, size: BannerSize): number {
  const p = KIND_PROFILE[kind];
  const H = Math.max(0.5, size.heightM);
  switch (p.reveal) {
    // Gravity on an unrolling sheet: it falls, then stops swinging. Big ones
    // are barely slower than small ones — quadrupling the drop only doubles
    // the fall.
    case 'unroll':
      return Math.round((freeFallSeconds(H) + settleSeconds(H)) * 1000);
    // Lowered on lines from the roof. The crew is small, the load is swinging
    // in free air with nothing to steady it, and it takes as long as it takes.
    case 'lower':
      return Math.round((H / DEPLOY_SPEED.hoist + settleSeconds(H)) * 1000);
    // Not a deployment: a banner that was rigged before anyone walked in.
    case 'cut':
    default:
      return 900;
  }
}

/**
 * The slowest thing physics will allow, in seconds.
 *
 * The seconds slider is the user's, and wanting a 20-second drop for a preview
 * is a reasonable thing to want. Wanting a half-second one is not: the bundle
 * would have to fall faster than gravity. So the floor is only ever the
 * genuinely impossible case, never a matter of taste.
 */
export function revealFloorSeconds(doc: BannerDoc, size: BannerSize): number {
  if (doc.reveal === 'unroll') return freeFallSeconds(size.heightM);
  return 0.3;
}

/** The reveal duration the simulator should run, in seconds. */
export function revealSeconds(doc: BannerDoc, size: BannerSize): number {
  return Math.max(revealFloorSeconds(doc, size), doc.revealMs / 1000);
}
