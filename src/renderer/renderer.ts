/**
 * WebGPU pipeline that draws a terminal grid.
 *
 * Deliberately does not own an animation loop: it exposes `render()` and the
 * caller decides when to draw, so a hidden panel can simply stop calling it.
 */

import { safely } from "../shared/disposal";
import type { AtlasTexture, Renderer, RendererFactory, RendererGrid } from "./renderer-interface";
import { buildInstanceData, ensureGlyphs, FLOATS_PER_INSTANCE } from "./instance-data";
import { buildPaletteBuffer, PALETTE_ENTRIES } from "./palette";
import { TERMINAL_SHADER } from "./terminal-shader.wgsl";

const BYTES_PER_FLOAT = 4;

export class TerminalRenderer implements Renderer {
  #device: GPUDevice;
  #context: GPUCanvasContext;
  #pipeline: GPURenderPipeline;
  #atlas: AtlasTexture;

  #uniformBuffer: GPUBuffer;
  #paletteBuffer: GPUBuffer;
  #instanceBuffer: GPUBuffer | undefined;
  #instanceCapacity = 0;
  #texture: GPUTexture | undefined;
  #atlasReadback = false;
  #sampler: GPUSampler;
  #disposed = false;
  #failure: Error | undefined;
  readonly #errorListeners = new Set<(error: Error) => void>();
  readonly #diagnosticListeners = new Set<(error: Error) => void>();
  readonly #onUncapturedError = (event: GPUUncapturedErrorEvent): void => {
    if (this.#disposed) return;
    const error = new Error(`Uncaptured WebGPU error: ${event.error.message}`);
    for (const listener of Array.from(this.#diagnosticListeners)) listener(error);
  };

  private constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    pipeline: GPURenderPipeline,
    atlas: AtlasTexture,
  ) {
    this.#device = device;
    this.#context = context;
    this.#pipeline = pipeline;
    this.#atlas = atlas;

    this.#uniformBuffer = device.createBuffer({
      size: 4 * BYTES_PER_FLOAT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#paletteBuffer = device.createBuffer({
      size: PALETTE_ENTRIES * 4 * BYTES_PER_FLOAT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.#sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });

    device.addEventListener("uncapturederror", this.#onUncapturedError);
    void device.lost.then((info) => {
      if (this.#disposed || info.reason === "destroyed") return;
      const detail = info.message.trim();
      this.#reportError(
        new Error(detail === "" ? "WebGPU device lost." : `WebGPU device lost: ${detail}`),
      );
    });
  }

  /**
   * Acquire a GPU device and build the pipeline.
   *
   * Throws — loudly — when WebGPU is unavailable. There is deliberately no
   * fallback: silently degrading would hide a real driver or configuration
   * problem behind a mysteriously slow editor.
   */
  static async create(canvas: HTMLCanvasElement, atlas: AtlasTexture): Promise<TerminalRenderer> {
    if (navigator.gpu === undefined) {
      throw new Error(
        "WebGPU is unavailable in this environment, so the terminal cannot be rendered.",
      );
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (adapter === null) {
      throw new Error("No WebGPU adapter available — the GPU driver may be unsupported.");
    }
    const device = await adapter.requestDevice();
    let context: GPUCanvasContext | undefined;
    try {
      context = canvas.getContext("webgpu") ?? undefined;
      if (context === undefined) {
        throw new Error("Could not acquire a WebGPU context from the canvas.");
      }

      const format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({
        device,
        format,
        // Premultiplied alpha leaves the sub-cell canvas remainder transparent.
        // Palette entries are currently opaque #rrggbb, so rendered cell
        // backgrounds themselves do not expose the host background.
        alphaMode: "premultiplied",
      });

      const module = device.createShaderModule({ code: TERMINAL_SHADER });
      const pipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module,
          entryPoint: "vertexMain",
          buffers: [
            {
              arrayStride: FLOATS_PER_INSTANCE * BYTES_PER_FLOAT,
              stepMode: "instance",
              attributes: [
                { shaderLocation: 0, offset: 0, format: "float32x2" },
                { shaderLocation: 1, offset: 2 * BYTES_PER_FLOAT, format: "float32x4" },
                { shaderLocation: 2, offset: 6 * BYTES_PER_FLOAT, format: "float32x4" },
                { shaderLocation: 3, offset: 10 * BYTES_PER_FLOAT, format: "float32x4" },
                { shaderLocation: 4, offset: 14 * BYTES_PER_FLOAT, format: "float32" },
              ],
            },
          ],
        },
        fragment: {
          module,
          entryPoint: "fragmentMain",
          targets: [{ format }],
        },
        primitive: { topology: "triangle-list" },
      });

      return new TerminalRenderer(device, context, pipeline, atlas);
    } catch (error) {
      safely(context?.unconfigure.bind(context));
      safely(device.destroy.bind(device));
      throw error;
    }
  }

  /** Observe failures reported asynchronously by the WebGPU device. */
  onError(listener: (error: Error) => void): () => void {
    if (this.#disposed) return () => {};
    if (this.#failure !== undefined) {
      listener(this.#failure);
      return () => {};
    }
    this.#errorListeners.add(listener);
    return () => {
      this.#errorListeners.delete(listener);
    };
  }

  onDiagnostic(listener: (error: Error) => void): () => void {
    if (this.#disposed) return () => {};
    this.#diagnosticListeners.add(listener);
    return () => {
      this.#diagnosticListeners.delete(listener);
    };
  }

  /** Replace the theme. Rewrites one uniform buffer; never touches the atlas. */
  setPalette(overrides: Map<number, string>): void {
    this.#assertLive("setPalette");
    this.#device.queue.writeBuffer(
      this.#paletteBuffer,
      0,
      buildPaletteBuffer(overrides).buffer as ArrayBuffer,
    );
  }

  /**
   * Replace the glyph atlas — the font changed, so every glyph shape did.
   *
   * Drops the current texture so the next frame re-uploads from the new atlas;
   * keeping it would draw old glyph shapes at the new cell metrics.
   */
  setAtlas(atlas: AtlasTexture): void {
    this.#assertLive("setAtlas");
    this.#atlas = atlas;
    this.#texture?.destroy();
    this.#texture = undefined;
  }

  /** Draw one frame. */
  render(grid: RendererGrid): void {
    if (this.#disposed) return;
    // Order matters, and both steps have to precede the upload:
    //   1. rasterize every code point, so the atlas reaches its final height
    //      before any texture coordinate is normalized against it;
    //   2. build the instance data, now guaranteed to hit only cached slots.
    // Uploading first would sample a texture missing the new glyphs; building
    // instances without step 1 would hand out coordinates normalized against a
    // height that a later cell then grows.
    ensureGlyphs(grid.packed, this.#atlas);
    const instances = buildInstanceData(grid.packed, grid.columns, grid.lines, this.#atlas);

    this.#uploadAtlasIfDirty();

    this.#ensureInstanceCapacity(instances.byteLength);
    const instanceBuffer = this.#instanceBuffer;
    if (instanceBuffer === undefined) {
      throw new Error("Instance buffer was not allocated before rendering.");
    }
    this.#device.queue.writeBuffer(instanceBuffer, 0, instances.buffer as ArrayBuffer);

    // Cells are sized from the atlas, not from `1 / columns`. Deriving the size
    // from the column count stretches the grid to fill the canvas, resampling
    // every glyph off its rasterized size — the whole screen reads as blurry.
    // Drawing at the exact cell size keeps texels 1:1 with pixels and leaves
    // the sub-cell remainder as padding.
    const canvas = this.#context.canvas;
    const cell = this.#atlas.cell;
    this.#device.queue.writeBuffer(
      this.#uniformBuffer,
      0,
      new Float32Array([
        grid.columns,
        grid.lines,
        cell.width / canvas.width,
        cell.height / canvas.height,
      ]),
    );

    const texture = this.#texture;
    if (texture === undefined) {
      throw new Error("Glyph atlas texture was not uploaded before rendering.");
    }

    const bindGroup = this.#device.createBindGroup({
      layout: this.#pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.#uniformBuffer } },
        { binding: 1, resource: { buffer: this.#paletteBuffer } },
        { binding: 2, resource: texture.createView() },
        { binding: 3, resource: this.#sampler },
      ],
    });

    const encoder = this.#device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.#context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, instanceBuffer);
    // Six vertices per quad, one instance per cell: the whole grid in one call.
    pass.draw(6, grid.columns * grid.lines);
    pass.end();

    this.#device.queue.submit([encoder.finish()]);
  }

  /**
   * Release every GPU resource this renderer owns, including its device.
   * Each renderer requests its own adapter and device in `create`, so
   * destroying the device here frees the whole allocation rather than
   * leaking one per terminal that is torn down.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    safely(() => this.#device.removeEventListener("uncapturederror", this.#onUncapturedError));
    this.#errorListeners.clear();
    this.#diagnosticListeners.clear();
    safely(this.#texture?.destroy.bind(this.#texture));
    this.#texture = undefined;
    safely(this.#instanceBuffer?.destroy.bind(this.#instanceBuffer));
    this.#instanceBuffer = undefined;
    this.#instanceCapacity = 0;
    safely(this.#uniformBuffer.destroy.bind(this.#uniformBuffer));
    safely(this.#paletteBuffer.destroy.bind(this.#paletteBuffer));
    safely(this.#context.unconfigure.bind(this.#context));
    safely(this.#device.destroy.bind(this.#device));
  }

  #reportError(error: Error): void {
    if (this.#disposed || this.#failure !== undefined) return;
    this.#failure = error;
    for (const listener of Array.from(this.#errorListeners)) listener(error);
  }

  #uploadAtlasIfDirty(): void {
    if (this.#texture !== undefined && !this.#atlas.isDirty) {
      return;
    }

    const source = this.#atlas.source;
    this.#texture?.destroy();
    this.#texture = this.#device.createTexture({
      size: [source.width, source.height],
      format: "rgba8unorm",
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });

    if (this.#atlasReadback) {
      this.#uploadAtlasPixels(source);
    } else {
      try {
        this.#device.queue.copyExternalImageToTexture({ source }, { texture: this.#texture }, [
          source.width,
          source.height,
        ]);
      } catch {
        // External-image imports can fail with engine-specific exceptions.
        // Upload RGBA bytes instead; failures of that upload still surface.
        this.#uploadAtlasPixels(source);
        this.#atlasReadback = true;
      }
    }
    this.#atlas.markUploaded();
  }

  #uploadAtlasPixels(source: OffscreenCanvas): void {
    const context = source.getContext("2d");
    if (context === null) throw new Error("Could not read the glyph atlas for WebGPU upload.");
    const pixels = context.getImageData(0, 0, source.width, source.height);
    // The shader samples alpha coverage only; getImageData's unpremultiplied
    // RGB channels do not change glyph coverage. Read back only dirty atlases.
    this.#device.queue.writeTexture(
      { texture: this.#texture! },
      pixels.data,
      { bytesPerRow: source.width * 4 },
      [source.width, source.height],
    );
  }

  #ensureInstanceCapacity(byteLength: number): void {
    if (this.#instanceBuffer !== undefined && this.#instanceCapacity >= byteLength) {
      return;
    }
    this.#instanceBuffer?.destroy();
    this.#instanceBuffer = this.#device.createBuffer({
      size: byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.#instanceCapacity = byteLength;
  }

  #assertLive(method: string): void {
    if (this.#disposed) {
      throw new Error(`TerminalRenderer.${method}() was called after dispose().`);
    }
  }
}

/**
 * The WebGPU implementation of `RendererFactory`.
 *
 * Throws — loudly — when WebGPU is unavailable. There is deliberately no
 * fallback: silently degrading would hide a real driver or configuration
 * problem behind a mysteriously slow terminal.
 */
export const createWebGpuRenderer: RendererFactory = (canvas, atlas) =>
  TerminalRenderer.create(canvas, atlas);
