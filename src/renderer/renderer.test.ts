// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AtlasTexture } from "./renderer-interface";
import { TerminalRenderer } from "./renderer";

const ATLAS = {
  cell: { width: 8, height: 16 },
  glyph: vi.fn(),
  isFull: false,
  isDirty: false,
  markUploaded: vi.fn(),
  reset: vi.fn(),
  source: {} as OffscreenCanvas,
} satisfies AtlasTexture;

function installGpu(device: object) {
  vi.stubGlobal("navigator", {
    gpu: {
      getPreferredCanvasFormat: () => "bgra8unorm",
      requestAdapter: async () => ({ requestDevice: async () => device }),
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TerminalRenderer lifecycle", () => {
  it("destroys an acquired device when canvas context creation fails", async () => {
    const destroy = vi.fn();
    installGpu({ destroy });
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getContext").mockReturnValue(null);

    await expect(TerminalRenderer.create(canvas, ATLAS)).rejects.toThrow(
      "Could not acquire a WebGPU context",
    );

    expect(destroy).toHaveBeenCalledOnce();
  });

  it("unconfigures the context and disposes GPU resources idempotently", async () => {
    const buffers = [{ destroy: vi.fn() }, { destroy: vi.fn() }];
    const context = {
      configure: vi.fn(),
      unconfigure: vi.fn(),
    };
    const device = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      lost: new Promise<GPUDeviceLostInfo>(() => {}),
      createBuffer: vi.fn(() => buffers.shift()!),
      createPipelineLayout: vi.fn(),
      createRenderPipeline: vi.fn(() => ({})),
      createSampler: vi.fn(() => ({})),
      createShaderModule: vi.fn(() => ({})),
      destroy: vi.fn(),
    };
    installGpu(device);
    vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2 });
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getContext").mockReturnValue(context as never);

    const renderer = await TerminalRenderer.create(canvas, ATLAS);
    const allocated = device.createBuffer.mock.results.map(({ value }) => value);
    renderer.dispose();
    renderer.dispose();
    expect(() =>
      renderer.render({ columns: 1, lines: 1, packed: new Uint32Array(4) }),
    ).not.toThrow();
    expect(() => renderer.setAtlas(ATLAS)).toThrow("after dispose");
    expect(() => renderer.setPalette(new Map())).toThrow("after dispose");

    expect(context.unconfigure).toHaveBeenCalledOnce();
    expect(allocated[0].destroy).toHaveBeenCalledOnce();
    expect(allocated[1].destroy).toHaveBeenCalledOnce();
    expect(device.destroy).toHaveBeenCalledOnce();
  });
});

async function uploadFixture() {
  const pixels = new Uint8ClampedArray([255, 255, 255, 128]);
  const read = vi.fn(() => ({ data: pixels }));
  const source = {
    width: 1,
    height: 1,
    getContext: () => ({ getImageData: read }),
  } as unknown as OffscreenCanvas;
  let dirty = true;
  const markUploaded = vi.fn(() => {
    dirty = false;
  });
  const atlas = {
    ...ATLAS,
    source,
    markUploaded,
    glyph: () => ({ u0: 0, v0: 0, u1: 1, v1: 1 }),
    get isDirty() {
      return dirty;
    },
  } satisfies AtlasTexture;
  const texture = { destroy: vi.fn(), createView: vi.fn() };
  const queue = {
    copyExternalImageToTexture: vi.fn(),
    writeTexture: vi.fn(),
    writeBuffer: vi.fn(),
    submit: vi.fn(),
  };
  const pass = {
    setPipeline: vi.fn(),
    setBindGroup: vi.fn(),
    setVertexBuffer: vi.fn(),
    draw: vi.fn(),
    end: vi.fn(),
  };
  const device = {
    queue,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    lost: new Promise<GPUDeviceLostInfo>(() => {}),
    createBuffer: () => ({ destroy: vi.fn() }),
    createRenderPipeline: () => ({ getBindGroupLayout: vi.fn() }),
    createSampler: vi.fn(),
    createShaderModule: vi.fn(),
    createTexture: () => texture,
    createBindGroup: vi.fn(),
    createCommandEncoder: () => ({ beginRenderPass: () => pass, finish: vi.fn() }),
    destroy: vi.fn(),
  };
  installGpu(device);
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2, VERTEX: 4 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4 });
  const canvas = document.createElement("canvas");
  vi.spyOn(canvas, "getContext").mockReturnValue({
    canvas,
    configure: vi.fn(),
    unconfigure: vi.fn(),
    getCurrentTexture: () => texture,
  } as never);
  const renderer = await TerminalRenderer.create(canvas, atlas);
  const render = () =>
    renderer.render({
      columns: 1,
      lines: 1,
      packed: new Uint32Array([65, (1 << 24) | 256, (1 << 24) | 257, 0]),
    });
  return {
    renderer,
    render,
    queue,
    read,
    pixels,
    texture,
    atlas,
    markUploaded,
    dirty: () => {
      dirty = true;
    },
  };
}

describe("glyph atlas upload", () => {
  it("keeps the fast image path and never reads back clean frames", async () => {
    const q = await uploadFixture();
    q.render();
    q.render();
    expect(q.queue.copyExternalImageToTexture).toHaveBeenCalledOnce();
    expect(q.read).not.toHaveBeenCalled();
    expect(q.queue.writeTexture).not.toHaveBeenCalled();
    q.renderer.dispose();
  });

  it.each([
    new TypeError("image import failed"),
    new DOMException("image import failed", "OperationError"),
    new Error("image import failed"),
  ])("recovers %s with RGBA across atlas replacement", async (failure) => {
    const q = await uploadFixture();
    q.queue.copyExternalImageToTexture.mockImplementation(() => {
      throw failure;
    });
    q.render();
    expect(q.read).toHaveBeenCalledWith(0, 0, 1, 1);
    expect(q.queue.writeTexture).toHaveBeenCalledWith(
      { texture: q.texture },
      q.pixels,
      { bytesPerRow: 4 },
      [1, 1],
    );
    expect(q.markUploaded).toHaveBeenCalledOnce();
    q.render();
    expect(q.read).toHaveBeenCalledOnce();
    q.dirty();
    q.render();
    q.renderer.setAtlas(q.atlas);
    q.render();
    expect(q.queue.copyExternalImageToTexture).toHaveBeenCalledOnce();
    expect(q.queue.writeTexture).toHaveBeenCalledTimes(3);
    q.renderer.dispose();
  });

  it("surfaces pixel upload failures and does not mark an unsuccessful upload clean", async () => {
    const q = await uploadFixture();
    const failure = new Error("device failure");
    q.queue.copyExternalImageToTexture.mockImplementation(() => {
      throw new TypeError("image import failed");
    });
    q.queue.writeTexture.mockImplementationOnce(() => {
      throw failure;
    });
    expect(q.render).toThrow(failure);
    expect(q.markUploaded).not.toHaveBeenCalled();
    q.render();
    expect(q.markUploaded).toHaveBeenCalledOnce();
    q.renderer.dispose();
  });
});
