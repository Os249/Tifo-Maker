import '@tabler/icons-webfont/dist/tabler-icons.min.css';
import { installTheme } from './ui/theme';
import { generateSeatMapAsync } from './workers/client';
import { DEFAULT_PALETTE, DEFAULT_TEMPLATE, TEMPLATES } from './core/template';
import { PATTERN_PRESETS } from './core/patterns';
import { DesignStore } from './core/design';
import { ObjectLayer } from './core/objects';
import { Editor } from './render/editor';
import type { Preview3D } from './render/preview3d';
import { mountToolbar } from './ui/toolbar';
import { mountViewer } from './ui/viewer';

/** Phones get the viewer; tablet/desktop get the editor. ?editor=1 forces the editor. */
const PHONE_MAX = 768;
function isPhone(): boolean {
  const forced = new URLSearchParams(location.search).get('editor') === '1';
  return !forced && window.matchMedia(`(max-width: ${PHONE_MAX - 1}px)`).matches;
}

async function main(): Promise<void> {
  installTheme();
  const wanted = new URLSearchParams(location.search).get('template');
  const template = TEMPLATES.find((t) => t.id === wanted) ?? DEFAULT_TEMPLATE;
  const t0 = performance.now();
  // Off-thread generation keeps the UI responsive even for the 76k oval.
  const map = await generateSeatMapAsync(template.id);
  const genMs = performance.now() - t0;

  // Phone branch: build the seeded store and hand off to the read-only viewer.
  if (isPhone()) {
    const vstore = new DesignStore(map, DEFAULT_PALETTE.slice());
    const vseed = PATTERN_PRESETS.find((p) => p.id === 'border')!.cellAt(map);
    for (let i = 0; i < map.count; i++) vstore.cells[i] = vseed(i);
    await mountViewer({ map, store: vstore, templateName: template.name, title: 'Untitled tifo' });
    return;
  }

  // Stadium selector: switching reloads with a fresh canvas for that bowl.
  const stadiumSel = document.getElementById('stadium') as HTMLSelectElement;
  for (const t of TEMPLATES) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    stadiumSel.appendChild(opt);
  }
  stadiumSel.value = template.id;
  stadiumSel.addEventListener('change', () => {
    location.search = `?template=${encodeURIComponent(stadiumSel.value)}`;
  });

  const store = new DesignStore(map, DEFAULT_PALETTE.slice());

  // Seed a starter design so the canvas never opens blank — the border preset
  // is template-agnostic (it derives each tier's edge rows from the map).
  const seed = PATTERN_PRESETS.find((p) => p.id === 'border')!.cellAt(map);
  for (let i = 0; i < map.count; i++) store.cells[i] = seed(i);

  const host = document.getElementById('canvas-host')!;
  const editor = await Editor.create(host, map, store);
  editor.aisleCount = template.aisles.count;
  editor.drawGrid(true);
  const objects = new ObjectLayer();
  editor.attachObjectLayer(objects);
  mountToolbar(document.body, editor, store, map, objects, () => preview);

  // --- Phase 2: lazy-initialized 3D preview sharing the same store ---
  const previewHost = document.getElementById('preview-host')!;
  const btn2d = document.getElementById('view-2d') as HTMLButtonElement;
  const btn3d = document.getElementById('view-3d') as HTMLButtonElement;
  const camBar = document.getElementById('cam-bar')!;
  let preview: Preview3D | null = null;
  let loading = false;

  const show3d = async (on: boolean): Promise<void> => {
    host.hidden = on;
    previewHost.hidden = !on;
    camBar.hidden = !on;
    btn2d.classList.toggle('active', !on);
    btn3d.classList.toggle('active', on);
    if (on) {
      if (!preview) {
        if (loading) return;
        loading = true;
        // Code-split: Three.js loads only when the stadium view is first
        // opened. The editor's initial bundle stays Pixi-only.
        const { Preview3D, CAMERA_PRESETS } = await import('./render/preview3d');
        preview = new Preview3D(previewHost, map, store);
        const sel = document.getElementById('camera-preset') as HTMLSelectElement;
        CAMERA_PRESETS.forEach((p, i) => {
          const opt = document.createElement('option');
          opt.value = String(i);
          opt.textContent = p.name;
          sel.appendChild(opt);
        });
        sel.addEventListener('change', () => preview!.applyPreset(CAMERA_PRESETS[Number(sel.value)]));
        const noshow = document.getElementById('noshow') as HTMLInputElement;
        noshow.addEventListener('change', () => preview!.setNoShows(noshow.checked));
        loading = false;
      }
      preview.recolorAll();
      preview.start();
      editor.app.ticker.stop();
    } else {
      preview?.stop();
      editor.app.ticker.start();
      requestAnimationFrame(() => {
        editor.app.resize();
        editor.fitToView();
      });
    }
  };
  btn2d.addEventListener('click', () => void show3d(false));
  btn3d.addEventListener('click', () => void show3d(true));

  const stat = document.getElementById('stat')!;
  stat.textContent = `${template.name} · ${map.count.toLocaleString()} seats · map generated in ${genMs.toFixed(0)} ms`;

  window.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (e.key === 'Tab' && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') {
      e.preventDefault();
      document.body.classList.toggle('zen');
      requestAnimationFrame(() => {
        editor.app.resize();
        editor.fitToView();
      });
    }
  });

  window.addEventListener('resize', () => editor.fitToView());
}

void main();
