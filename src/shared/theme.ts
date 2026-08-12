/**
 * Theming hook for design-owned styles.
 *
 * The panel and the overlay layer live inside shadow roots, so a normal
 * stylesheet cannot reach them. Rather than making the design owner edit
 * panel.ts to change a colour, each shadow root optionally adopts a stylesheet
 * from src/styles/ at construction time:
 *
 *     src/styles/panel.css     -> the floating panel
 *     src/styles/overlay.css   -> highlights and outlines
 *
 * Neither file has to exist. When absent, the component's own built-in styles
 * stand alone and nothing logs an error.
 *
 * Overrides are ADOPTED AFTER the built-in styles, so plain selectors win on
 * equal specificity. In practice the easiest thing to override is the custom
 * properties on :host - --lucid-bg, --lucid-fg, --lucid-accent, --lucid-border,
 * --lucid-radius, --lucid-shadow, --lucid-font-size - which is why they exist.
 *
 * Anything under src/styles/ belongs to the design owner. Components should
 * keep only the structural CSS they need to function.
 */

import { createLogger } from './logger.js';

const log = createLogger('theme');

/**
 * Adopt `styles/<name>` into a shadow root if the file shipped in this build.
 *
 * Fire-and-forget: styling arriving a frame late is invisible, and blocking
 * the panel's construction on a fetch would not be.
 */
export function adoptExternalStyles(root: ShadowRoot, name: string): void {
  // Constructable stylesheets are Chrome 73+; the manifest floor is 116.
  if (typeof CSSStyleSheet === 'undefined' || !('replace' in CSSStyleSheet.prototype)) return;

  const url = chrome.runtime.getURL(`styles/${name}`);

  void fetch(url)
    .then(async (response) => {
      if (!response.ok) return; // no override shipped
      const css = await response.text();
      if (!css.trim()) return;

      const sheet = new CSSStyleSheet();
      await sheet.replace(css);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      log.debug(`adopted styles/${name}`);
    })
    .catch(() => {
      // Missing file is the normal case, not an error worth reporting.
    });
}
