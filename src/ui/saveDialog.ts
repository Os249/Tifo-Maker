/**
 * Save dialog. Guides the user between three intents instead of one ambiguous
 * Save button:
 *   • Save to your account — keeps it private, tied to the user.
 *   • Publish to the community — saves and lists it in the public feed.
 *   • Download a copy — a local .tifo file, no account needed.
 * "Save as a new copy" is offered when editing an existing design, so the
 * original isn't overwritten.
 *
 * The dialog only collects intent; the caller performs the actual save so all
 * the store/map/network wiring stays in one place.
 */

export type SaveChoice =
  | { kind: 'account'; makePublic: boolean; asNew: boolean; tags: string[]; isTemplate: boolean; description: string | null; allowRemix: boolean }
  | { kind: 'download' };

export function openSaveDialog(opts: {
  isExisting: boolean; // editing a saved design (enables "save as new copy")
  isSignedIn: boolean;
  currentlyPublic: boolean;
}): Promise<SaveChoice | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'save-backdrop';
    backdrop.innerHTML = `
      <div class="save-modal" role="dialog" aria-modal="true" aria-label="Save your tifo">
        <button class="save-close" aria-label="Close">&times;</button>
        <h3 class="save-h3">Save your tifo</h3>
        <p class="save-lead">Where should this go?</p>
        <div class="save-options">
          <button class="save-option" data-act="private">
            <i class="ti ti-lock"></i>
            <span class="save-opt-title">Save to your account</span>
            <span class="save-opt-sub">Private — only you can see it. ${opts.isSignedIn ? '' : 'Sign in required.'}</span>
          </button>
          <button class="save-option" data-act="public">
            <i class="ti ti-world"></i>
            <span class="save-opt-title">Publish to the community</span>
            <span class="save-opt-sub">Saves and lists it in the public feed for others to see and remix.</span>
          </button>
          <button class="save-option" data-act="download">
            <i class="ti ti-download"></i>
            <span class="save-opt-title">Download a copy</span>
            <span class="save-opt-sub">A .tifo file on your device. No account needed.</span>
          </button>
        </div>
        <div class="save-tags-row">
          <label class="save-tags-label" for="save-tags">Tags <span style="color:var(--text-3);font-weight:400;">(used when publishing)</span></label>
          <input type="text" id="save-tags" class="save-tags-input" placeholder="e.g. serie-a, derby, black-gold" />
          <div class="save-tags-hint">Comma-separated. Helps others find your tifo in the feed.</div>
          <label class="save-tags-label" for="save-desc" style="margin-top:12px;">Creator's explanation <span style="color:var(--text-3);font-weight:400;">(shown with the 3D preview)</span></label>
          <textarea id="save-desc" class="save-tags-input" rows="3" placeholder="The backstory, the match, what the display means…" style="resize:vertical;font-family:inherit;"></textarea>
          <label class="save-template-row"><input type="checkbox" id="save-template" /> Offer this as a remixable template</label>
          <label class="save-template-row"><input type="checkbox" id="save-allow-remix" checked /> Allow others to remix this tifo</label>
        </div>
        ${
          opts.isExisting
            ? `<label class="save-asnew"><input type="checkbox" id="save-asnew" /> Save as a new copy (don’t overwrite the original)</label>`
            : ''
        }
      </div>
    `;
    document.body.appendChild(backdrop);

    const close = (result: SaveChoice | null): void => {
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

    const asNew = (): boolean =>
      (backdrop.querySelector('#save-asnew') as HTMLInputElement | null)?.checked ?? false;
    const tagsOf = (): string[] => {
      const raw = (backdrop.querySelector('#save-tags') as HTMLInputElement | null)?.value ?? '';
      return raw.split(',').map((t) => t.trim()).filter(Boolean);
    };
    const isTemplateOf = (): boolean =>
      (backdrop.querySelector('#save-template') as HTMLInputElement | null)?.checked ?? false;
    const descOf = (): string | null => {
      const raw = (backdrop.querySelector('#save-desc') as HTMLTextAreaElement | null)?.value.trim() ?? '';
      return raw ? raw.slice(0, 2000) : null;
    };
    const allowRemixOf = (): boolean =>
      (backdrop.querySelector('#save-allow-remix') as HTMLInputElement | null)?.checked ?? true;

    backdrop.querySelectorAll('.save-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = (btn as HTMLElement).dataset.act;
        if (act === 'download') close({ kind: 'download' });
        else if (act === 'public')
          close({ kind: 'account', makePublic: true, asNew: asNew(), tags: tagsOf(), isTemplate: isTemplateOf(), description: descOf(), allowRemix: allowRemixOf() });
        else close({ kind: 'account', makePublic: false, asNew: asNew(), tags: tagsOf(), isTemplate: isTemplateOf(), description: descOf(), allowRemix: allowRemixOf() });
      });
    });
  });
}
