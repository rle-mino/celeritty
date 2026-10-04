import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

for (const dpr of [1, 2]) {
  test.describe(`wheel with bundled WASM/WebGPU at DPR ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });
    test("measures proportional travel, fractional gestures, all units and boundaries", async ({
      page,
    }, info) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/browser.html");
      await page.waitForFunction(() => window.qa?.state().frames > 0);
      const result = await page.evaluate(async () => {
        const { qa } = window;
        const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const settle = async () => {
          await frame();
          await frame();
        };
        qa.feed(Array.from({ length: 400 }, (_, i) => `ROW_${i}`).join("\r\n"));
        await settle();
        const first = () => Number(qa.state().rows[0].slice(4));
        const bottom = first();
        const height = qa.state().cell.height / devicePixelRatio;
        const dispatch = (deltaY: number, deltaMode = 0, deltaX = 0) =>
          qa.host.dispatchEvent(
            new WheelEvent("wheel", { deltaY, deltaMode, deltaX, bubbles: true, cancelable: true }),
          );
        const measurements: Record<string, number> = {};
        const measure = async (label: string, action: () => void) => {
          qa.terminal.scrollToBottom();
          action();
          await settle();
          measurements[label] = bottom - first();
        };
        await measure("single0.1px", () => dispatch(-0.1));
        await measure("single1px", () => dispatch(-1));
        await measure("single100px", () => dispatch(-100));
        await measure("twoHundred0.1px", () => {
          for (let i = 0; i < 200; i++) dispatch(-0.1);
        });
        await measure("tenFractionalLines", () => {
          for (let i = 0; i < 10; i++) dispatch(-0.1, 1);
        });
        await measure("page", () => dispatch(-1, 2));
        await measure("halfPage", () => dispatch(-0.5, 2));
        await measure("mixedUnits", () => {
          dispatch(-height / 2);
          dispatch(-0.5, 1);
        });
        await measure("horizontal", () => {
          dispatch(0, 0, 100);
          dispatch(0);
        });
        await measure("reverse", () => {
          dispatch(-5, 1);
          dispatch(-0.9, 1);
          dispatch(0.5, 1);
          dispatch(0.5, 1);
        });
        await measure("topAndReverse", () => {
          dispatch(-1e20);
          dispatch(-height / 2);
          dispatch(height);
        });
        await measure("bottomAndReverse", () => {
          dispatch(1e20);
          dispatch(height / 2);
          dispatch(-height);
        });
        // Ordinary local scrolling must not measure DOM geometry per event.
        const canvas = qa.host.querySelector("canvas")!;
        const original = canvas.getBoundingClientRect;
        let layoutReads = 0;
        canvas.getBoundingClientRect = function () {
          layoutReads++;
          return original.call(this);
        };
        for (let i = 0; i < 100; i++) dispatch(-0.1);
        canvas.getBoundingClientRect = original;
        return {
          measurements,
          bottom,
          height,
          rows: qa.state().grid.lines,
          layoutReads,
          replies: qa.replies,
          errors: qa.errors,
        };
      });
      expect(result.measurements).toEqual({
        "single0.1px": 0,
        single1px: 0,
        single100px: Math.floor(100 / result.height),
        "twoHundred0.1px": Math.floor(20 / result.height),
        tenFractionalLines: 1,
        page: result.rows,
        halfPage: Math.floor(result.rows / 2),
        mixedUnits: 1,
        horizontal: 0,
        reverse: 4,
        topAndReverse: result.bottom - 1,
        bottomAndReverse: 1,
      });
      expect(result.layoutReads).toBe(0);
      expect(result.replies).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(errors).toEqual([]);
      await writeFile(info.outputPath("wheel-distances.json"), JSON.stringify(result, null, 2));
      await info.attach("wheel-distances.json", {
        body: JSON.stringify(result, null, 2),
        contentType: "application/json",
      });
    });

    test("live sensitivity, lifecycle, font and viewport changes reset stale fractions", async ({
      page,
    }) => {
      await page.goto("/browser.html");
      await page.waitForFunction(() => window.qa?.state().frames > 0);
      const result = await page.evaluate(async () => {
        const { qa } = window;
        const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const settle = async () => {
          await frame();
          await frame();
          await frame();
        };
        const dispatch = (deltaY: number, deltaMode = 1) =>
          qa.host.dispatchEvent(
            new WheelEvent("wheel", { deltaY, deltaMode, bubbles: true, cancelable: true }),
          );
        qa.feed(Array.from({ length: 400 }, (_, i) => `ROW_${i}`).join("\r\n"));
        await settle();
        const first = () => Number(qa.state().rows[0].slice(4));
        const bottom = first();
        const offsets: Record<string, number> = {};
        const record = async (name: string) => {
          await settle();
          offsets[name] = bottom - first();
        };
        dispatch(-0.75);
        qa.terminal.setOptions({ scrollSensitivity: 0.5 });
        dispatch(-1);
        await record("changedClearsFraction");
        dispatch(-1);
        await record("halfSpeed");
        qa.terminal.setOptions({ scrollSensitivity: 0 });
        dispatch(-100);
        await record("disabled");
        qa.terminal.setOptions({ scrollSensitivity: undefined });
        dispatch(-2);
        await record("restoredDefault");
        dispatch(-0.75);
        qa.terminal.setOptions({ scrollSensitivity: 1 });
        dispatch(-0.25);
        await record("sameValueKeepsFraction");
        dispatch(-0.75);
        try {
          qa.terminal.setOptions({
            scrollSensitivity: NaN,
            font: { family: "monospace", size: 99 },
          });
        } catch {
          /* expected */
        }
        dispatch(-0.25);
        await record("invalidPatchIsAtomic");
        dispatch(-0.75);
        qa.terminal.scrollToBottom();
        dispatch(-0.25);
        await record("explicitScrollResets");
        dispatch(-0.5);
        qa.terminal.detach();
        dispatch(-0.25);
        await record("detachResets");
        qa.terminal.scrollToBottom();
        dispatch(-0.75);
        qa.host.dispatchEvent(
          new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true }),
        );
        dispatch(-0.25);
        await record("typingResets");
        qa.terminal.scrollToBottom();
        dispatch(-0.75);
        qa.feed("\x1b[?1049h");
        qa.feed("\x1b[?1049l");
        dispatch(-0.25);
        await record("screenSwitchResets");
        qa.terminal.scrollToBottom();
        dispatch(-0.75);
        qa.terminal.setOptions({ scrollback: 1000 });
        dispatch(-0.25);
        await record("scrollbackResets");
        qa.terminal.scrollToBottom();
        dispatch(-0.75);
        qa.terminal.setOptions({ font: { family: "monospace", size: 20, lineHeight: 1.5 } });
        await settle();
        const fontBottom = first();
        dispatch(-0.25);
        await settle();
        offsets.fontResets = fontBottom - first();
        dispatch(-(qa.state().cell.height / devicePixelRatio), 0);
        await settle();
        offsets.newCellHeight = fontBottom - first();
        qa.terminal.scrollToBottom();
        dispatch(-0.75);
        qa.host.style.height = "300px";
        await settle();
        const resizeBottom = first();
        dispatch(-0.25);
        await settle();
        offsets.resizeResets = resizeBottom - first();
        dispatch(-1, 2);
        await settle();
        offsets.newPageHeight = resizeBottom - first();
        const rows = qa.state().grid.lines;
        qa.terminal.dispose();
        dispatch(-100);
        return { offsets, rows, errors: qa.errors };
      });
      expect(result.offsets).toEqual({
        changedClearsFraction: 0,
        halfSpeed: 1,
        disabled: 1,
        restoredDefault: 3,
        sameValueKeepsFraction: 4,
        invalidPatchIsAtomic: 5,
        explicitScrollResets: 0,
        detachResets: 0,
        typingResets: 0,
        screenSwitchResets: 0,
        scrollbackResets: 0,
        fontResets: 0,
        newCellHeight: 1,
        resizeResets: 0,
        newPageHeight: result.rows,
      });
      expect(result.errors).toEqual([]);
    });
  });
}

test("browser wheel routing: SGR, alternate arrows, disabled alternate scroll, return to history", async ({
  page,
}) => {
  await page.goto("/browser.html");
  await page.waitForFunction(() => window.qa?.state().frames > 0);
  const result = await page.evaluate(async () => {
    const { qa } = window;
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const settle = async () => {
      await frame();
      await frame();
    };
    qa.feed(Array.from({ length: 200 }, (_, i) => `ROW_${i}`).join("\r\n"));
    qa.terminal.scrollLines(10);
    await settle();
    const before = qa.state().rows;
    const box = qa.host.querySelector("canvas")!.getBoundingClientRect();
    const dispatch = (deltaY: number, deltaX = 0) =>
      qa.host.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY,
          deltaX,
          clientX: box.left + 1,
          clientY: box.top + 1,
          bubbles: true,
          cancelable: true,
        }),
      );
    qa.terminal.setOptions({ scrollSensitivity: 0 });
    qa.feed("\x1b[?1049h\x1b[?1007h\x1b[?1h");
    dispatch(-0.1);
    dispatch(100);
    dispatch(0, 100);
    qa.feed("\x1b[?1000h\x1b[?1006l");
    dispatch(-0.1);
    dispatch(100);
    qa.feed("\x1b[?1l");
    dispatch(-0.1);
    dispatch(100);
    qa.feed("\x1b[?1000h\x1b[?1006h");
    dispatch(-0.1);
    dispatch(100);
    qa.feed("\x1b[?1000l\x1b[?1007l");
    dispatch(-100);
    dispatch(100);
    qa.feed("\x1b[?1049l");
    await settle();
    return {
      before,
      after: qa.state().rows,
      replies: qa.replies.map((bytes) => new TextDecoder().decode(Uint8Array.from(bytes))),
      errors: qa.errors,
    };
  });
  expect(result.replies).toEqual([
    "\x1bOA",
    "\x1bOB",
    "\x1bOA",
    "\x1bOB",
    "\x1b[A",
    "\x1b[B",
    "\x1b[<64;1;1M",
    "\x1b[<65;1;1M",
  ]);
  expect(result.after).toEqual(result.before);
  expect(result.errors).toEqual([]);
});

test("zero sensitivity lets the host page scroll without moving terminal history", async ({
  page,
}) => {
  await page.goto("/browser.html");
  await page.waitForFunction(() => window.qa?.state().frames > 0);
  await page.evaluate(() => {
    document.body.style.height = "3000px";
    const { qa } = window;
    qa.feed(Array.from({ length: 200 }, (_, i) => `ROW_${i}`).join("\r\n"));
    qa.terminal.scrollLines(20);
    qa.terminal.setOptions({ scrollSensitivity: 0 });
  });
  await expect.poll(() => page.evaluate(() => window.qa.state().rows[0])).toContain("ROW_");
  const before = await page.evaluate(() => window.qa.state().rows);
  await page.locator("#terminal").hover();
  await page.mouse.wheel(0, 120);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.qa.state().rows)).toEqual(before);
  expect(await page.evaluate(() => window.qa.errors)).toEqual([]);
});
