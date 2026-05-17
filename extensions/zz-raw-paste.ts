import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * Custom editor that inserts bracketed-paste content directly into the editor,
 * instead of letting the default editor collapse large pastes into [paste #...]
 * markers. Submitted text is unchanged; this only affects what you see/edit.
 */
class RawPasteEditor extends CustomEditor {
  private isInPaste = false;
  private pasteBuffer = "";

  handleInput(data: string): void {
    if (this.isInPaste || data.includes(PASTE_START)) {
      this.handleRawPaste(data);
      this.tui.requestRender();
      return;
    }

    super.handleInput(data);
  }

  private handleRawPaste(data: string): void {
    let rest = data;

    while (rest.length > 0) {
      if (!this.isInPaste) {
        const startIndex = rest.indexOf(PASTE_START);
        if (startIndex === -1) {
          super.handleInput(rest);
          return;
        }

        const beforePaste = rest.slice(0, startIndex);
        if (beforePaste.length > 0) {
          super.handleInput(beforePaste);
        }

        this.isInPaste = true;
        this.pasteBuffer = "";
        rest = rest.slice(startIndex + PASTE_START.length);
      }

      const endIndex = rest.indexOf(PASTE_END);
      if (endIndex === -1) {
        this.pasteBuffer += rest;
        return;
      }

      const pastedContent = this.pasteBuffer + rest.slice(0, endIndex);
      this.isInPaste = false;
      this.pasteBuffer = "";
      this.insertRawPaste(pastedContent);
      rest = rest.slice(endIndex + PASTE_END.length);
    }
  }

  private insertRawPaste(content: string): void {
    const cleaned = cleanPaste(content);
    if (cleaned.length === 0) return;

    // insertTextAtCursor() keeps the paste as editable text and avoids the
    // default large-paste marker path in Editor.handlePaste().
    this.insertTextAtCursor(cleaned);
  }
}

function cleanPaste(text: string): string {
  // Tmux/CSI-u can re-encode pasted control bytes as ESC [ code ; 5 u.
  const decoded = text.replace(/\x1b\[(\d+);5u/g, (match, code) => {
    const cp = Number(code);
    if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
    if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
    return match;
  });

  return decoded
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "    ")
    .split("")
    .filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
    .join("");
}

export default function rawPaste(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new RawPasteEditor(tui, theme, keybindings),
    );
  });
}
