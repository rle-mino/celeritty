import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EngineTerminal, loadEngine } from "./wasm";
import { handleWheel, sendPointerToEngine } from "./input-handlers";
import { MOUSE_SCROLL_UP, MOUSE_SCROLL_DOWN } from "./pointer";
import { scrollSensitivity, WheelScroll } from "./wheel-scroll";

beforeAll(async () => {
  await loadEngine(readFileSync(new URL("../wasm/celeritty_bg.wasm", import.meta.url)));
});
const engines: InstanceType<typeof EngineTerminal>[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.free();
});

function setup() {
  const engine = new EngineTerminal(20, 10);
  engines.push(engine);
  engine.feed(
    new TextEncoder().encode(Array.from({ length: 110 }, (_, i) => `ROW_${i}`).join("\r\n")),
  );
  const wheel = new WheelScroll();
  const measure = vi.fn(() => ({ left: 0, top: 0 }) as DOMRect);
  const emit = vi.fn();
  const scroll = vi.fn((delta: number) => engine.scrollLines(delta));
  const state = {
    engine,
    wheel,
    cellHeight: 20,
    pageLines: 10,
    sensitivity: scrollSensitivity(undefined),
    sendPointer: (kind: number, button: number, event: MouseEvent | WheelEvent) =>
      sendPointerToEngine(
        engine,
        { cell: { width: 10, height: 20 } },
        measure,
        1,
        kind,
        button,
        event,
        emit,
      ),
  };
  const dispatch = (deltaY: number, deltaMode = 0, deltaX = 0) => {
    const event = {
      deltaY,
      deltaMode,
      deltaX,
      clientX: 5,
      clientY: 5,
      preventDefault: vi.fn(),
    } as unknown as WheelEvent;
    handleWheel(state, event, MOUSE_SCROLL_UP, MOUSE_SCROLL_DOWN, scroll);
    return event;
  };
  const feed = (text: string) => {
    engine.feed(new TextEncoder().encode(text));
    wheel.syncRouting(engine);
  };
  return { engine, state, wheel, measure, emit, scroll, dispatch, feed };
}

describe("wheel conversion with real WASM scroll offsets", () => {
  it("accumulates small pixel gestures and scales larger ones by amplitude", () => {
    const q = setup();
    for (let i = 0; i < 199; i++) q.dispatch(-0.1);
    expect(q.engine.displayOffset).toBe(0);
    q.dispatch(-0.1);
    expect(q.engine.displayOffset).toBe(1);
    q.dispatch(-100);
    expect(q.engine.displayOffset).toBe(6);
    q.dispatch(40);
    expect(q.engine.displayOffset).toBe(4);
    expect(q.measure).not.toHaveBeenCalled();
    expect(q.emit).not.toHaveBeenCalled();
  });

  it("converts fractional lines and pages, including mixed units", () => {
    const q = setup();
    for (let i = 0; i < 10; i++) q.dispatch(-0.1, 1);
    expect(q.engine.displayOffset).toBe(1);
    q.dispatch(-0.5, 2);
    expect(q.engine.displayOffset).toBe(6);
    q.dispatch(-10);
    q.dispatch(-0.5, 1);
    expect(q.engine.displayOffset).toBe(7);
    q.dispatch(0.3, 2);
    expect(q.engine.displayOffset).toBe(4);
  });

  it("ignores zero, horizontal and invalid vertical events without losing fractions", () => {
    const q = setup();
    q.dispatch(-10);
    for (const value of [0, -0, NaN, Infinity, -Infinity]) {
      expect(q.dispatch(value, 0, 100).preventDefault).not.toHaveBeenCalled();
    }
    q.dispatch(-100, 42);
    expect(q.engine.displayOffset).toBe(0);
    q.dispatch(-10);
    expect(q.engine.displayOffset).toBe(1);
    expect(q.emit).not.toHaveBeenCalled();
  });

  it("discards the old fraction on reversal and never banks overscroll", () => {
    const q = setup();
    q.engine.scrollLines(50);
    q.dispatch(-18);
    q.dispatch(10);
    expect(q.engine.displayOffset).toBe(50);
    q.dispatch(10);
    expect(q.engine.displayOffset).toBe(49);
    q.dispatch(-1e20);
    expect(q.engine.displayOffset).toBe(100);
    q.dispatch(-19);
    q.dispatch(20);
    expect(q.engine.displayOffset).toBe(99);
    q.dispatch(1e20);
    q.dispatch(19);
    q.dispatch(-20);
    expect(q.engine.displayOffset).toBe(1);
    q.state.sensitivity = Number.MAX_VALUE;
    q.dispatch(-Number.MAX_VALUE);
    expect(q.engine.displayOffset).toBe(100);
  });

  it("keeps fractions independent across instances and preserves them during output", () => {
    const a = setup();
    const b = setup();
    a.dispatch(-10);
    b.dispatch(-10);
    expect(a.engine.displayOffset).toBe(0);
    expect(b.engine.displayOffset).toBe(0);
    a.feed("more");
    a.dispatch(-10);
    expect(a.engine.displayOffset).toBe(1);
    expect(b.engine.displayOffset).toBe(0);
    b.dispatch(-10);
    expect(b.engine.displayOffset).toBe(1);
  });

  it("scales normalized movement and allows disabling local scrolling", () => {
    const q = setup();
    q.state.sensitivity = 0.5;
    q.dispatch(-20);
    expect(q.engine.displayOffset).toBe(0);
    q.dispatch(-1, 1);
    expect(q.engine.displayOffset).toBe(1);
    q.state.sensitivity = 0;
    expect(q.dispatch(-100, 2).preventDefault).not.toHaveBeenCalled();
    expect(q.engine.displayOffset).toBe(1);
  });

  it("routes SGR once per vertical event, before applying local sensitivity", () => {
    const q = setup();
    q.dispatch(-10);
    q.feed("\x1b[?1000h\x1b[?1006h");
    q.state.sensitivity = 0;
    q.dispatch(-0.1);
    q.dispatch(100);
    q.dispatch(0, 0, 100);
    expect(q.emit.mock.calls.map(([bytes]) => new TextDecoder().decode(bytes))).toEqual([
      "\x1b[<64;1;1M",
      "\x1b[<65;1;1M",
    ]);
    expect(q.engine.displayOffset).toBe(0);
    q.feed("\x1b[?1000l");
    q.state.sensitivity = 1;
    q.dispatch(-10);
    expect(q.engine.displayOffset).toBe(0);
    q.dispatch(-10);
    expect(q.engine.displayOffset).toBe(1);
  });

  it("uses alternate-screen arrows without reporting and prioritizes SGR when enabled", () => {
    const q = setup();
    q.engine.scrollLines(20);
    q.feed("\x1b[?1049h\x1b[?1007h\x1b[?1h");
    q.dispatch(-1);
    q.dispatch(1);
    expect(q.emit.mock.calls.map(([bytes]) => new TextDecoder().decode(bytes))).toEqual([
      "\x1bOA",
      "\x1bOB",
    ]);
    expect(q.measure).not.toHaveBeenCalled();
    q.feed("\x1b[?1000h\x1b[?1006h");
    q.dispatch(1);
    expect(new TextDecoder().decode(q.emit.mock.lastCall![0])).toBe("\x1b[<65;1;1M");
    expect(q.scroll).not.toHaveBeenCalled();
    q.feed("\x1b[?1000l\x1b[?1007l");
    q.dispatch(-100);
    expect(q.emit).toHaveBeenCalledTimes(3);
    expect(q.scroll).not.toHaveBeenCalled();
    q.feed("\x1b[?1049l");
    expect(q.engine.displayOffset).toBe(20);
  });

  it("keeps alternate arrows without SGR despite legacy mouse reporting", () => {
    const q = setup();
    q.feed("\x1b[?1049h\x1b[?1000h\x1b[?1006l\x1b[?1h");
    q.state.sensitivity = 0;
    expect(q.dispatch(-1).preventDefault).toHaveBeenCalled();
    q.dispatch(1);
    q.feed("\x1b[?1l");
    q.dispatch(-1);
    q.dispatch(1);
    expect(q.emit.mock.calls.map(([bytes]) => new TextDecoder().decode(bytes))).toEqual([
      "\x1bOA",
      "\x1bOB",
      "\x1b[A",
      "\x1b[B",
    ]);
    expect(q.measure).not.toHaveBeenCalled();
    expect(q.scroll).not.toHaveBeenCalled();
    q.feed("\x1b[?1007l");
    q.dispatch(1);
    expect(q.emit).toHaveBeenCalledTimes(4);
  });

  it("does not locally scroll when reporting uses an unsupported encoding", () => {
    const q = setup();
    q.feed("\x1b[?1000h\x1b[?1006l");
    q.dispatch(-100);
    expect(q.scroll).not.toHaveBeenCalled();
    expect(q.emit).not.toHaveBeenCalled();
  });
});
