# Changelog

## Unreleased

### Fixed

- Recover glyph-atlas image import failures on software WebGPU adapters by
  uploading RGBA pixels. Font changes keep rendering, and unchanged atlases
  require no CPU readback.
- Local wheel scrolling uses pixel, line and page deltas instead of moving
  three lines per event. Fractional movement accumulates per terminal; zero
  and horizontal-only events no longer scroll vertically.
- Alternate-screen wheel arrows work when mouse reporting is disabled or uses
  an unsupported protocol (for example Vim with `ttymouse=xterm`).
  Supported SGR mouse reporting takes priority over alternate-scroll arrows;
  application events never also move local history.

### Added

- Optional `TerminalOptions.scrollSensitivity` (default `1`), also supported by
  `setOptions`. A finite non-negative multiplier for local wheel scrolling;
  `0` disables it and permits host-page scrolling outside application mouse
  and alternate-screen modes, without suppressing application input. See the README
  for delta conversion and fractional-state behavior.

## 1.2.2 — 2026-09-17

### Changed

- Widen the supported Node range from `>=22.18.0 <23.0.0` to `>=22.18.0 <25.0.0`.
  The previous upper bound rejected Node 23 and 24 outright. Widening rather
  than moving it keeps every Node 22 consumer working.
  ([#15](https://github.com/edjubert/CeleriTTY/pull/15) by @edjubert)

### Internal

- The release workflow publishes with `npm publish` on Node 24.21.0 LTS, whose
  bundled npm 11.19.0 performs the OIDC exchange that npm trusted publishing
  needs. `pnpm publish` never could, which is why every release up to 1.2.1 was
  published by hand. Both CI jobs move to the same Node, so a tag cannot publish
  an artifact built on a runtime the pull requests never exercised.
  ([#15](https://github.com/edjubert/CeleriTTY/pull/15) by @edjubert)
- Pin the wasm-pack version used by CI and the release job. The action resolves
  `latest` on every run and handed out 0.9.1, which predates workspace
  inheritance and cannot parse `license.workspace = true`. Two runs of the same
  commit disagreed on whether the build worked.
  ([#16](https://github.com/edjubert/CeleriTTY/pull/16) by @edjubert)

## 1.2.1 — 2026-09-17

### Fixed

- Synchronized output (`CSI ?2026h`) no longer panics on WASM. The parser uses a
  monotonic `performance.now()` deadline instead of `std::time::Instant`, which
  is unsupported on `wasm32-unknown-unknown`. A missing end marker can no longer
  freeze rendering: the 150 ms deadline is polled before incoming data and on
  animation frames while a batch is open.
  ([#13](https://github.com/edjubert/CeleriTTY/pull/13) by @rle-mino)
- Selections no longer panic on coordinates outside the grid. Pixel-to-cell
  conversion is clamped against the allocated grid for both drag endpoints,
  stale anchors are re-clamped after a resize, and the WASM `selectedText`
  boundary clamps and normalizes before converting viewport rows to scrollback
  coordinates.
  ([#12](https://github.com/edjubert/CeleriTTY/pull/12) by @rle-mino)
- Selecting a line ending in a wrapped wide character returned text from the
  wrong row, and panicked on the topmost row with no history. The vendored
  `alacritty_terminal` patch reads the wrapped glyph from the next row, and
  guards the read when a restricted scroll region (DECSTBM) leaves the spacer on
  the bottom row.
  ([#12](https://github.com/edjubert/CeleriTTY/pull/12) by @rle-mino)
- Link hit testing no longer activates an edge cell's link from a pointer
  outside the grid.
  ([#12](https://github.com/edjubert/CeleriTTY/pull/12) by @rle-mino)

### Changed

- The low-level WASM binding's `selectedText` normalizes reversed corners and
  returns the selected text instead of the empty string it returned in 1.2.0.
  That binding is not exported from the package entry points and
  `Terminal.getSelection()` already normalized corners itself, so the published
  API is unchanged.
  ([#12](https://github.com/edjubert/CeleriTTY/pull/12) by @rle-mino)

### Internal

- A `browser` CI job runs the bundled WASM and WebGPU regressions headlessly on
  every pull request and main push, using Chromium's software WebGPU adapter.
  An opt-in `pnpm test:neovim` PTY integration suite lives outside the default
  browser suite.
  ([#14](https://github.com/edjubert/CeleriTTY/pull/14),
  [#13](https://github.com/edjubert/CeleriTTY/pull/13) by @rle-mino)

## 1.2.0

See the [v1.2.0 release](https://github.com/edjubert/CeleriTTY/releases/tag/v1.2.0).
