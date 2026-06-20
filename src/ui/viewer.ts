import type { SeatMap, DesignState } from '../core/types';
import { DesignStore } from '../core/design';
import { EMPTY_SEAT_COLOR } from '../core/template';
import { listGallery, loadDesign, thumbnailUrl, type GalleryItem } from '../net/api';

/**
 * Phone viewer (<768px). Not a crippled editor — a first-class read-only
 * surface, because sharing vastly outnumbers designing. The 3D stadium is the
 * hero (the emotional payload that gets sent to group chats); below it sit the
 * design's vitals, a card bill-of-materials, share/fork/open actions, and the
 * public gallery (which is just the thumbnails we already render).
 *
 * Reuses the engine: same DesignStore, same SeatMap, same Preview3D (lazy).
 * Editing is intentionally redirected to desktop — no dead tool buttons ship
 * to a screen that cannot use them.
 */

export interface ViewerContext {
  map: SeatMap;
  store: DesignStore;
  templateName: string;
  title: string;
  /** When viewing a shared/published design, its id (for the share link). */
  designId?: string;
}


/** Flat 2D strip of the design into a canvas, pixelated (the look-at-the-art view). */
export function paint2D(canvas: HTMLCanvasElement, map: SeatMap, store: DesignStore): void {
  const bw = map.bounds.maxX - map.bounds.minX;
  const bh = map.bounds.maxY - map.bounds.minY;
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width;
  const scale = W / bw;
  const H = Math.max(1, Math.round(bh * scale));
  canvas.height = H;
  ctx.fillStyle = '#07080A';
  ctx.fillRect(0, 0, W, H);
  const hex = (i: number): string =>
    store.cells[i] === 0
      ? '#262a33'
      : store.palette[store.cells[i]] ?? `#${EMPTY_SEAT_COLOR.toString(16)}`;
  for (let i = 0; i < map.count; i++) {
    ctx.fillStyle = hex(i);
    const x = (map.xy[i * 2] - map.bounds.minX) * scale;
    const y = (map.xy[i * 2 + 1] - map.bounds.minY) * scale;
    ctx.fillRect(x, y, Math.max(0.6, 3.2 * scale), Math.max(1, 8 * scale * 0.85));
  }
}

function colorBom(map: SeatMap, store: DesignStore): { hex: string; count: number }[] {
  const counts = new Array(store.palette.length).fill(0);
  for (let i = 0; i < map.count; i++) counts[store.cells[i]]++;
  const out: { hex: string; count: number }[] = [];
  for (let c = 1; c < store.palette.length; c++) {
    if (counts[c] > 0) out.push({ hex: store.palette[c], count: counts[c] });
  }
  return out.sort((a, b) => b.count - a.count);
}

/** Build the entire viewer UI into the body. Returns nothing — it owns the page. */
export async function mountViewer(ctx: ViewerContext): Promise<void> {
  const { map, store } = ctx;
  document.body.innerHTML = '';
  document.body.className = 'viewer';

  const root = document.createElement('div');
  root.className = 'viewer-root';
  root.innerHTML = `
    <header class="v-top">
      <div class="brand">TIFO<b>MAKER</b></div>
      <button class="v-open" id="v-open" title="Open the full editor on desktop">
        <i class="ti ti-device-desktop"></i> Edit on desktop
      </button>
    </header>
    <div class="v-hero">
      <div id="v-preview-host"></div>
      <div class="v-cams" id="v-cams"></div>
    </div>
    <div class="v-body">
      <div class="v-title" id="v-title"></div>
      <div class="v-sub" id="v-sub"></div>
      <canvas class="v-flat" id="v-flat" width="600"></canvas>
      <div class="v-bom" id="v-bom"></div>
      <div class="v-actions">
        <button class="primary" id="v-share"><i class="ti ti-share"></i> Share</button>
        <button id="v-fork" title="Open as a working copy"><i class="ti ti-git-fork"></i></button>
      </div>
      <div class="v-gallery-head">
        <span>From the gallery</span>
      </div>
      <div class="v-gallery" id="v-gallery"></div>
    </div>
  `;
  document.body.appendChild(root);

  (document.getElementById('v-title') as HTMLElement).textContent = ctx.title;
  (document.getElementById('v-sub') as HTMLElement).textContent = ctx.templateName;
  paint2D(document.getElementById('v-flat') as HTMLCanvasElement, map, store);

  const bomEl = document.getElementById('v-bom')!;
  for (const { hex, count } of colorBom(map, store)) {
    const chip = document.createElement('span');
    chip.className = 'v-bom-chip';
    chip.innerHTML = `<i style="background:${hex}"></i>${count.toLocaleString()}`;
    bomEl.appendChild(chip);
  }

  // 3D hero — reuse the same Preview3D the desktop editor uses.
  const previewHost = document.getElementById('v-preview-host')!;
  const { Preview3D, CAMERA_PRESETS } = await import('../render/preview3d');
  const preview = new Preview3D(previewHost, map, store);
  preview.start();
  const cams = document.getElementById('v-cams')!;
  CAMERA_PRESETS.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'v-cam' + (i === 0 ? ' active' : '');
    b.textContent = p.name;
    b.addEventListener('click', () => {
      preview.applyPreset(p);
      cams.querySelectorAll('.v-cam').forEach((el) => el.classList.remove('active'));
      b.classList.add('active');
    });
    cams.appendChild(b);
  });

  document.getElementById('v-share')!.addEventListener('click', async () => {
    const url = ctx.designId ? `${location.origin}/d/${ctx.designId}` : location.href;
    if (navigator.share) {
      await navigator.share({ title: ctx.title, url }).catch(() => {});
    } else {
      await navigator.clipboard.writeText(url).catch(() => {});
    }
  });
  document.getElementById('v-open')!.addEventListener('click', () => {
    location.search = location.search ? `${location.search}&editor=1` : '?editor=1';
  });

  // Gallery grid — thumbnails we already store; tap to load into the viewer.
  const galleryEl = document.getElementById('v-gallery')!;
  try {
    const items: GalleryItem[] = await listGallery();
    if (items.length === 0) {
      galleryEl.innerHTML = '<div class="v-muted">Nothing published yet.</div>';
    }
    for (const item of items.slice(0, 8)) {
      const card = document.createElement('button');
      card.className = 'v-g-card';
      card.innerHTML = `${
        item.hasThumbnail ? `<img src="${thumbnailUrl(item.id)}" alt="${item.title}" />` : ''
      }<span>${item.title}</span><small>by ${item.ownerName}</small>`;
      card.addEventListener('click', async () => {
        const { title } = await loadDesign(store, item.id);
        (document.getElementById('v-title') as HTMLElement).textContent = title;
        paint2D(document.getElementById('v-flat') as HTMLCanvasElement, map, store);
        preview.recolorAll();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      galleryEl.appendChild(card);
    }
  } catch {
    galleryEl.innerHTML = '<div class="v-muted">Gallery unavailable.</div>';
  }
}

/** Build a viewer-only DesignState seed (base color) when no design is loaded. */
export function seedViewerStore(map: SeatMap, palette: string[]): DesignState {
  const store = new DesignStore(map, palette);
  store.cells.fill(1);
  return store.toState();
}
