import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

type PatchedTui = TUI & {
  children: Component[];
  terminal: { rows: number; write(data: string): void };
  render(width: number): string[];
  requestRender(force?: boolean): void;
};

let patchedTui: PatchedTui | undefined;
let originalRender: ((width: number) => string[]) | undefined;
let scrollOffset = 0;
let maxScrollOffset = 0;
let removeInputListener: (() => void) | undefined;

const ENABLE_MOUSE_WHEEL = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE_WHEEL = "\x1b[?1006l\x1b[?1000l";

function render(component: Component | undefined, width: number): string[] {
  return component?.render(width) ?? [];
}

function mouseWheelDelta(data: string): number | undefined {
  const sgr = data.match(/^\x1b\[<(\d+);\d+;\d+M$/);
  if (sgr) {
    const button = Number(sgr[1]);
    if (button === 64) return 3;
    if (button === 65) return -3;
    return undefined;
  }

  if (data.startsWith("\x1b[M") && data.length >= 6) {
    const button = data.charCodeAt(3) - 32;
    if (button === 64) return 3;
    if (button === 65) return -3;
  }

  return undefined;
}

function scroll(delta: number): void {
  if (!patchedTui) return;
  scrollOffset = Math.max(0, Math.min(maxScrollOffset, scrollOffset + delta));
  patchedTui.requestRender(true);
}

function install(tui: TUI): void {
  if (patchedTui) return;

  patchedTui = tui as PatchedTui;
  originalRender = patchedTui.render.bind(patchedTui);
  patchedTui.terminal.write(ENABLE_MOUSE_WHEEL);

  patchedTui.render = (width: number): string[] => {
    const children = patchedTui?.children;
    if (!patchedTui || !children || !originalRender || children.length < 8) {
      return originalRender?.(width) ?? [];
    }

    const scrollback = [
      ...render(children[0], width), // startup header scrolls away with chat history
      ...render(children[1], width),
    ];
    const bottom = children.slice(2).flatMap((child) => render(child, width));

    const scrollbackHeight = Math.max(0, patchedTui.terminal.rows - bottom.length);
    maxScrollOffset = Math.max(0, scrollback.length - scrollbackHeight);
    scrollOffset = Math.max(0, Math.min(maxScrollOffset, scrollOffset));

    const start = Math.max(0, scrollback.length - scrollbackHeight - scrollOffset);
    const visibleScrollback = scrollbackHeight > 0 ? scrollback.slice(start, start + scrollbackHeight) : [];

    return [...visibleScrollback, ...bottom];
  };

  patchedTui.requestRender(true);
}

function uninstall(): void {
  removeInputListener?.();
  removeInputListener = undefined;

  if (patchedTui && originalRender) {
    patchedTui.terminal.write(DISABLE_MOUSE_WHEEL);
    patchedTui.render = originalRender;
    patchedTui.requestRender(true);
  }

  patchedTui = undefined;
  originalRender = undefined;
  scrollOffset = 0;
  maxScrollOffset = 0;
}

export default function stickyInput(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setWidget("sticky-input", (tui) => {
      install(tui);
      return { render: () => [], invalidate: () => {} };
    });

    removeInputListener = ctx.ui.onTerminalInput((data) => {
      const delta = mouseWheelDelta(data);
      if (delta === undefined) return undefined;
      scroll(delta);
      return { consume: true };
    });
  });

  pi.on("session_shutdown", () => {
    uninstall();
  });
}
