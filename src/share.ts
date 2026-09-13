import '@tabler/icons-webfont/dist/tabler-icons.min.css';
import { generateSeatMapAsync } from './workers/client';
import { TEMPLATES, DEFAULT_PALETTE } from './core/template';
import { DesignStore } from './core/design';
import { fetchDesignTemplate, loadPublicDesign, recordView } from './net/api';
import { paint2D } from './ui/viewer';
import { openShareModal } from './ui/shareModal';
import { initLang, applyDom, t, tl } from './ui/i18n';

/**
 * The dedicated public tifo page served at /t/:id.
 *
 * Reuses the engine end-to-end: the same seat-map generator, DesignStore,
 * Preview3D (the 3D hero, defaulting to the "Full view" camera) and the 2D flat
 * paint from the phone viewer. It loads a PUBLIC design, shows its vitals
 * (title, creator, stadium, date, views), counts a view, and opens the shared
 * share modal. Private/unknown ids render an "unavailable" state (no leak).
 */

function designIdFromLocation(): string | null {
  const m = location.pathname.match(/^\/t\/([A-Za-z0-9-]+)\/?$/);
  if (m) return m[1];
  const q = new URLSearchParams(location.search);
  const id = q.get('id') || q.get('design');
  return id && /^[A-Za-z0-9-]+$/.test(id) ? id : null;
}

function unavailable(app: HTMLElement, msg: string): void {
  app.innerHTML = `
    <div class="s-unavailable">
      <div class="s-brand"><a href="/">TIFO<b>MAKER</b></a></div>
      <h1>${t('sh.unavailable')}</h1>
      <p>${msg}</p>
      <a class="s-cta" href="/community">${t('sh.browse')} →</a>
    </div>`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

async function main(): Promise<void> {
  initLang();
  applyDom(document);
  const app = document.getElementById('share-app')!;
  const id = designIdFromLocation();
  if (!id) {
    unavailable(app, t('sh.noId'));
    return;
  }

  // Resolve the template first so the seat map matches the saved cell count.
  const ref = await fetchDesignTemplate(id).catch(() => null);
  if (!ref) {
    unavailable(app, t('sh.gone'));
    return;
  }
  const template = TEMPLATES.find((t) => t.id === ref.templateId) ?? TEMPLATES[0];
  const map = await generateSeatMapAsync(template.id);
  const store = new DesignStore(map, DEFAULT_PALETTE.slice());

  const meta = await loadPublicDesign(store, id).catch(() => null);
  if (!meta) {
    unavailable(app, t('sh.gone'));
    return;
  }
  if (!meta.isPublic && !meta.ownerIsMe) {
    unavailable(app, t('sh.private'));
    return;
  }

  app.innerHTML = `
    <header class="s-top">
      <div class="s-brand"><a href="/">TIFO<b>MAKER</b></a></div>
      <button class="s-open" id="s-open"><i class="ti ti-external-link"></i> ${t('sh.open')}</button>
    </header>
    <div class="s-hero">
      <div id="s-preview-host"></div>
      <div class="s-cams" id="s-cams"></div>
    </div>
    <div class="s-body">
      <h1 class="s-title" id="s-title"></h1>
      <div class="s-sub" id="s-sub"></div>
      <div class="s-actions">
        <button class="s-share" id="s-share"><i class="ti ti-share"></i> ${t('v.share')}</button>
        <button class="s-fork" id="s-fork"><i class="ti ti-git-fork"></i> ${t('sh.remix')}</button>
      </div>
      <canvas class="s-flat" id="s-flat" width="900"></canvas>
      <div class="s-foot">
        ${t('sh.madeWith')} <a href="/">TifoMaker</a>: ${t('sh.madeWith2')}
      </div>
    </div>`;

  (document.getElementById('s-title') as HTMLElement).textContent = meta.title;
  const sub = document.getElementById('s-sub') as HTMLElement;
  const esc = (s: string): string =>
    s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
  const parts = [
    meta.ownerName ? `${t('v.by')} <span class="at">@${esc(meta.ownerName)}</span>` : '',
    esc(tl(template.id)),
    fmtDate(meta.createdAt),
    `<span id="s-views">${meta.viewCount.toLocaleString()}</span> ${t('sh.views')}`,
  ].filter(Boolean);
  sub.innerHTML = parts.join(' · ');

  paint2D(document.getElementById('s-flat') as HTMLCanvasElement, map, store);

  // 3D hero: reuse the editor's Preview3D, defaulting to the Full view camera.
  const host = document.getElementById('s-preview-host')!;
  const { Preview3D, CAMERA_PRESETS } = await import('./render/preview3d');
  const preview = new Preview3D(host, map, store);
  const fullIdx = Math.max(0, CAMERA_PRESETS.findIndex((p) => p.name === 'Full view'));
  preview.applyPreset(CAMERA_PRESETS[fullIdx]);
  preview.start();

  const cams = document.getElementById('s-cams')!;
  CAMERA_PRESETS.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 's-cam' + (i === fullIdx ? ' active' : '');
    b.textContent = tl(p.name);
    b.addEventListener('click', () => {
      preview.applyPreset(p);
      cams.querySelectorAll('.s-cam').forEach((el) => el.classList.remove('active'));
      b.classList.add('active');
    });
    cams.appendChild(b);
  });

  document.getElementById('s-share')!.addEventListener('click', () => openShareModal({ id, title: meta.title }));
  document.getElementById('s-open')!.addEventListener('click', () => {
    location.href = `/d/${id}`;
  });
  document.getElementById('s-fork')!.addEventListener('click', () => {
    location.href = `/d/${id}`;
  });

  // Count this view, then reflect the fresh total.
  const views = await recordView(id);
  if (views > 0) {
    const el = document.getElementById('s-views');
    if (el) el.textContent = views.toLocaleString();
  }
}

void main();
