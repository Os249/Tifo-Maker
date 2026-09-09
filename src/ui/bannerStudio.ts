import type { AssetStore, AssetType } from '../core/sceneAssets';
import type { DesignStore } from '../core/design';
import type { SeatMap } from '../core/types';

/**
 * Banner Studio — design a custom banner on its OWN artboard, completely separate
 * from the seat-paint grid, then zone-snap it onto a stand. It paints an image and
 * adds it to the shared AssetStore with a `place` hint the Match Day simulator
 * resolves to a real 3D position on open. Kept isolated (its own module + styles)
 * so it can never disturb the locked editor layout or the paint engine.
 *
 * F1: paint (brush + palette + eraser) + zone-snap placement. Free drag/resize
 * in 3D is a planned follow-up (F3).
 */

interface BannerStudioDeps {
  trigger: HTMLElement | null;
  assetStore: AssetStore;
  store: DesignStore;
  map: SeatMap;
}

type Zone = 'surface' | 'big' | 'small' | 'floor' | 'gap' | 'stairs';

const STAND_NAME = ['East', 'North', 'West', 'South'];

function injectCss(): void {
  if (document.getElementById('bstudio-css')) return;
  const s = document.createElement('style');
  s.id = 'bstudio-css';
  s.textContent = `
.bstudio-overlay{position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;background:rgba(3,5,8,.66);backdrop-filter:blur(4px);}
.bstudio{width:min(760px,94vw);max-height:92vh;overflow:auto;background:#0d1117;border:1px solid #232a36;border-radius:16px;box-shadow:0 24px 80px rgba(0,0,0,.6);color:#e6edf3;font:14px system-ui,sans-serif;}
.bstudio-head{display:flex;align-items:center;justify-content:space-between;padding:15px 18px;border-bottom:1px solid #1b2230;}
.bstudio-head h3{margin:0;font-size:16px;font-weight:700;}
.bstudio-x{background:#161b22;border:1px solid #232a36;color:#e6edf3;width:30px;height:30px;border-radius:8px;cursor:pointer;font-size:16px;line-height:1;}
.bstudio-body{padding:16px 18px;display:flex;flex-direction:column;gap:14px;}
.bstudio-canvas-wrap{position:relative;background:#05070a;border:1px solid #232a36;border-radius:10px;padding:10px;display:flex;justify-content:center;}
#bstudio-canvas{background:#ffffff;border-radius:4px;max-width:100%;touch-action:none;cursor:crosshair;box-shadow:0 4px 20px rgba(0,0,0,.4);}
.bstudio-tools{display:flex;flex-wrap:wrap;gap:12px;align-items:center;}
.bstudio-sw{display:flex;gap:6px;flex-wrap:wrap;}
.bstudio-chip{width:26px;height:26px;border-radius:7px;border:2px solid #2b3444;cursor:pointer;padding:0;}
.bstudio-chip.on{border-color:#8b7cff;box-shadow:0 0 0 2px rgba(139,124,255,.4);}
.bstudio-field{display:flex;align-items:center;gap:7px;font-size:12.5px;color:#aeb7c4;}
.bstudio-field select,.bstudio-field input[type=range]{accent-color:#8b7cff;}
.bstudio-sel{background:#161b22;color:#e6edf3;border:1px solid #2b3444;border-radius:8px;padding:6px 9px;font:13px system-ui,sans-serif;cursor:pointer;}
.bstudio-btn{background:#161b22;border:1px solid #2b3444;color:#e6edf3;border-radius:8px;padding:7px 12px;cursor:pointer;font:13px system-ui,sans-serif;}
.bstudio-btn.primary{background:#3b82f6;border-color:#3b82f6;color:#fff;font-weight:600;}
.bstudio-place{display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding-top:4px;border-top:1px solid #1b2230;}
.bstudio-grow{flex:1;}
.bstudio-toast{position:fixed;left:50%;bottom:34px;transform:translateX(-50%);background:#132a16;border:1px solid #2e7d32;color:#d7f5db;padding:11px 18px;border-radius:10px;z-index:130;font:13px system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5);}
`;
  document.head.appendChild(s);
}

export function mountBannerStudio(deps: BannerStudioDeps): void {
  const { trigger, assetStore, store } = deps;
  if (!trigger) return;
  injectCss();

  let overlay: HTMLDivElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let color = store.palette[1] ?? '#e11d2a';
  let brush = 16;
  let erasing = false;

  const toast = (msg: string): void => {
    const t = document.createElement('div');
    t.className = 'bstudio-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3600);
  };

  const zoneToType = (z: Zone): AssetType => (z === 'surface' ? 'surface' : z === 'floor' ? 'floor' : 'banner');

  const build = (): void => {
    overlay = document.createElement('div');
    overlay.className = 'bstudio-overlay';
    overlay.innerHTML = `
      <div class="bstudio" role="dialog" aria-label="Banner Studio">
        <div class="bstudio-head">
          <h3>🎌 Banner Studio</h3>
          <button class="bstudio-x" data-x aria-label="Close">✕</button>
        </div>
        <div class="bstudio-body">
          <div class="bstudio-canvas-wrap"><canvas id="bstudio-canvas" width="640" height="192"></canvas></div>
          <div class="bstudio-tools">
            <div class="bstudio-sw" data-sw></div>
            <label class="bstudio-field">＋<input type="color" data-color value="#1c6fe0"></label>
            <label class="bstudio-field">Brush <input type="range" data-brush min="3" max="48" value="16"></label>
            <button class="bstudio-btn" data-erase>Eraser</button>
            <button class="bstudio-btn" data-fill>Fill bg</button>
            <button class="bstudio-btn" data-clear>Clear</button>
          </div>
          <div class="bstudio-place">
            <label class="bstudio-field">Place as
              <select class="bstudio-sel" data-zone>
                <option value="surface">Drape whole stand (surface tifo)</option>
                <option value="big">Hang over the seats (big banner)</option>
                <option value="small">Cover the front fence (Zaunfahne)</option>
                <option value="gap">Fill the walkway gap (rail banner)</option>
                <option value="stairs">Cover the stairs (vertical strip)</option>
                <option value="floor">Pitch-side floor banner</option>
              </select>
            </label>
            <label class="bstudio-field">Stand
              <select class="bstudio-sel" data-stand>
                <option value="1">North</option>
                <option value="0">East</option>
                <option value="3">South</option>
                <option value="2">West</option>
              </select>
            </label>
            <span class="bstudio-grow"></span>
            <button class="bstudio-btn primary" data-place>Add to stadium</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    canvas = overlay.querySelector('#bstudio-canvas');
    ctx = canvas ? canvas.getContext('2d') : null;
    if (ctx && canvas) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    }

    // swatches from the design palette
    const sw = overlay.querySelector('[data-sw]');
    if (sw) {
      store.palette.forEach((hex, i) => {
        if (i === 0) return;
        const b = document.createElement('button');
        b.className = 'bstudio-chip' + (hex === color ? ' on' : '');
        b.style.background = hex;
        b.addEventListener('click', () => {
          color = hex;
          erasing = false;
          sw.querySelectorAll('.bstudio-chip').forEach((c) => c.classList.remove('on'));
          b.classList.add('on');
        });
        sw.appendChild(b);
      });
    }

    const q = <T extends HTMLElement>(sel: string): T | null => (overlay ? overlay.querySelector<T>(sel) : null);
    q<HTMLInputElement>('[data-color]')?.addEventListener('input', (e) => {
      color = (e.target as HTMLInputElement).value;
      erasing = false;
      overlay?.querySelectorAll('.bstudio-chip').forEach((c) => c.classList.remove('on'));
    });
    q<HTMLInputElement>('[data-brush]')?.addEventListener('input', (e) => { brush = Number((e.target as HTMLInputElement).value); });
    q<HTMLButtonElement>('[data-erase]')?.addEventListener('click', () => { erasing = true; });
    q<HTMLButtonElement>('[data-fill]')?.addEventListener('click', () => {
      if (ctx && canvas) { ctx.fillStyle = color; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    });
    q<HTMLButtonElement>('[data-clear]')?.addEventListener('click', () => {
      if (ctx && canvas) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    });
    q<HTMLButtonElement>('[data-x]')?.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    q<HTMLButtonElement>('[data-place]')?.addEventListener('click', () => {
      if (!canvas) return;
      const zone = (q<HTMLSelectElement>('[data-zone]')?.value ?? 'surface') as Zone;
      const stand = Number(q<HTMLSelectElement>('[data-stand]')?.value ?? '1') as 0 | 1 | 2 | 3;
      const imageRef = canvas.toDataURL('image/png');
      assetStore.add(zoneToType(zone), {
        anchor: { stand },
        place: zone,
        imageRef,
        color,
        cloth: zone === 'surface',
        position: { x: 0, y: 12, z: 0 },
        scale: { x: 30, y: 12, z: 1 },
      });
      close();
      const where = zone === 'floor' ? 'pitch-side' : `${STAND_NAME[stand]} stand`;
      toast(`Banner added to the ${where}, open Match Day to see it`);
    });

    // painting
    const draw = (e: PointerEvent, move: boolean): void => {
      if (!canvas || !ctx) return;
      const r = canvas.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * canvas.width;
      const y = ((e.clientY - r.top) / r.height) * canvas.height;
      ctx.strokeStyle = erasing ? '#ffffff' : color;
      ctx.fillStyle = erasing ? '#ffffff' : color;
      ctx.lineWidth = brush;
      if (move) { ctx.lineTo(x, y); ctx.stroke(); }
      else { ctx.beginPath(); ctx.moveTo(x, y); ctx.beginPath(); ctx.arc(x, y, brush / 2, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.moveTo(x, y); }
    };
    let down = false;
    canvas?.addEventListener('pointerdown', (e) => { down = true; canvas?.setPointerCapture(e.pointerId); draw(e, false); });
    canvas?.addEventListener('pointermove', (e) => { if (down) draw(e, true); });
    canvas?.addEventListener('pointerup', () => { down = false; });
    canvas?.addEventListener('pointerleave', () => { down = false; });
  };

  function close(): void {
    overlay?.remove();
    overlay = null;
    canvas = null;
    ctx = null;
  }

  trigger.addEventListener('click', () => {
    color = store.palette[1] ?? color;
    build();
  });
}
