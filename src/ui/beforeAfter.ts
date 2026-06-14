import { listPhotos, photoUrl, thumbnailUrl, type GalleryItem } from '../net/api';

/**
 * Before/After detail view — the social-proof centerpiece. Shows the design's
 * 3D/digital thumbnail beside a real match-day photo, split by a draggable
 * divider so a skeptic can see "the plan" become "the result". This is the
 * element that turns a doubtful fan group into a believer.
 *
 * Opens as an overlay for a gallery item that has at least one photo.
 */
export async function openBeforeAfter(item: GalleryItem): Promise<void> {
  const photos = await listPhotos(item.id).catch(() => []);
  if (photos.length === 0) return;

  const backdrop = document.createElement('div');
  backdrop.className = 'ba-backdrop';
  backdrop.innerHTML = `
    <div class="ba-panel" role="dialog" aria-modal="true" aria-label="Before and after">
      <button class="ba-close" aria-label="Close">&times;</button>
      <div class="ba-title">${escapeHtml(item.title)}</div>
      <div class="ba-sub">Drag the divider — the design on the left, the real stand on the right.</div>
      <div class="ba-stage" id="ba-stage">
        <img class="ba-img ba-after" id="ba-after" alt="Real match-day photo" />
        <div class="ba-before-wrap" id="ba-before-wrap">
          <img class="ba-img ba-before" id="ba-before" src="${item.hasThumbnail ? thumbnailUrl(item.id) : ''}" alt="Digital design" />
          <span class="ba-tag ba-tag-before">Design</span>
        </div>
        <span class="ba-tag ba-tag-after">Real stand</span>
        <div class="ba-divider" id="ba-divider"><div class="ba-handle">⟷</div></div>
      </div>
      <div class="ba-caption" id="ba-caption"></div>
      ${photos.length > 1 ? `<div class="ba-thumbs" id="ba-thumbs"></div>` : ''}
    </div>
  `;
  document.body.appendChild(backdrop);

  const close = (): void => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector('.ba-close')!.addEventListener('click', close);

  const afterImg = backdrop.querySelector('#ba-after') as HTMLImageElement;
  const beforeWrap = backdrop.querySelector('#ba-before-wrap') as HTMLElement;
  const divider = backdrop.querySelector('#ba-divider') as HTMLElement;
  const stage = backdrop.querySelector('#ba-stage') as HTMLElement;
  const captionEl = backdrop.querySelector('#ba-caption') as HTMLElement;

  const showPhoto = (i: number): void => {
    afterImg.src = photoUrl(photos[i].id);
    captionEl.textContent = photos[i].caption ?? '';
    setSplit(50);
  };

  // Draggable split.
  let dragging = false;
  const setSplit = (pct: number): void => {
    const clamped = Math.max(0, Math.min(100, pct));
    beforeWrap.style.width = `${clamped}%`;
    divider.style.left = `${clamped}%`;
  };
  const moveTo = (clientX: number): void => {
    const rect = stage.getBoundingClientRect();
    setSplit(((clientX - rect.left) / rect.width) * 100);
  };
  const onMove = (e: PointerEvent | MouseEvent): void => {
    if (dragging) moveTo(e.clientX);
  };
  const onUp = (): void => {
    dragging = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('mouseup', onUp);
  };
  const startDrag = (e: Event): void => {
    dragging = true;
    e.preventDefault();
    // Listen on window so movement anywhere updates the split (cursor leaves the
    // 2px divider immediately). Cover both pointer and mouse event models.
    window.addEventListener('pointermove', onMove);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('mouseup', onUp);
  };
  divider.addEventListener('pointerdown', startDrag);
  divider.addEventListener('mousedown', startDrag);
  // Also let a click anywhere on the stage move the divider.
  stage.addEventListener('click', (e) => {
    if (e.target === divider || divider.contains(e.target as Node)) return;
    moveTo((e as MouseEvent).clientX);
  });

  if (photos.length > 1) {
    const thumbs = backdrop.querySelector('#ba-thumbs') as HTMLElement;
    photos.forEach((p, i) => {
      const t = document.createElement('button');
      t.className = 'ba-thumb';
      t.innerHTML = `<img src="${photoUrl(p.id)}" alt="${escapeHtml(p.caption ?? 'photo')}" loading="lazy" />`;
      t.addEventListener('click', () => {
        showPhoto(i);
        thumbs.querySelectorAll('.ba-thumb').forEach((x, xi) => x.classList.toggle('active', xi === i));
      });
      if (i === 0) t.classList.add('active');
      thumbs.appendChild(t);
    });
  }

  showPhoto(0);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
