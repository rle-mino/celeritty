/** The data contract: what a host must supply, and what it gets told about. */

// GridSize is NOT redeclared here — it already exists in the renderer and is
// already part of the package surface. A second declaration would collide in
// src/index.ts and both would be dropped.
import type { GridSize } from "../renderer/grid-metrics";

/**
 * Terminal colors. The sixteen ANSI slots plus the three defaults, each a CSS
 * color string. Slot order follows `vte::ansi::NamedColor`: 0-7 normal, 8-15
 * bright, then foreground, background, cursor.
 */
export interface TerminalPalette {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
  foreground: string;
  background: string;
  cursor: string;
}

export interface TerminalFont {
  family: string;
  size: number;
  weight?: string;
  lineHeight?: number;
}

export interface TerminalCursor {
  /**
   * NOT YET HONORED. The WebGPU renderer draws a single cursor shape.
   * The field exists because the configuration crate resolves it and the
   * shared fixtures assert it — dropping it here would desynchronize the two
   * halves of the contract. See the repository followups.
   */
  style: "block" | "beam" | "underline";
  /** NOT YET HONORED — the renderer does not blink. Same reasoning as `style`. */
  blink: boolean;
}

/**
 * Resolved appearance and history configuration, plus optional browser input
 * settings. The host decides which configuration source wins and applies
 * overrides; omitted scrollSensitivity uses the browser default of 1.
 */
export interface TerminalOptions {
  font: TerminalFont;
  colors: TerminalPalette;
  cursor: TerminalCursor;
  /** Lines of history kept above the live screen. */
  scrollback: number;
  /**
   * Local wheel scroll multiplier, default 1. Finite and >= 0; 0 disables
   * local wheel scrolling and allows host-page scrolling outside application
   * mouse and alternate-screen modes. Does not scale application mouse reports or
   * alternate-screen arrow keys. Pixels use the rendered CSS cell height,
   * lines map directly, and pages use the number of visible grid rows.
   */
  scrollSensitivity?: number;
}

export interface CellPoint {
  line: number;
  column: number;
}

/** Modifier keys held when a link was activated. */
export interface LinkModifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

/**
 * A link the user activated. The component never opens it — routing is
 * product policy (internal versus external domains, a native context menu,
 * a session cookie), and belongs to whoever embeds the terminal.
 */
export interface LinkActivation {
  url: string;
  modifiers: LinkModifiers;
}

/**
 * Events a terminal emits. There is deliberately no `bell` and no `title`:
 * the wasm façade exposes neither, and declaring an event that never fires
 * would be a lie in the type.
 */
export interface TerminalEventMap {
  /** Bytes headed for the PTY, already encoded. */
  data: Uint8Array;
  resize: GridSize;
  /** The selected text, or `null` when the selection was cleared. */
  "selection-change": string | null;
  /**
   * The user activated a link. Nothing has been opened; the host decides
   * whether and how.
   */
  "link-activate": LinkActivation;
  /**
   * The URL under the pointer, or `null` when it left the last one. A host
   * driving a native (out-of-process) context menu needs this pushed as it
   * changes — polling `getSelection()`-style has no equivalent for "what's
   * under the cursor right now" between events.
   */
  "link-hover": string | null;
  /**
   * A runtime failure the host must surface. Programming errors — calling a
   * method after `dispose`, passing malformed options — throw synchronously
   * instead.
   */
  error: Error;
  /** A non-fatal renderer diagnostic; the engine and session remain alive. */
  diagnostic: Error;
}

export type TerminalEvent = keyof TerminalEventMap;
