import {
  listReports, dismissReport, takedownDesign,
  listUnverifiedPhotos, verifyPhoto, adminDeletePhoto,
  thumbnailUrl, photoUrl,
  type ReportItem, type PhotoReviewItem,
} from '../net/api';

/**
 * Moderation panel (admins only — the button that opens this is gated on
 * me.isAdmin, and every endpoint is gated server-side regardless). Two jobs that
 * previously required hand-querying the database:
 *   • Reports queue — review reported designs and dismiss or take them down.
 *   • Photo verification — confirm real match-day photos as genuine.
 */
export async function openModeration(): Promise<void> {
  const backdrop = document.createElement('div');
  backdrop.className = 'feed-backdrop';
  backdrop.innerHTML = `
    <div class="feed-panel" role="dialog" aria-modal="true" aria-label="Moderation">
      <div class="feed-head">
        <div class="feed-title">Moderation</div>
        <div class="feed-sub">Review reports and verify match-day photos.</div>
        <button class="feed-close" aria-label="Close">&times;</button>
        <div class="feed-sorts" style="margin-top:12px;">
          <button class="feed-sort active" data-tab="reports">Reports</button>
          <button class="feed-sort" data-tab="photos">Photo verification</button>
        </div>
      </div>
      <div class="mod-body" id="mod-body"><div class="feed-loading">Loading…</div></div>
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
  backdrop.querySelector('.feed-close')!.addEventListener('click', close);

  const body = backdrop.querySelector('#mod-body') as HTMLElement;
  const tabs = Array.from(backdrop.querySelectorAll('.feed-sort[data-tab]')) as HTMLButtonElement[];
  let tab: 'reports' | 'photos' = 'reports';

  const renderReports = (items: ReportItem[]): void => {
    if (items.length === 0) {
      body.innerHTML = '<div class="feed-empty">No open reports. The queue is clear.</div>';
      return;
    }
    body.innerHTML = '';
    for (const r of items) {
      const row = document.createElement('div');
      row.className = 'mod-row';
      const thumb = r.targetHasThumbnail
        ? `<img class="mod-thumb" src="${thumbnailUrl(r.targetId)}" alt="reported design" loading="lazy" />`
        : '<div class="mod-thumb mod-thumb-empty"></div>';
      const gone = r.targetTitle === null;
      row.innerHTML = `
        ${thumb}
        <div class="mod-info">
          <div class="mod-title">${gone ? '<em>(design deleted)</em>' : escapeHtml(r.targetTitle!)}
            ${r.targetIsPublic === false ? '<span class="mod-flag">already hidden</span>' : ''}</div>
          <div class="mod-meta">${gone ? '' : 'by ' + escapeHtml(r.targetOwner ?? 'unknown') + ' · '}reported: <strong>${escapeHtml(r.reason)}</strong></div>
          <div class="mod-meta mod-date">${new Date(r.createdAt).toLocaleString()}</div>
        </div>
        <div class="mod-actions">
          ${!gone && r.targetIsPublic !== false ? '<button class="mod-btn mod-danger" data-act="takedown">Take down</button>' : ''}
          <button class="mod-btn" data-act="dismiss">Dismiss</button>
        </div>
      `;
      row.querySelector('[data-act="dismiss"]')?.addEventListener('click', async () => {
        await dismissReport(r.id).catch(() => {});
        row.remove();
        if (!body.querySelector('.mod-row')) renderReports([]);
      });
      row.querySelector('[data-act="takedown"]')?.addEventListener('click', async () => {
        const { confirmModal } = await import('./modal');
        const ok = await confirmModal({
          title: 'Take down this design?',
          message: `“${r.targetTitle}” will be hidden from the public gallery.`,
          confirmLabel: 'Take it down',
          danger: true,
        });
        if (!ok) return;
        await takedownDesign(r.targetId).catch(() => {});
        row.remove();
        if (!body.querySelector('.mod-row')) renderReports([]);
      });
      body.appendChild(row);
    }
  };

  const renderPhotos = (items: PhotoReviewItem[]): void => {
    if (items.length === 0) {
      body.innerHTML = '<div class="feed-empty">No photos awaiting verification.</div>';
      return;
    }
    body.innerHTML = '';
    for (const p of items) {
      const row = document.createElement('div');
      row.className = 'mod-row';
      row.innerHTML = `
        <img class="mod-thumb mod-thumb-photo" src="${photoUrl(p.id)}" alt="match-day photo" loading="lazy" />
        <div class="mod-info">
          <div class="mod-title">${p.designTitle ? escapeHtml(p.designTitle) : '<em>(design deleted)</em>'}</div>
          <div class="mod-meta">${p.caption ? escapeHtml(p.caption) : '<em>no caption</em>'}</div>
          <div class="mod-meta mod-date">${new Date(p.createdAt).toLocaleString()}</div>
        </div>
        <div class="mod-actions">
          <button class="mod-btn mod-ok" data-act="verify">Verify</button>
          <button class="mod-btn mod-danger" data-act="remove">Remove</button>
        </div>
      `;
      row.querySelector('[data-act="verify"]')?.addEventListener('click', async () => {
        await verifyPhoto(p.id, true).catch(() => {});
        row.remove();
        if (!body.querySelector('.mod-row')) renderPhotos([]);
      });
      row.querySelector('[data-act="remove"]')?.addEventListener('click', async () => {
        const { confirmModal } = await import('./modal');
        const ok = await confirmModal({
          title: 'Remove this photo?',
          message: 'This permanently deletes the photo. This can’t be undone.',
          confirmLabel: 'Remove photo',
          danger: true,
        });
        if (!ok) return;
        await adminDeletePhoto(p.id).catch(() => {});
        row.remove();
        if (!body.querySelector('.mod-row')) renderPhotos([]);
      });
      body.appendChild(row);
    }
  };

  const load = async (): Promise<void> => {
    body.innerHTML = '<div class="feed-loading">Loading…</div>';
    try {
      if (tab === 'reports') renderReports(await listReports('open'));
      else renderPhotos(await listUnverifiedPhotos());
    } catch (err) {
      body.innerHTML = `<div class="feed-empty">Couldn’t load: ${escapeHtml((err as Error).message)}</div>`;
    }
  };

  tabs.forEach((b) =>
    b.addEventListener('click', () => {
      tab = b.dataset.tab as 'reports' | 'photos';
      tabs.forEach((x) => x.classList.toggle('active', x === b));
      void load();
    }),
  );

  await load();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
