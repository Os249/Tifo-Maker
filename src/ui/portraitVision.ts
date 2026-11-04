/// <reference types="vite/client" />
/**
 * The browser's eyes for Pro portrait styles: where the face is (its 68
 * landmarks) and which pixels are the person (a soft mask), both computed on
 * the fan's own device, so the photo goes nowhere for either.
 *
 *   face    @vladmandic/face-api (MIT): the Tiny Face Detector and the 68-point
 *           landmark net, weights from the npm package (550 KB);
 *   person  MediaPipe Selfie Segmentation (Apache-2.0, src/vendor/selfie),
 *           296 KB: the local fallback for the subject mask when the server's
 *           smart cut-out is not used.
 *
 * Both run on TensorFlow.js's WebGL back end (the CPU one if WebGL is
 * refused). No WebAssembly is compiled and no string is evaluated, so the
 * site's CSP (script-src 'self', no 'wasm-unsafe-eval') stands as it is; the
 * weights are this site's own hashed files. The library (1.3 MB, about 330 KB
 * compressed) is fetched only when a Pro member first picks a style, never
 * with the editor.
 */
import { plausibleFace, type FaceInfo } from '../core/portraitPipeline';
import tinyManifest from '@vladmandic/face-api/model/tiny_face_detector_model-weights_manifest.json';
import tinyBin from '@vladmandic/face-api/model/tiny_face_detector_model.bin?url';
import marksManifest from '@vladmandic/face-api/model/face_landmark_68_model-weights_manifest.json';
import marksBin from '@vladmandic/face-api/model/face_landmark_68_model.bin?url';
import ssdManifest from '@vladmandic/face-api/model/ssd_mobilenetv1_model-weights_manifest.json';
import ssdBin from '@vladmandic/face-api/model/ssd_mobilenetv1_model.bin?url';
import selfieModel from '../vendor/selfie/selfie.json';
import selfieBin from '../vendor/selfie/selfie.bin?url';

type FaceApi = typeof import('@vladmandic/face-api');
interface WeightEntry { name: string; shape: number[]; dtype: string; quantization?: unknown }

/**
 * The part of TensorFlow.js used here. The bundle carries all of it, but its
 * typings declare only what face-api itself calls, so the rest is named here.
 */
interface Tensor {
  cast(dtype: 'float32'): Tensor;
  div(n: number): Tensor;
  expandDims(axis: number): Tensor;
  data(): Promise<Float32Array | Int32Array | Uint8Array>;
  dispose(): void;
}
interface GraphModel {
  execute(input: Tensor): Tensor;
}
interface Tf {
  setBackend(name: string): Promise<boolean>;
  ready(): Promise<void>;
  getBackend(): string;
  tidy<T>(fn: () => T): T;
  io: { decodeWeights(buf: ArrayBuffer, specs: WeightEntry[]): never };
  loadGraphModel(handler: { load(): Promise<object> }): Promise<GraphModel>;
  browser: { fromPixels(c: HTMLCanvasElement): Tensor };
}

/** The long edge a picture is looked at for its face: plenty for a face, quick on a phone. */
const LOOK_EDGE = 640;
/** The selfie model's input. */
const SEG = 256;

let ready: Promise<{ api: FaceApi; tf: Tf; seg: GraphModel }> | null = null;

async function bytes(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`model file: HTTP ${r.status}`);
  return r.arrayBuffer();
}

/** Load the library and the three models once. */
function load(): Promise<{ api: FaceApi; tf: Tf; seg: GraphModel }> {
  ready ??= (async () => {
    const api = await import('@vladmandic/face-api');
    const tf = api.tf as unknown as Tf;
    // WebGL first, CPU if the device refuses it. Never the WebAssembly back
    // end the bundle also carries: compiling it needs 'wasm-unsafe-eval'.
    const ok = await tf.setBackend('webgl').catch(() => false);
    if (!ok) await tf.setBackend('cpu');
    await tf.ready();
    const [tiny, marks, segW] = await Promise.all([bytes(tinyBin), bytes(marksBin), bytes(selfieBin)]);
    const decode = (buf: ArrayBuffer, spec: WeightEntry[]) => tf.io.decodeWeights(buf, spec);
    api.nets.tinyFaceDetector.loadFromWeightMap(decode(tiny, (tinyManifest as { weights: WeightEntry[] }[])[0].weights));
    api.nets.faceLandmark68Net.loadFromWeightMap(decode(marks, (marksManifest as { weights: WeightEntry[] }[])[0].weights));
    const m = selfieModel as unknown as { modelTopology: unknown; weightsManifest: { weights: WeightEntry[] }[]; format?: string; generatedBy?: string; convertedBy?: string };
    const seg = await tf.loadGraphModel({
      load: async () => ({
        modelTopology: m.modelTopology as object,
        weightSpecs: m.weightsManifest[0].weights,
        weightData: segW,
        format: m.format,
        generatedBy: m.generatedBy,
        convertedBy: m.convertedBy,
      }),
    });
    return { api, tf, seg };
  })();
  ready.catch(() => {
    ready = null;
  });
  return ready;
}

/** A canvas of `src` at most `edge` on its long side. */
function canvasOf(src: CanvasImageSource & { width: number; height: number }, edge: number): HTMLCanvasElement {
  const k = Math.min(1, edge / Math.max(src.width, src.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(src.width * k));
  c.height = Math.max(1, Math.round(src.height * k));
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

let ssdReady: Promise<void> | null = null;

/**
 * The second detector, SSD MobileNet v1 (5.6 MB of weights, MIT like the
 * rest of face-api): slower and heavier than the tiny one, but it finds the
 * faces that one misses (a beard, a face small or low-contrast in the
 * frame). Fetched only the first time the tiny detector finds nothing.
 */
function loadSsd(api: FaceApi, tf: Tf): Promise<void> {
  ssdReady ??= bytes(ssdBin).then((buf) => {
    api.nets.ssdMobilenetv1.loadFromWeightMap(tf.io.decodeWeights(buf, (ssdManifest as { weights: WeightEntry[] }[])[0].weights));
  });
  ssdReady.catch(() => {
    ssdReady = null;
  });
  return ssdReady;
}

type Found = Awaited<ReturnType<ReturnType<FaceApi['detectAllFaces']>['withFaceLandmarks']>>;

/** The biggest plausible face of what a detector found, in 0..1 of the picture. */
function bestOf(found: Found, c: HTMLCanvasElement): FaceInfo | null {
  const faces = found
    .map((f) => {
      const b = f.detection.box;
      const pts: number[] = [];
      for (const pt of f.landmarks.positions) pts.push(pt.x / c.width, pt.y / c.height);
      return { info: { box: [b.x / c.width, b.y / c.height, b.width / c.width, b.height / c.height], pts } as FaceInfo, rank: b.area * f.detection.score };
    })
    .filter((f) => plausibleFace(f.info, c.width, c.height))
    .sort((p, q) => q.rank - p.rank);
  return faces[0]?.info ?? null;
}

/**
 * The biggest face in the picture, or null. Looked for three times: the
 * tiny detector at its usual size, then larger and less strictly (a face
 * small in the frame, a face turned a little), then the SSD detector. A
 * face whose landmarks are not in a face's order (eyes under the mouth, a
 * chin above the brows) does not count, so the next pass still runs.
 */
export async function findFace(src: CanvasImageSource & { width: number; height: number }): Promise<FaceInfo | null> {
  const { api, tf } = await load();
  const c = canvasOf(src, LOOK_EDGE);
  for (const [inputSize, scoreThreshold] of [[416, 0.45], [608, 0.3]] as const) {
    const found = await api.detectAllFaces(c, new api.TinyFaceDetectorOptions({ inputSize, scoreThreshold })).withFaceLandmarks();
    const best = bestOf(found, c);
    if (best) {
      lastDetector = 'tiny';
      return best;
    }
  }
  try {
    await loadSsd(api, tf);
    const found = await api.detectAllFaces(c, new api.SsdMobilenetv1Options({ minConfidence: 0.3, maxResults: 5 })).withFaceLandmarks();
    lastDetector = 'ssd';
    return bestOf(found, c);
  } catch (e) {
    // No second opinion (the weights did not load): no face, and the style draws the whole picture.
    console.warn('[tifo] second face detector unavailable', e);
    return null;
  }
}

/** Which detector found the last face (for the lab and the browser suite). */
export let lastDetector: 'tiny' | 'ssd' = 'tiny';

/**
 * Which pixels of `src` are the person, as a soft mask (0..1) of `w` x `h`:
 * the selfie model's 256 x 256 answer, scaled to the size asked for. The
 * caller snaps it to the photo's edges (core/matte.ts guidedFilter) and
 * cleans it (refineMatte).
 */
export async function personMask(src: CanvasImageSource & { width: number; height: number }): Promise<{ mask: Float32Array; w: number; h: number }> {
  const { tf, seg } = await load();
  const c = document.createElement('canvas');
  c.width = SEG;
  c.height = SEG;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, SEG, SEG);
  const out = tf.tidy(() => seg.execute(tf.browser.fromPixels(c).cast('float32').div(255).expandDims(0)));
  const data = (await out.data()) as Float32Array;
  out.dispose();
  return { mask: Float32Array.from(data), w: SEG, h: SEG };
}

/** For the browser suites: whether the models load and on which back end. */
export async function visionBackend(): Promise<string> {
  return (await load()).tf.getBackend();
}
