/**
 * Print-panel export (Wave E / #15).
 *
 * Tiles a surface-tifo / banner image into printable A4 pages with cut guides so
 * a large printed surface can be produced on a normal printer and assembled —
 * the production complement to the distribution PDF (which covers the card
 * mosaic). Lib-free and CSP-safe: it opens a window, writes pure HTML + inline
 * CSS (no scripts — allowed by style-src 'unsafe-inline'; the image is a data
 * URL, allowed by img-src data:), then the opener calls print().
 */

export function printAssetPanels(imageUrl: string, widthM: number, heightM: number, panelM = 2.5): boolean {
  const cols = Math.max(1, Math.min(10, Math.ceil(Math.max(0.5, widthM) / panelM)));
  const rows = Math.max(1, Math.min(10, Math.ceil(Math.max(0.5, heightM) / panelM)));
  const w = window.open('', '_blank');
  if (!w) return false;

  let panels = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      panels +=
        '<div class="panel">' +
        '<div class="crop"><img alt="" src="' +
        imageUrl +
        '" style="width:' +
        cols * 100 +
        '%;height:' +
        rows * 100 +
        '%;left:-' +
        c * 100 +
        '%;top:-' +
        r * 100 +
        '%"></div>' +
        '<div class="lbl">Panel row ' +
        (r + 1) +
        ' / col ' +
        (c + 1) +
        '  (' +
        rows +
        ' x ' +
        cols +
        ' panels): full surface ' +
        widthM.toFixed(1) +
        ' x ' +
        heightM.toFixed(1) +
        ' m</div>' +
        '</div>';
    }
  }

  const html =
    '<!doctype html><html><head><meta charset="utf-8"><title>Tifo print panels</title><style>' +
    '@page{size:A4 landscape;margin:6mm;}' +
    'body{margin:0;font-family:system-ui,sans-serif;}' +
    '.panel{position:relative;width:100%;height:100vh;page-break-after:always;box-sizing:border-box;overflow:hidden;border:1px dashed #888;}' +
    '.crop{position:absolute;inset:0;overflow:hidden;}' +
    '.crop img{position:absolute;image-rendering:auto;}' +
    '.lbl{position:absolute;left:6px;bottom:6px;background:#fff;color:#000;padding:3px 7px;font-size:11px;border:1px solid #000;}' +
    '</style></head><body>' +
    panels +
    '</body></html>';

  w.document.open();
  w.document.write(html);
  w.document.close();
  // Give the image a beat to decode before invoking the print dialog.
  setTimeout(() => {
    try {
      w.focus();
      w.print();
    } catch {
      /* user can Ctrl/Cmd+P manually */
    }
  }, 500);
  return true;
}
