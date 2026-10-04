// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Renderer, RendererFactory } from "../renderer/renderer-interface";

const wasm = vi.hoisted(() => ({
  free: vi.fn(),
  feed: vi.fn(),
  flushSync: vi.fn(() => false),
  takeOutput: vi.fn(() => new Uint8Array()),
  pending: false,
  mouseReporting: 0,
  routingReads: vi.fn(),
  memory: new ArrayBuffer(80 * 24 * 4 * Uint32Array.BYTES_PER_ELEMENT),
}));

vi.mock("./wasm", () => ({
  EngineTerminal: class {
    readonly columns = 80;
    readonly screenLines = 24;
    readonly displayOffset = 0;
    readonly applicationCursor = false;
    readonly maxScroll = 100;
    get mouseReporting(): number {
      wasm.routingReads();
      return wasm.mouseReporting;
    }
    readonly sgrMouse = false;
    readonly alternateScroll = false;
    readonly altScreen = false;

    setScrollbackLines(): void {}
    get syncPending(): boolean {
      return wasm.pending;
    }
    feed = wasm.feed;
    flushSync = wasm.flushSync;
    takeOutput = wasm.takeOutput;
    refreshSnapshot(): void {}
    snapshotPtr(): number {
      return 0;
    }
    snapshotLen(): number {
      return 80 * 24 * 4;
    }
    resize(): void {}
    resetScroll(): void {}
    free = wasm.free;
  },
  encodeKey: vi.fn(),
  engineMemory: () => wasm.memory,
  loadEngine: () => Promise.resolve(),
}));

import { Terminal } from "./terminal";

const OPTIONS = {
  font: { family: "monospace", size: 13 },
  colors: {
    black: "#000000",
    red: "#000000",
    green: "#000000",
    yellow: "#000000",
    blue: "#000000",
    magenta: "#000000",
    cyan: "#000000",
    white: "#000000",
    brightBlack: "#000000",
    brightRed: "#000000",
    brightGreen: "#000000",
    brightYellow: "#000000",
    brightBlue: "#000000",
    brightMagenta: "#000000",
    brightCyan: "#000000",
    brightWhite: "#000000",
    foreground: "#ffffff",
    background: "#000000",
    cursor: "#ffffff",
  },
  cursor: { style: "block" as const, blink: false },
  scrollback: 1_000,
};

function createRenderer(render: Renderer["render"] = vi.fn()) {
  return {
    setPalette: vi.fn(),
    setAtlas: vi.fn(),
    render,
    dispose: vi.fn(),
  } satisfies Renderer;
}

describe("Terminal lifecycle", () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;

  beforeEach(() => {
    wasm.free.mockClear();
    wasm.feed.mockReset();
    wasm.flushSync.mockReset().mockReturnValue(false);
    wasm.takeOutput.mockReset().mockReturnValue(new Uint8Array());
    wasm.pending = false;
    wasm.mouseReporting = 0;
    wasm.routingReads.mockClear();
    document.body.replaceChildren();
    frames = new Map();
    nextFrame = 1;
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        width: number;
        height: number;
        constructor(width: number, height: number) {
          this.width = width;
          this.height = height;
        }
        getContext() {
          return {
            beginPath: vi.fn(),
            clip: vi.fn(),
            drawImage: vi.fn(),
            fillText: vi.fn(),
            measureText: () => ({ width: 8 }),
            rect: vi.fn(),
            restore: vi.fn(),
            save: vi.fn(),
          };
        }
      },
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames.delete(id);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function runFrame() {
    const [id, frame] = [...frames.entries()][0];
    frames.delete(id);
    frame(0);
  }

  it.each([-1, NaN, Infinity, -Infinity, null, "0.5"])(
    "rejects invalid sensitivity %s before touching the host",
    (value) => {
      const host = document.createElement("div");
      expect(() => new Terminal(host, { ...OPTIONS, scrollSensitivity: value as number })).toThrow(
        RangeError,
      );
      expect(host.children).toHaveLength(0);
      expect(host.hasAttribute("tabindex")).toBe(false);
    },
  );

  it("validates option updates before applying any part of the patch", async () => {
    const renderer = createRenderer();
    const terminal = new Terminal(document.createElement("div"), OPTIONS, async () => renderer);
    await terminal.ready;
    renderer.setPalette.mockClear();
    expect(() => terminal.setOptions({ colors: OPTIONS.colors, scrollSensitivity: -1 })).toThrow(
      RangeError,
    );
    expect(renderer.setPalette).not.toHaveBeenCalled();
    for (const value of [0, 0.5, 1, 2, undefined]) {
      expect(() => terminal.setOptions({ scrollSensitivity: value })).not.toThrow();
    }
    terminal.dispose();
    expect(() => terminal.setOptions({ scrollSensitivity: 1 })).not.toThrow();
    expect(() =>
      terminal.setOptions({ scrollSensitivity: -1, colors: OPTIONS.colors }),
    ).not.toThrow();
    expect(renderer.setPalette).not.toHaveBeenCalled();
  });

  it("reads output routing only while a wheel fraction is pending, including sync flushes", async () => {
    const host = document.createElement("div");
    const terminal = new Terminal(host, OPTIONS, async () => createRenderer());
    await terminal.ready;
    for (let i = 0; i < 10; i++) terminal.feed(new Uint8Array());
    expect(wasm.routingReads).not.toHaveBeenCalled();

    host.dispatchEvent(new WheelEvent("wheel", { deltaY: -0.5, deltaMode: 1 }));
    wasm.routingReads.mockClear();
    terminal.feed(new Uint8Array());
    expect(wasm.routingReads).toHaveBeenCalledTimes(1);
    wasm.pending = true;
    terminal.feed(new Uint8Array());
    wasm.flushSync.mockImplementationOnce(() => {
      wasm.pending = false;
      return true;
    });
    runFrame();
    expect(wasm.routingReads).toHaveBeenCalledTimes(3);
    wasm.mouseReporting = 1;
    terminal.feed(new Uint8Array());
    expect(wasm.routingReads).toHaveBeenCalledTimes(4);
    for (let i = 0; i < 10; i++) terminal.feed(new Uint8Array());
    expect(wasm.routingReads).toHaveBeenCalledTimes(4);
    terminal.dispose();
  });

  it("polls only pending batches and stops after expiry or an explicit end", async () => {
    const terminal = new Terminal(document.createElement("div"), OPTIONS, async () =>
      createRenderer(),
    );
    await terminal.ready;
    for (let i = 0; i < 10; i++) runFrame();
    terminal.feed(new Uint8Array());
    runFrame();
    expect(wasm.flushSync).not.toHaveBeenCalled();
    wasm.pending = true;
    terminal.feed(new Uint8Array());
    runFrame();
    expect(wasm.flushSync).toHaveBeenCalledOnce();
    wasm.flushSync.mockImplementationOnce(() => {
      wasm.pending = false;
      return true;
    });
    runFrame();
    for (let i = 0; i < 10; i++) runFrame();
    expect(wasm.flushSync).toHaveBeenCalledTimes(2);
    wasm.pending = true;
    terminal.feed(new Uint8Array());
    wasm.pending = false;
    terminal.feed(new Uint8Array());
    runFrame();
    expect(wasm.flushSync).toHaveBeenCalledTimes(2);
    terminal.dispose();
  });

  it("renders timeout output without misclassifying a throwing host listener", async () => {
    const renderer = createRenderer();
    const terminal = new Terminal(document.createElement("div"), OPTIONS, async () => renderer);
    await terminal.ready;
    const errors = vi.fn();
    terminal.on("error", errors);
    wasm.pending = true;
    terminal.feed(new Uint8Array());
    wasm.flushSync.mockImplementationOnce(() => {
      wasm.pending = false;
      return true;
    });
    wasm.takeOutput.mockReturnValueOnce(new Uint8Array([65]));
    const failure = new Error("host data callback");
    terminal.on("data", () => {
      throw failure;
    });
    expect(runFrame).toThrow(failure);
    expect(errors).not.toHaveBeenCalled();
    expect(renderer.render).toHaveBeenCalledOnce();
    expect(frames).toHaveLength(1);
    expect(runFrame).not.toThrow();
    terminal.dispose();
  });

  it("does not reschedule when a timeout listener disposes the terminal", async () => {
    const terminal = new Terminal(document.createElement("div"), OPTIONS, async () =>
      createRenderer(),
    );
    await terminal.ready;
    wasm.pending = true;
    terminal.feed(new Uint8Array());
    wasm.flushSync.mockImplementationOnce(() => {
      wasm.pending = false;
      return true;
    });
    wasm.takeOutput.mockReturnValueOnce(new Uint8Array([65]));
    terminal.on("data", () => terminal.dispose());
    runFrame();
    expect(frames).toHaveLength(0);
  });

  it("disposes a renderer that resolves after initialization was cancelled", async () => {
    let resolveRenderer!: (renderer: Renderer) => void;
    const renderer = createRenderer();
    const factory: RendererFactory = () =>
      new Promise((resolve) => {
        resolveRenderer = resolve;
      });
    const host = document.createElement("div");
    const terminal = new Terminal(host, OPTIONS, factory);

    await Promise.resolve();
    terminal.dispose();
    terminal.dispose();
    resolveRenderer(renderer);

    await expect(terminal.ready).rejects.toThrow("after dispose");
    expect(renderer.dispose).toHaveBeenCalledOnce();
    expect(host.querySelector("canvas")).toBeNull();
  });

  it("cleans the host when renderer initialization fails", async () => {
    const host = document.createElement("div");
    const failure = new Error("No WebGPU adapter");
    const terminal = new Terminal(host, OPTIONS, () => Promise.reject(failure));

    await expect(terminal.ready).rejects.toBe(failure);

    expect(host.querySelector("canvas")).toBeNull();
    expect(host.hasAttribute("tabindex")).toBe(false);
    expect(frames).toHaveLength(0);
  });

  it("retains the engine and retries after one failing frame with a recording-only listener", async () => {
    const error = new Error("transient frame failure");
    const render = vi.fn().mockImplementationOnce(() => {
      throw error;
    });
    const renderer = createRenderer(render);
    const host = document.createElement("div");
    const terminal = new Terminal(host, OPTIONS, () => Promise.resolve(renderer));
    await terminal.ready;
    const errors = vi.fn();
    terminal.on("error", errors);
    const runFrame = () => {
      const [id, frame] = [...frames.entries()][0];
      frames.delete(id);
      frame(0);
    };
    runFrame();
    expect(errors).toHaveBeenCalledWith(error);
    expect(wasm.free).not.toHaveBeenCalled();
    expect(renderer.dispose).not.toHaveBeenCalled();
    expect(host.querySelector("canvas")).not.toBeNull();
    expect(frames).toHaveLength(1);
    runFrame();
    expect(render).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenCalledOnce();
    terminal.dispose();
    expect(wasm.free).toHaveBeenCalledOnce();
  });

  it("does not schedule another frame after an error listener disposes it", async () => {
    const renderer = createRenderer(
      vi.fn(() => {
        throw new Error("render failed");
      }),
    );
    const terminal = new Terminal(document.createElement("div"), OPTIONS, () =>
      Promise.resolve(renderer),
    );
    await terminal.ready;
    terminal.on("error", () => terminal.dispose());

    const [id, frame] = [...frames.entries()][0];
    frames.delete(id);
    frame(0);

    expect(frames).toHaveLength(0);
    expect(renderer.dispose).toHaveBeenCalledOnce();
  });
});
