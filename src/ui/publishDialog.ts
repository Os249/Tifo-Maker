/**
 * Publish dialog.
 *
 * This used to be the save dialog, and that was the problem: tags, a
 * description, a template flag and a remix permission were demanded before
 * anything was kept, from people who had only asked to not lose their work. Of
 * ten who opened it, seven abandoned inside it.
 *
 * Saving is now a single action that always succeeds. This dialog handles the
 * separate, deliberate act of putting a design in front of other people — and
 * that is the one moment where the metadata genuinely earns its place, because
 * it decides how the design is found and whether it can be remixed.
 *
 * Everything here is optional. The primary button works with the form untouched.
 */

import { t } from './i18n';

export interface PublishChoice {
  /**
   * What the tifo is called in public. Prefilled from the editor title and
   * never blocking, but it does not stay "Untitled tifo": the name becomes the
   * page title of the only URL other people will ever see, and three of the
   * first five published designs were called Untitled.
   */
  title: string;
  tags: string[];
  isTemplate: boolean;
  description: string | null;
  allowRemix: boolean;
}

export function openPublishDialog(opts: {
  title: string;
  currentlyPublic: boolean;
}): Promise<PublishChoice | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'save-backdrop';
    backdrop.innerHTML = `
      <div class="save-modal" role="dialog" aria-modal="true" aria-label="${t('publish.aria')}">
        <button class="save-close" aria-label="${t('common.close')}">&times;</button>
        <h3 class="save-h3">${opts.currentlyPublic ? t('publish.updateH') : t('publish.h')}</h3>
        <p class="save-lead">${t('publish.lead')}</p>

        <div class="save-tags-row">
          <label class="save-tags-label" for="pub-title">${t('publish.title')}</label>
          <input type="text" id="pub-title" class="save-tags-input" maxlength="80"
                 placeholder="${t('publish.titlePh')}" value="${escapeHtml(opts.title)}" />
          <div class="save-tags-hint">${t('publish.titleHint')}</div>

          <label class="save-tags-label" for="pub-tags" style="margin-top:12px;">${t('publish.tags')}
            <span class="pub-optional">${t('common.optional')}</span>
          </label>
          <input type="text" id="pub-tags" class="save-tags-input" placeholder="${t('publish.tagsPh')}" />
          <div class="save-tags-hint">${t('publish.tagsHint')}</div>

          <label class="save-tags-label" for="pub-desc" style="margin-top:12px;">${t('publish.desc')}
            <span class="pub-optional">${t('common.optional')}</span>
          </label>
          <textarea id="pub-desc" class="save-tags-input" rows="3"
                    placeholder="${t('publish.descPh')}"
                    style="resize:vertical;font-family:inherit;"></textarea>

          <label class="save-template-row"><input type="checkbox" id="pub-remix" checked /> ${t('publish.allowRemix')}</label>
          <label class="save-template-row"><input type="checkbox" id="pub-template" /> ${t('publish.asTemplate')}</label>
        </div>

        <div class="pub-actions">
          <button class="pub-cancel" type="button">${t('common.cancel')}</button>
          <button class="primary pub-go" type="button">${opts.currentlyPublic ? t('publish.updateCta') : t('publish.cta')}</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);

    const close = (result: PublishChoice | null): void => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close(null);
    };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close(null);
    });
    backdrop.querySelector('.save-close')!.addEventListener('click', () => close(null));
    backdrop.querySelector('.pub-cancel')!.addEventListener('click', () => close(null));

    backdrop.querySelector('.pub-go')!.addEventListener('click', () => {
      const raw = (backdrop.querySelector('#pub-tags') as HTMLInputElement | null)?.value ?? '';
      const desc = (backdrop.querySelector('#pub-desc') as HTMLTextAreaElement | null)?.value.trim() ?? '';
      const typed = (backdrop.querySelector('#pub-title') as HTMLInputElement | null)?.value.trim() ?? '';
      close({
        // Falling back to the editor title keeps this non-blocking: an empty
        // field publishes what Save already had rather than refusing.
        title: (typed || opts.title).slice(0, 80),
        tags: raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 12),
        isTemplate: (backdrop.querySelector('#pub-template') as HTMLInputElement | null)?.checked ?? false,
        description: desc ? desc.slice(0, 2000) : null,
        allowRemix: (backdrop.querySelector('#pub-remix') as HTMLInputElement | null)?.checked ?? true,
      });
    });

    setTimeout(() => {
      const el = backdrop.querySelector('#pub-title') as HTMLInputElement | null;
      el?.focus();
      // Select a placeholder name so typing replaces it; leave a real one alone.
      if (el && /^untitled/i.test(el.value)) el.select();
    }, 0);
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}
