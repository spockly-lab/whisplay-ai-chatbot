export interface IdlePageContent {
  /** Bare emoji codepoints (no U+FE0F); the renderer loads one SVG per char. */
  emoji: string;
  text: string;
}

export interface IdlePageContext {
  /** Ask the carousel to re-render this page now if it is on screen. */
  requestRedraw(): void;
}

/**
 * One page of the idle screen carousel. To add a page, create a file in
 * ./pages that exports an IdlePage and register it in ./pages/index.ts.
 */
export interface IdlePage {
  name: string;
  /** Called when the idle screen starts (e.g. to begin background fetches). */
  activate?(ctx: IdlePageContext): void;
  /** Called when the idle screen ends. */
  deactivate?(): void;
  /** Content to show, or null to skip this page in the rotation. */
  render(): Promise<IdlePageContent | null>;
  /** If set, the page is re-rendered after this many ms while on screen. */
  nextUpdateMs?(): number;
}
