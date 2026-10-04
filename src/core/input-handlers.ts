/**
 * Input handlers extracted from the Terminal class to keep the class under
 * the 400-line budget.
 *
 * Each handler receives the state it needs as explicit parameters rather
 * than closing over `this`. That makes them pure functions that can be
 * tested in isolation.
 */

import { clampCellPoint } from "./selection-bounds";
import type { GridSize } from "../renderer/grid-metrics";
import type { CellPoint } from "./types";
import { MOUSE_SCROLL_UP, MOUSE_SCROLL_DOWN, pointerTarget } from "./pointer";
import type { WheelScroll } from "./wheel-scroll";
import { findLinkAtColumn } from "./link-detection";
import { EngineTerminal, encodeMouse } from "./wasm";

/** State passed to input handlers. */
export interface InputHandlerState {
  engine: { applicationCursor: boolean; resetScroll: () => void } | undefined;
  emit: (event: string, payload: unknown) => void;
  clearSelection: () => void;
  cellAt: (event: MouseEvent) => CellPoint | null;
  sendPointer: (kind: number, button: number, event: MouseEvent | WheelEvent) => boolean;
  dragging: boolean;
  setDragging: (v: boolean) => void;
  selectionStart: CellPoint | null;
  setSelectionStart: (v: CellPoint | null) => void;
  selectionEnd: CellPoint | null;
  setSelectionEnd: (v: CellPoint | null) => void;
  dirty: boolean;
  setDirty: (v: boolean) => void;
  host: { focus: () => void };
  linkAt: (event: MouseEvent) => string | null | undefined;
}

/**
 * Send pointer events to the wasm engine. Returns `true` when handled.
 *
 * `emitData` carries the encoded sequence out the same way keystrokes leave,
 * via the `data` event. Without it the bytes are computed and dropped, so a
 * program that asked for mouse reporting (Neovim, a pager, anything using the
 * alternate screen) never hears about the pointer at all.
 */
export function sendPointerToEngine(
  engine: InstanceType<typeof EngineTerminal>,
  atlas: { cell: { width: number; height: number } } | undefined,
  hostBounds: () => DOMRect,
  dpr: number,
  kind: number,
  button: number,
  event: MouseEvent | WheelEvent,
  emitData: (bytes: Uint8Array) => void,
): boolean {
  // Alternate-scroll arrows need no coordinates when SGR reporting is unavailable.
  const alternateWheel =
    (engine.mouseReporting === 0 || !engine.sgrMouse) &&
    engine.altScreen &&
    engine.alternateScroll &&
    (kind === MOUSE_SCROLL_UP || kind === MOUSE_SCROLL_DOWN);
  const target = alternateWheel
    ? { line: 0, column: 0 }
    : pointerTarget(engine, hostBounds, atlas!.cell, dpr, event);
  if (target === null) return false;

  const bytes = encodeMouse(
    kind,
    button,
    target.line,
    target.column,
    event.ctrlKey,
    event.altKey,
    event.shiftKey,
    engine.sgrMouse,
    engine.mouseReporting,
    engine.alternateScroll,
    engine.altScreen,
    engine.applicationCursor,
  );
  if (bytes === undefined) return false;

  event.preventDefault();
  emitData(bytes);
  return true;
}

/** Compute a cell position from a mouse event. */
export function computeCellPoint(
  atlas: { cell: { width: number; height: number } },
  hostBounds: () => DOMRect,
  event: MouseEvent,
  grid: GridSize,
  intent: "selection" | "link" = "selection",
): CellPoint | null {
  const bounds = hostBounds();
  const dpr = window.devicePixelRatio;
  const point = {
    column: Math.floor(((event.clientX - bounds.left) * dpr) / atlas.cell.width),
    line: Math.floor(((event.clientY - bounds.top) * dpr) / atlas.cell.height),
  };
  // Selection drags extend to the nearest edge. Link hit testing must not
  // activate the last cell's link from outside the grid.
  if (
    intent === "link" &&
    (point.column < 0 || point.line < 0 || point.column >= grid.columns || point.line >= grid.lines)
  )
    return null;
  return clampCellPoint(point, grid);
}

/** Get the URL under a pointer position, or `null`. */
export function resolveLinkUrl(
  engine: InstanceType<typeof EngineTerminal>,
  cell: CellPoint,
): string | null {
  const row = engine.rowText(cell.line);
  return findLinkAtColumn(row, cell.column)?.url ?? null;
}

export function handleKeyDown(
  state: InputHandlerState,
  event: KeyboardEvent,
  encodeKeyFn: (
    key: string,
    ctrl: boolean,
    alt: boolean,
    shift: boolean,
    meta: boolean,
    applicationCursor: boolean,
  ) => Uint8Array | undefined,
): boolean {
  const engine = state.engine;
  if (engine === undefined) return false;

  const bytes = encodeKeyFn(
    event.key,
    event.ctrlKey,
    event.altKey,
    event.shiftKey,
    event.metaKey,
    engine.applicationCursor,
  );
  if (bytes === undefined) return false;
  event.preventDefault();
  state.clearSelection();
  engine.resetScroll();
  state.setDirty(true);
  state.emit("data", bytes);
  return true;
}

export function handleMouseDown(
  state: InputHandlerState,
  event: MouseEvent,
  toEncoderButton: (domButton: number) => number,
  MOUSE_PRESS: number,
): void {
  state.host.focus();
  if (state.sendPointer(MOUSE_PRESS, toEncoderButton(event.button), event)) return;
  if (event.button !== 0) return;
  state.setDragging(true);
  const cell = state.cellAt(event);
  state.setSelectionStart(cell);
  state.setSelectionEnd(cell);
  state.setDirty(true);
}

export function handleMouseMove(
  state: InputHandlerState,
  event: MouseEvent,
  MOUSE_MOVE: number,
  setHoverCursor: (url: string | null) => void,
  linkAt: (event: MouseEvent) => string | null,
  previousLink: { current: string | null },
): void {
  if (state.dragging) {
    const cell = state.cellAt(event);
    state.setSelectionEnd(cell);
    state.setDirty(true);
    return;
  }
  if (state.sendPointer(MOUSE_MOVE, event.buttons === 0 ? 0 : 1, event)) return;

  const url = linkAt(event);
  if (url === previousLink.current) return;
  previousLink.current = url;
  setHoverCursor(url);
}

export function handleMouseUp(
  state: InputHandlerState,
  event: MouseEvent,
  toEncoderButton: (domButton: number) => number,
  MOUSE_RELEASE: number,
  getSelection: () => string | null,
): void {
  if (state.dragging) {
    state.setDragging(false);
    const start = state.selectionStart;
    const end = state.cellAt(event);
    state.setSelectionEnd(end);
    state.setDirty(true);

    const moved =
      start === null || end === null || start.line !== end.line || start.column !== end.column;

    if (!moved) {
      const linkUrl = state.linkAt?.(event);
      if (linkUrl !== undefined && linkUrl !== null) {
        state.clearSelection();
        state.emit("link-activate", {
          url: linkUrl,
          modifiers: {
            ctrl: event.ctrlKey,
            alt: event.altKey,
            shift: event.shiftKey,
            meta: event.metaKey,
          },
        });
        return;
      }
    }

    state.emit("selection-change", getSelection());
    return;
  }
  state.sendPointer(MOUSE_RELEASE, toEncoderButton(event.button), event);
}

export function handleWheel(
  state: Pick<InputHandlerState, "sendPointer"> & {
    engine: InstanceType<typeof EngineTerminal>;
    wheel: WheelScroll;
    cellHeight: number;
    pageLines: number;
    sensitivity: number;
  },
  event: WheelEvent,
  MOUSE_SCROLL_UP: number,
  MOUSE_SCROLL_DOWN: number,
  scrollLines: (delta: number) => void,
): void {
  // Read deltaMode first: browsers may choose delta units when it is accessed.
  const mode = event.deltaMode;
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
  const up = event.deltaY < 0;
  state.wheel.syncRouting(state.engine);
  if (state.sendPointer(up ? MOUSE_SCROLL_UP : MOUSE_SCROLL_DOWN, 0, event)) {
    state.wheel.reset();
    return;
  }
  // Reporting may use an unsupported encoding; it must not fall through to
  // local history. The alternate screen likewise never scrolls main history.
  if (state.engine.mouseReporting !== 0 || state.engine.altScreen) {
    event.preventDefault();
    state.wheel.reset();
    return;
  }
  if (state.sensitivity === 0) {
    state.wheel.reset();
    return;
  }
  event.preventDefault();
  const delta = state.wheel.lines(
    { deltaMode: mode, deltaY: event.deltaY },
    state.cellHeight,
    state.pageLines,
    state.sensitivity,
    state.engine.displayOffset,
    state.engine.maxScroll,
  );
  if (delta !== 0) scrollLines(delta);
}
