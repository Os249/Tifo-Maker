import { listGallery, thumbnailUrl } from '../net/api';

/** Public-gallery overlay: thumbnails + one-click load. Vanilla DOM, themed
 *  via the page's CSS custom properties. */
export async function openGallery(onPick: (id: string) => void): Promise<void> {
  const backdrop = document.createElement('div');
  backdrop.style.cssText =
    'position:fixed;inset:0;background:rgba(4,6,10,0.72);display:flex;align-items:center;justify-content:center;z-index:50;';
  const panel = document.createElement('div');
  panel.style.cssText =
    'background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px;width:min(860px,92vw);max-height:84vh;overflow:auto;';
  panel.innerHTML = '<div style="font-weight:700;font-size:16px;margin-bottom:14px;">Public gallery</div>';
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px;';
  panel.appendChild(grid);
  backdrop.appendChild(panel);
  const close = (): void => backdrop.remove();
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  document.body.appendChild(backdrop);

  try {
    const items = await listGallery();
    if (items.length === 0) {
      grid.innerHTML = '<div style="color:var(--muted);">Nothing published yet — save a design and tick Public.</div>';
      return;
    }
    for (const item of items) {
      const card = document.createElement('div');
      card.style.cssText =
        'border:1px solid var(--line);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px;';
      if (item.hasThumbnail) {
        const img = document.createElement('img');
        img.src = thumbnailUrl(item.id);
        img.alt = item.title;
        img.style.cssText = 'width:100%;border-radius:6px;background:#14171f;image-rendering:pixelated;';
        card.appendChild(img);
      }
      const title = document.createElement('div');
      title.textContent = item.title;
      title.style.cssText = 'font-weight:600;';
      const by = document.createElement('div');
      by.textContent = `by ${item.ownerName}`;
      by.style.cssText = 'color:var(--muted);font-size:12px;';
      const btn = document.createElement('button');
      btn.textContent = 'Load';
      btn.addEventListener('click', () => {
        close();
        onPick(item.id);
      });
      card.append(title, by, btn);
      grid.appendChild(card);
    }
  } catch (err) {
    grid.innerHTML = `<div style="color:var(--muted);">Gallery unavailable: ${(err as Error).message} — is the API running? (npm run server)</div>`;
  }
}
