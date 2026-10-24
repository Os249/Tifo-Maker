import { cleanAddressBar } from './core/utm';
import './vendor/tabler-subset.css';
import { generateSeatMapAsync, warmHeavyWorker } from './workers/client';
import { TEMPLATES, DEFAULT_PALETTE } from './core/template';
import { loadTemplate } from './core/stadiumLoad';
import { DesignStore } from './core/design';
import {
  fetchDesignTemplate, fetchGalleryItem, fetchProfile, isSignedIn, listComments, loadPublicDesign, recordView,
  thumbnailUrl, voteDesign, type GalleryItem,
} from './net/api';
import { paint2D } from './ui/viewer';
import { openShareModal } from './ui/shareModal';
import { initLang, applyDom, getLang, t, tl, tv, toggleLang, tTitle } from './ui/i18n';
import { escapeHtml } from './core/escape';
import { hydrateBowls } from './ui/bowlPicture';

/**
 * The public tifo page, at /t/:id: where every shared link lands.
 *
 * It was the plainest page on the site: the basic 3D viewer on an olive field
 * with five camera buttons piled on top of it, a "1 views" line, and "make your
 * own" as a footnote. Now it is built like the thing it is, a tifo's own page:
 *
 *   - the tifo in its ground, in 3D, on a night frame, with the camera angles
 *     as one row of chips UNDER the view rather than four rows on top of it;
 *   - its name, its creator, its ground, a like that works, Share, Remix;
 *   - "Make your own tifo on <this ground>", which starts the editor on the
 *     same ground (the reason most visitors are here);
 *   - the seats, unrolled; the latest comments; more by the same creator.
 *
 * Private and unknown ids render an "unavailable" state (no leak).
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
      <a class="wordmark s-brand" href="/" dir="ltr">TIFO<b>MAKER</b></a>
      <h1>${escapeHtml(t('sh.unavailable'))}</h1>
      <p>${escapeHtml(msg)}</p>
      <div class="s-unavailable-acts">
        <a class="s-btn primary" href="/projects?new=1">${escapeHtml(t('sh.make'))}</a>
        <a class="s-btn" href="/community">${escapeHtml(t('sh.browse'))}</a>
      </div>
    </div>`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString(getLang() === 'ar' ? 'ar' : undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const shortGround = (id: string): string => tl(id).replace(/\s*[(（][^)）]*[)）]\s*$/, '') || tl(id);

async function main(): Promise<void> {
  initLang();
  // The visit was counted when the page was sent; see core/utm.ts.
  cleanAddressBar();
  applyDom(document);
  const app = document.getElementById('share-app')!;
  const id = designIdFromLocation();
  if (!id) {
    unavailable(app, t('sh.noId'));
    return;
  }

  // One request for the design, not two (performance plan P1.8): the answer
  // that names its stadium is the one its seats are loaded from below (see
  // designJson in net/api.ts). The gallery card and the worker start at the
  // same time instead of waiting their turn.
  warmHeavyWorker();
  const itemP = fetchGalleryItem(id).catch(() => null);
  // Resolve the template first so the seat map matches the saved cell count.
  const ref = await fetchDesignTemplate(id).catch(() => null);
  if (!ref) {
    unavailable(app, t('sh.gone'));
    return;
  }
  // Any shipped ground, legacy ones included — not only the three generic bowls.
  // Its own league's grounds only, not the whole catalogue (performance plan P2.7).
  const template = (await loadTemplate(ref.templateId)) ?? TEMPLATES[0];
  // A ground that fails its checks is not built at all (P1.16); say so rather
  // than leave the page blank.
  const [map, item] = await Promise.all([generateSeatMapAsync(template).catch(() => null), itemP]);
  if (!map) {
    unavailable(app, t('sh.gone'));
    return;
  }
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

  const title = item ? tTitle(item) : meta.title;
  const ground = shortGround(template.id);
  const startHere = `/projects?new=1&ground=${encodeURIComponent(template.id)}`;
  const canRemix = item?.allowRemix !== false;
  let likes = item?.likeScore ?? 0;
  let mine = item?.myVote === 1;

  app.innerHTML = `
    <header class="s-top">
      <a class="wordmark s-brand" href="/" dir="ltr">TIFO<b>MAKER</b></a>
      <nav class="s-nav">
        <a class="s-navlink" href="/community">${escapeHtml(t('nav.community'))}</a>
        <button class="s-navlink s-lang" id="s-lang" type="button">${escapeHtml(t('common.language'))}</button>
        <a class="s-btn primary s-make-top" href="${startHere}">${escapeHtml(t('sh.make'))}</a>
      </nav>
    </header>

    <section class="s-hero" aria-label="${escapeHtml(title)}">
      <div class="s-stage"><div id="s-preview-host"></div></div>
      <div class="s-cams" id="s-cams" role="group" aria-label="${escapeHtml(t('sh.cams'))}"></div>
    </section>

    <section class="s-main">
      <div class="s-info">
        <h1 class="s-title" id="s-title"></h1>
        <p class="s-sub" id="s-sub"></p>
        ${item?.description ? `<p class="s-desc">${escapeHtml(item.description)}</p>` : ''}
        <div class="s-actions">
          <button class="s-btn s-like${mine ? ' on' : ''}" id="s-like" type="button" aria-pressed="${mine}">
            <i class="ti ti-heart${mine ? '-filled' : ''}" aria-hidden="true"></i> <span id="s-like-n">${likes}</span>
            <span class="s-sr">${escapeHtml(t('sh.like'))}</span>
          </button>
          <button class="s-btn" id="s-share" type="button"><i class="ti ti-share" aria-hidden="true"></i> ${escapeHtml(t('v.share'))}</button>
          ${canRemix ? `<a class="s-btn" id="s-fork" href="/d/${encodeURIComponent(id)}"><i class="ti ti-git-fork" aria-hidden="true"></i> ${escapeHtml(t('sh.remix'))}</a>` : ''}
          <a class="s-btn" href="/d/${encodeURIComponent(id)}?sim=1"><i class="ti ti-building-stadium" aria-hidden="true"></i> ${escapeHtml(t('sh.matchday'))}</a>
        </div>
      </div>
      <aside class="s-make">
        <span class="s-make-scarf" aria-hidden="true"></span>
        <h2>${escapeHtml(tv('sh.makeOn', { ground }))}</h2>
        <p>${escapeHtml(t('sh.makeOnB'))}</p>
        <a class="s-btn primary s-make-go" href="${startHere}">${escapeHtml(tv('sh.makeGo', { ground }))}</a>
      </aside>
    </section>

    <section class="s-block">
      <h2 class="s-h2">${escapeHtml(t('sh.seats'))}</h2>
      <p class="s-note">${escapeHtml(t('sh.seatsB'))}</p>
      <canvas class="s-flat" id="s-flat" width="1100"></canvas>
    </section>

    <section class="s-block" id="s-comments" hidden>
      <h2 class="s-h2">${escapeHtml(t('sh.comments'))}</h2>
      <ul class="s-cmts" id="s-cmts"></ul>
      <a class="s-more-link" href="/community?t=${encodeURIComponent(id)}">${escapeHtml(t('sh.joinTalk'))} ${getLang() === 'ar' ? '←' : '→'}</a>
    </section>

    <section class="s-block" id="s-more" hidden>
      <h2 class="s-h2" id="s-more-h"></h2>
      <div class="s-more-grid" id="s-more-grid"></div>
    </section>

    <footer class="s-foot">
      ${escapeHtml(t('sh.madeWith'))} <a href="/">TifoMaker</a>: ${escapeHtml(t('sh.madeWith2'))}
    </footer>`;

  (document.getElementById('s-title') as HTMLElement).textContent = title;
  const sub = document.getElementById('s-sub') as HTMLElement;
  const viewsWord = (n: number): string => t(n === 1 ? 'sh.view' : 'sh.views');
  const parts = [
    meta.ownerName ? `${escapeHtml(t('v.by'))} <bdi class="at" dir="ltr">@${escapeHtml(meta.ownerName)}</bdi>` : '',
    escapeHtml(tl(template.id)),
    fmtDate(meta.createdAt),
    `<span id="s-views">${meta.viewCount.toLocaleString()}</span> <span id="s-views-w">${escapeHtml(viewsWord(meta.viewCount))}</span>`,
  ].filter(Boolean);
  sub.innerHTML = parts.join(' · ');
  document.title = `${title} · TifoMaker`;

  paint2D(document.getElementById('s-flat') as HTMLCanvasElement, map, store);

  // The tifo in its ground: the editor's Preview3D on a night frame.
  const host = document.getElementById('s-preview-host')!;
  const { Preview3D, CAMERA_PRESETS } = await import('./render/preview3d');
  const preview = new Preview3D(host, map, store, { template, transparent: true });
  const fullIdx = Math.max(0, CAMERA_PRESETS.findIndex((p) => p.name === 'Full view'));
  preview.applyPreset(CAMERA_PRESETS[fullIdx]);
  preview.start();

  // One row of camera chips, under the view: on a phone it scrolls sideways
  // instead of piling four rows over the stadium.
  const cams = document.getElementById('s-cams')!;
  CAMERA_PRESETS.forEach((p, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 's-cam' + (i === fullIdx ? ' active' : '');
    b.setAttribute('aria-pressed', String(i === fullIdx));
    b.textContent = tl(p.name);
    b.addEventListener('click', () => {
      preview.applyPreset(p);
      cams.querySelectorAll<HTMLElement>('.s-cam').forEach((el) => {
        el.classList.toggle('active', el === b);
        el.setAttribute('aria-pressed', String(el === b));
      });
    });
    cams.appendChild(b);
  });

  document.getElementById('s-share')!.addEventListener('click', () => openShareModal({ id, title }));
  document.getElementById('s-lang')!.addEventListener('click', () => {
    toggleLang();
    location.reload();
  });

  // A like that works, signed in or not: signed out, it asks for an account
  // and then counts the like that was asked for.
  const likeBtn = document.getElementById('s-like') as HTMLButtonElement;
  const paintLike = (): void => {
    likeBtn.classList.toggle('on', mine);
    likeBtn.setAttribute('aria-pressed', String(mine));
    const icon = likeBtn.querySelector('i');
    if (icon) icon.className = `ti ti-heart${mine ? '-filled' : ''}`;
    const n = document.getElementById('s-like-n');
    if (n) n.textContent = String(likes);
  };
  likeBtn.addEventListener('click', async () => {
    if (!isSignedIn()) {
      const { openAuthModal } = await import('./ui/authModal');
      if (!(await openAuthModal(false, 'signup'))) return;
    }
    likeBtn.disabled = true;
    try {
      const r = await voteDesign(id, mine ? 0 : 1);
      likes = r.likeScore;
      mine = r.myVote === 1;
      paintLike();
    } catch {
      /* the count stays as it was */
    } finally {
      likeBtn.disabled = false;
    }
  });

  // Count this view, then reflect the fresh total.
  void recordView(id).then((views) => {
    if (views <= 0) return;
    const el = document.getElementById('s-views');
    if (el) el.textContent = views.toLocaleString();
    const w = document.getElementById('s-views-w');
    if (w) w.textContent = viewsWord(views);
  });

  // The latest comments, read-only here; the conversation lives in Community.
  void listComments(id).then((all) => {
    const top = all.filter((c) => !c.parentId).slice(-4).reverse();
    const box = document.getElementById('s-comments')!;
    const list = document.getElementById('s-cmts')!;
    list.innerHTML = top.length
      ? top.map((c) => `<li class="s-cmt"><b><bdi dir="ltr">@${escapeHtml(c.authorName)}</bdi></b> <span class="s-cmt-when">${escapeHtml(fmtDate(c.createdAt))}</span><p>${escapeHtml(c.body)}</p></li>`).join('')
      : `<li class="s-cmt s-cmt-none">${escapeHtml(t('sh.noComments'))}</li>`;
    box.hidden = false;
  }).catch(() => {});

  // More by the same creator, as stand pictures.
  if (item?.ownerId) {
    void fetchProfile(item.ownerId).then((p) => {
      const more = (p.created ?? []).filter((d: GalleryItem) => d.id !== id && d.hasThumbnail).slice(0, 4);
      if (!more.length) return;
      // The handle is a Latin run inside what may be an Arabic sentence: isolated, so the "@" stays in front.
      const [before, after] = t('sh.moreBy').split('@{name}');
      document.getElementById('s-more-h')!.innerHTML = `${escapeHtml(before ?? '')}<bdi dir="ltr">@${escapeHtml(p.username)}</bdi>${escapeHtml(after ?? '')}`;
      const grid = document.getElementById('s-more-grid')!;
      grid.innerHTML = more.map((d) => `
        <a class="s-more-card" href="/t/${encodeURIComponent(d.id)}">
          <span class="s-more-pic is-bowl"><img data-bowl="${thumbnailUrl(d.id)}" alt="" /></span>
          <span class="s-more-title">${escapeHtml(tTitle(d))}</span>
        </a>`).join('');
      document.getElementById('s-more')!.hidden = false;
      hydrateBowls(grid);
    }).catch(() => {});
  }
}

void main();
