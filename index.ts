/**
 * Vim Editor Extension for Pi
 *
 * A vim-like modal editor replacing Pi's default editor.
 * Supports normal/insert/visual/command modes with common vim keybindings.
 *
 * Modes:
 *   NORMAL  — Movement, operators, text manipulation. Enter submits prompt.
 *   INSERT  — Regular text input. Enter = new line. Escape = normal mode.
 *   VISUAL  — Character selection (v). Operators act on selection.
 *   V-LINE  — Line selection (V). Operators act on selected lines.
 *   COMMAND — Ex commands (:w to submit, :q to exit).
 *
 * Commands:
 *   /vim    — Enable vim mode
 *   /novim  — Restore default editor
 */

import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type TUI } from "@mariozechner/pi-tui";

// ─── Types ──────────────────────────────────────────────────────────────────

type VimMode = "normal" | "insert" | "visual" | "visual-line" | "replace-char" | "find-char" | "command";
type Operator = "delete" | "change" | "yank";
type FindDir = "f" | "F" | "t" | "T";

interface Pos {
	line: number;
	col: number;
}

interface Register {
	text: string;
	linewise: boolean;
}

// ─── ANSI Styles ────────────────────────────────────────────────────────────

const S = {
	normal: "\x1b[1;97;44m", // bold white on blue
	insert: "\x1b[1;97;42m", // bold white on green
	visual: "\x1b[1;97;45m", // bold white on magenta
	command: "\x1b[1;97;43m", // bold white on yellow
	replace: "\x1b[1;97;41m", // bold white on red
	find: "\x1b[1;30;43m", // bold black on yellow
	dim: "\x1b[2m",
	R: "\x1b[0m", // reset
};

// ─── Cursor Shape Escapes ───────────────────────────────────────────────────
// DECSCUSR (Set Cursor Style) — works in xterm, kitty, ghostty, most modern terms
const CURSOR = {
	block: "\x1b[2 q",     // steady block (normal mode)
	bar: "\x1b[6 q",       // steady bar/thin line (insert mode)
	underline: "\x1b[4 q", // steady underline (replace mode)
	default: "\x1b[0 q",   // terminal default
};

// ─── Buffer Persistence ─────────────────────────────────────────────────────
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const RECOVERY_DIR = join(process.env.HOME || "/tmp", ".cache", "pi-vim-editor");
const RECOVERY_FILE = join(RECOVERY_DIR, "buffer-recovery.txt");

function saveRecoveryBuffer(text: string): void {
	try {
		if (!existsSync(RECOVERY_DIR)) mkdirSync(RECOVERY_DIR, { recursive: true });
		writeFileSync(RECOVERY_FILE, text, "utf-8");
	} catch { /* best effort */ }
}

function loadRecoveryBuffer(): string | null {
	try {
		if (existsSync(RECOVERY_FILE)) {
			const text = readFileSync(RECOVERY_FILE, "utf-8");
			return text || null;
		}
	} catch { /* best effort */ }
	return null;
}

function clearRecoveryBuffer(): void {
	try {
		if (existsSync(RECOVERY_FILE)) writeFileSync(RECOVERY_FILE, "", "utf-8");
	} catch { /* best effort */ }
}

// ─── VimEditor ──────────────────────────────────────────────────────────────

class VimEditor extends CustomEditor {
	// --- Vim state ---
	private mode: VimMode = "normal";
	private count = 0;
	private operator: Operator | null = null;
	private gPending = false;
	private findDir: FindDir = "f";
	private lastFind: { char: string; dir: FindDir } | null = null;
	private commandBuf = "";
	private visualAnchor: Pos | null = null;
	private infoMsg = "";
	private infoTimer: ReturnType<typeof setTimeout> | null = null;

	// Registers
	private unnamedReg: Register = { text: "", linewise: false };
	private namedRegs = new Map<string, Register>();

	// Repeat (.)
	private lastChangeKeys: string[] = [];
	private recording = false;
	private changeKeys: string[] = [];
	private replaying = false;

	// Buffer persistence
	private saveTimer: ReturnType<typeof setTimeout> | null = null;

	// ─── Internal state access ──────────────────────────────────────────
	// Editor.state is TypeScript-private but accessible at JS runtime
	private get es() {
		return (this as any).state as { lines: string[]; cursorLine: number; cursorCol: number };
	}

	constructor(tui: TUI, theme: any, keybindings: any) {
		super(tui, theme, keybindings);
		// Enable hardware cursor so DECSCUSR shape changes are visible
		// (Pi's TUI hides the hardware cursor by default, rendering a software
		// cursor via reverse video instead. We strip that and use the real one.)
		this.tui.setShowHardwareCursor(true);
		// Set initial cursor shape
		this.setCursorShape("normal");
		// Restore any recovered buffer content
		const recovered = loadRecoveryBuffer();
		if (recovered && recovered.trim()) {
			this.es.lines = recovered.split("\n");
			this.es.cursorLine = 0;
			this.es.cursorCol = 0;
			this.fireChange();
			this.showInfo("Buffer recovered!", 3000);
			// Clear recovery file after restoring
			clearRecoveryBuffer();
		}
	}

	// ─── Cursor shape ───────────────────────────────────────────────────

	private setCursorShape(mode: VimMode): void {
		let seq: string;
		switch (mode) {
			case "insert":
				seq = CURSOR.bar;
				break;
			case "replace-char":
				seq = CURSOR.underline;
				break;
			default:
				seq = CURSOR.block;
				break;
		}
		this.tui.terminal.write(seq);
	}

	// ─── Buffer auto-save (debounced) ───────────────────────────────────

	private scheduleSave(): void {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			const text = this.es.lines.join("\n");
			if (text.trim()) {
				saveRecoveryBuffer(text);
			}
		}, 1000); // save 1s after last keystroke
	}

	// ─── Position helpers ───────────────────────────────────────────────

	private pos(): Pos {
		return { line: this.es.cursorLine, col: this.es.cursorCol };
	}

	private setPos(p: Pos): void {
		const lines = this.es.lines;
		this.es.cursorLine = clamp(p.line, 0, lines.length - 1);
		const ln = lines[this.es.cursorLine] || "";
		const max = this.mode === "insert" ? ln.length : Math.max(0, ln.length - 1);
		this.es.cursorCol = clamp(p.col, 0, max);
	}

	private line(n?: number): string {
		return this.es.lines[n ?? this.es.cursorLine] || "";
	}

	private lc(): number {
		return this.es.lines.length;
	}

	private ec(): number {
		return this.count || 1;
	}

	// ─── Undo integration ───────────────────────────────────────────────

	private pushUndo(): void {
		const stack = (this as any).undoStack;
		if (Array.isArray(stack)) {
			stack.push({
				lines: [...this.es.lines],
				cursorLine: this.es.cursorLine,
				cursorCol: this.es.cursorCol,
			});
			if (stack.length > 100) stack.shift();
		}
	}

	private popUndo(): boolean {
		const stack = (this as any).undoStack;
		if (Array.isArray(stack) && stack.length > 0) {
			const snap = stack.pop();
			this.es.lines = [...snap.lines];
			this.es.cursorLine = snap.cursorLine;
			this.es.cursorCol = snap.cursorCol;
			this.fireChange();
			return true;
		}
		return false;
	}

	private fireChange(): void {
		const fn = (this as any).onChange;
		if (fn) fn(this.getText());
	}

	// ─── Info message ───────────────────────────────────────────────────

	private showInfo(msg: string, ms = 2000): void {
		this.infoMsg = msg;
		if (this.infoTimer) clearTimeout(this.infoTimer);
		this.infoTimer = setTimeout(() => {
			this.infoMsg = "";
			this.infoTimer = null;
		}, ms);
	}

	// ─── Character classification ───────────────────────────────────────

	private isWord(c: string): boolean {
		return /[a-zA-Z0-9_]/.test(c);
	}
	private isPunct(c: string): boolean {
		return c !== "" && !this.isWord(c) && !/\s/.test(c);
	}
	private isWs(c: string): boolean {
		return /\s/.test(c);
	}

	private firstNonBlank(ln: number): number {
		const s = this.line(ln);
		for (let i = 0; i < s.length; i++) if (!this.isWs(s[i])) return i;
		return 0;
	}

	// ─── Motions ────────────────────────────────────────────────────────

	private motionWordForward(count: number): Pos {
		let { line: ln, col } = this.pos();
		for (let i = 0; i < count; i++) {
			const s = this.line(ln);
			if (col >= s.length) {
				if (ln < this.lc() - 1) {
					ln++;
					col = 0;
					const ns = this.line(ln);
					while (col < ns.length && this.isWs(ns[col])) col++;
				}
				continue;
			}
			const ch = s[col];
			if (this.isWord(ch)) {
				while (col < s.length && this.isWord(s[col])) col++;
			} else if (this.isPunct(ch)) {
				while (col < s.length && this.isPunct(s[col])) col++;
			}
			while (col < s.length && this.isWs(s[col])) col++;
			if (col >= s.length && ln < this.lc() - 1) {
				ln++;
				col = 0;
				const ns = this.line(ln);
				while (col < ns.length && this.isWs(ns[col])) col++;
			}
		}
		return { line: ln, col };
	}

	private motionWordBackward(count: number): Pos {
		let { line: ln, col } = this.pos();
		for (let i = 0; i < count; i++) {
			if (col === 0) {
				if (ln > 0) {
					ln--;
					col = this.line(ln).length;
				} else continue;
			}
			const s = this.line(ln);
			col--;
			while (col >= 0 && this.isWs(s[col])) col--;
			if (col < 0) {
				if (ln > 0) {
					ln--;
					col = Math.max(0, this.line(ln).length - 1);
				} else col = 0;
				continue;
			}
			const ch = s[col];
			if (this.isWord(ch)) {
				while (col > 0 && this.isWord(s[col - 1])) col--;
			} else if (this.isPunct(ch)) {
				while (col > 0 && this.isPunct(s[col - 1])) col--;
			}
		}
		return { line: ln, col };
	}

	private motionWordEnd(count: number): Pos {
		let { line: ln, col } = this.pos();
		for (let i = 0; i < count; i++) {
			col++;
			let s = this.line(ln);
			if (col >= s.length) {
				if (ln < this.lc() - 1) {
					ln++;
					col = 0;
					s = this.line(ln);
				} else {
					col = Math.max(0, s.length - 1);
					continue;
				}
			}
			while (col < s.length && this.isWs(s[col])) col++;
			if (col >= s.length) {
				if (ln < this.lc() - 1) {
					ln++;
					col = 0;
					s = this.line(ln);
					while (col < s.length && this.isWs(s[col])) col++;
				}
			}
			s = this.line(ln);
			if (col < s.length) {
				const ch = s[col];
				if (this.isWord(ch)) {
					while (col < s.length - 1 && this.isWord(s[col + 1])) col++;
				} else if (this.isPunct(ch)) {
					while (col < s.length - 1 && this.isPunct(s[col + 1])) col++;
				}
			}
		}
		return { line: ln, col };
	}

	private motionWORDForward(count: number): Pos {
		let { line: ln, col } = this.pos();
		for (let i = 0; i < count; i++) {
			const s = this.line(ln);
			while (col < s.length && !this.isWs(s[col])) col++;
			while (col < s.length && this.isWs(s[col])) col++;
			if (col >= s.length && ln < this.lc() - 1) {
				ln++;
				col = 0;
				const ns = this.line(ln);
				while (col < ns.length && this.isWs(ns[col])) col++;
			}
		}
		return { line: ln, col };
	}

	private motionWORDBackward(count: number): Pos {
		let { line: ln, col } = this.pos();
		for (let i = 0; i < count; i++) {
			if (col === 0 && ln > 0) {
				ln--;
				col = this.line(ln).length;
			}
			const s = this.line(ln);
			col--;
			while (col >= 0 && this.isWs(s[col])) col--;
			if (col < 0) {
				col = 0;
				continue;
			}
			while (col > 0 && !this.isWs(s[col - 1])) col--;
		}
		return { line: ln, col };
	}

	private motionWORDEnd(count: number): Pos {
		let { line: ln, col } = this.pos();
		for (let i = 0; i < count; i++) {
			col++;
			let s = this.line(ln);
			if (col >= s.length && ln < this.lc() - 1) {
				ln++;
				col = 0;
				s = this.line(ln);
			}
			while (col < s.length && this.isWs(s[col])) col++;
			if (col >= s.length && ln < this.lc() - 1) {
				ln++;
				col = 0;
				s = this.line(ln);
				while (col < s.length && this.isWs(s[col])) col++;
			}
			s = this.line(ln);
			while (col < s.length - 1 && !this.isWs(s[col + 1])) col++;
		}
		return { line: ln, col };
	}

	private motionFindChar(char: string, dir: FindDir, count: number): Pos | null {
		const { col: startCol, line: ln } = this.pos();
		const s = this.line(ln);
		let col = startCol;
		for (let i = 0; i < count; i++) {
			if (dir === "f" || dir === "t") {
				col++;
				const idx = s.indexOf(char, col);
				if (idx === -1) return null;
				col = dir === "t" ? idx - 1 : idx;
			} else {
				col--;
				const idx = s.lastIndexOf(char, col);
				if (idx === -1) return null;
				col = dir === "T" ? idx + 1 : idx;
			}
		}
		return { line: ln, col };
	}

	// ─── Text range helpers ─────────────────────────────────────────────

	private getRange(a: Pos, b: Pos, linewise: boolean): string {
		if (linewise) {
			const s = Math.min(a.line, b.line);
			const e = Math.max(a.line, b.line);
			return this.es.lines.slice(s, e + 1).join("\n");
		}
		let [s, e] = a.line < b.line || (a.line === b.line && a.col <= b.col) ? [a, b] : [b, a];
		if (s.line === e.line) return this.line(s.line).slice(s.col, e.col + 1);
		let t = this.line(s.line).slice(s.col) + "\n";
		for (let i = s.line + 1; i < e.line; i++) t += this.line(i) + "\n";
		t += this.line(e.line).slice(0, e.col + 1);
		return t;
	}

	private deleteRangeImpl(a: Pos, b: Pos, linewise: boolean): void {
		const text = this.getRange(a, b, linewise);
		this.setReg('"', text, linewise);
		this.pushUndo();

		if (linewise) {
			const s = Math.min(a.line, b.line);
			const e = Math.max(a.line, b.line);
			this.es.lines.splice(s, e - s + 1);
			if (this.es.lines.length === 0) this.es.lines = [""];
			this.es.cursorLine = Math.min(s, this.es.lines.length - 1);
			this.es.cursorCol = this.firstNonBlank(this.es.cursorLine);
		} else {
			let [s, e] = a.line < b.line || (a.line === b.line && a.col <= b.col) ? [a, b] : [b, a];
			if (s.line === e.line) {
				const ln = this.line(s.line);
				this.es.lines[s.line] = ln.slice(0, s.col) + ln.slice(e.col + 1);
			} else {
				const first = this.line(s.line).slice(0, s.col);
				const last = this.line(e.line).slice(e.col + 1);
				this.es.lines.splice(s.line, e.line - s.line + 1, first + last);
			}
			this.es.cursorLine = s.line;
			this.es.cursorCol = Math.min(s.col, (this.es.lines[s.line] || "").length);
		}
		this.fireChange();
	}

	// ─── Register management ────────────────────────────────────────────

	private setReg(name: string, text: string, linewise: boolean): void {
		const reg = { text, linewise };
		if (name === '"') this.unnamedReg = reg;
		else this.namedRegs.set(name, reg);
	}

	private getReg(name: string): Register {
		if (name === '"') return this.unnamedReg;
		return this.namedRegs.get(name) || { text: "", linewise: false };
	}

	// ─── Apply motion (with optional pending operator) ──────────────────

	private applyMotion(target: Pos, inclusive: boolean, linewise: boolean): void {
		const start = this.pos();

		if (this.operator) {
			let end = { ...target };
			// For exclusive char motions, pull end back one
			if (!inclusive && !linewise) {
				if (end.line > start.line || end.col > start.col) {
					if (end.col > 0) end.col--;
					else if (end.line > 0) {
						end.line--;
						end.col = Math.max(0, this.line(end.line).length - 1);
					}
				}
			}

			switch (this.operator) {
				case "delete":
					this.deleteRangeImpl(start, end, linewise);
					break;
				case "change":
					this.deleteRangeImpl(start, end, linewise);
					if (linewise) {
						// After deleting lines for change, open an empty line
						this.es.lines.splice(this.es.cursorLine, 0, "");
						this.es.cursorCol = 0;
					}
					this.enterInsert("before");
					return;
				case "yank": {
					const text = this.getRange(start, end, linewise);
					this.setReg('"', text, linewise);
					const n = linewise ? Math.abs(end.line - start.line) + 1 + " lines" : text.length + " chars";
					this.showInfo(`${n} yanked`);
					break;
				}
			}
			this.resetPending();
		} else {
			this.setPos(target);
			this.resetPending();
		}
	}

	private applyOperatorLines(startLine: number, endLine: number): void {
		if (!this.operator) return;
		const s = { line: startLine, col: 0 };
		const e = { line: endLine, col: this.line(endLine).length };
		switch (this.operator) {
			case "delete":
				this.deleteRangeImpl(s, e, true);
				break;
			case "change":
				this.deleteRangeImpl(s, e, true);
				this.es.lines.splice(this.es.cursorLine, 0, "");
				this.es.cursorCol = 0;
				this.enterInsert("before");
				return;
			case "yank": {
				const text = this.getRange(s, e, true);
				this.setReg('"', text, true);
				this.showInfo(`${endLine - startLine + 1} lines yanked`);
				break;
			}
		}
		this.resetPending();
	}

	// ─── Mode transitions ───────────────────────────────────────────────

	private resetPending(): void {
		this.count = 0;
		this.operator = null;
		this.gPending = false;
	}

	private enterNormal(): void {
		const wasInsert = this.mode === "insert";
		this.mode = "normal";
		this.setCursorShape("normal");
		this.resetPending();
		this.visualAnchor = null;
		this.commandBuf = "";

		if (wasInsert) {
			// Cursor left one (vim convention)
			const ln = this.line();
			if (this.es.cursorCol > 0 && this.es.cursorCol >= ln.length) {
				this.es.cursorCol = Math.max(0, ln.length - 1);
			}
			// End change recording
			if (this.recording) {
				this.lastChangeKeys = [...this.changeKeys];
				this.recording = false;
				this.changeKeys = [];
			}
		}
	}

	private enterInsert(where: string): void {
		this.mode = "insert";
		this.setCursorShape("insert");
		this.resetPending();

		const ln = this.line();
		switch (where) {
			case "after":
				if (ln.length > 0) this.es.cursorCol = Math.min(this.es.cursorCol + 1, ln.length);
				break;
			case "lineStart":
				this.es.cursorCol = this.firstNonBlank(this.es.cursorLine);
				break;
			case "lineEnd":
				this.es.cursorCol = ln.length;
				break;
			case "newBelow":
				this.pushUndo();
				this.es.lines.splice(this.es.cursorLine + 1, 0, "");
				this.es.cursorLine++;
				this.es.cursorCol = 0;
				this.fireChange();
				break;
			case "newAbove":
				this.pushUndo();
				this.es.lines.splice(this.es.cursorLine, 0, "");
				this.es.cursorCol = 0;
				this.fireChange();
				break;
		}

		// Start change recording (for '.')
		if (!this.replaying) {
			this.recording = true;
			this.changeKeys = [];
		}
	}

	private enterVisual(type: "char" | "line"): void {
		if (this.mode === "visual" && type === "char") {
			this.enterNormal();
			return;
		}
		if (this.mode === "visual-line" && type === "line") {
			this.enterNormal();
			return;
		}
		this.mode = type === "line" ? "visual-line" : "visual";
		this.setCursorShape(this.mode);
		this.visualAnchor = this.pos();
		this.resetPending();
	}

	private enterCommand(): void {
		this.mode = "command";
		this.setCursorShape("command");
		this.commandBuf = "";
	}

	// ─── Submit the prompt ──────────────────────────────────────────────

	private submitPrompt(): void {
		const onSubmit = (this as any).onSubmit;
		if (!onSubmit || this.disableSubmit) return;

		let text = this.es.lines.join("\n").trim();
		// Expand paste markers
		const pastes = (this as any).pastes as Map<number, string> | undefined;
		if (pastes) {
			for (const [id, content] of pastes) {
				const re = new RegExp(`\\[paste #${id}( (\\+\\d+ lines|\\d+ chars))?\\]`, "g");
				text = text.replace(re, content);
			}
			pastes.clear();
		}

		if (!text) return;

		this.es.lines = [""];
		this.es.cursorLine = 0;
		this.es.cursorCol = 0;
		(this as any).pasteCounter = 0;
		(this as any).historyIndex = -1;
		(this as any).scrollOffset = 0;
		if (Array.isArray((this as any).undoStack)) (this as any).undoStack.length = 0;
		(this as any).lastAction = null;

		// Clear recovery buffer on successful submit
		clearRecoveryBuffer();

		const onChange = (this as any).onChange;
		if (onChange) onChange("");
		onSubmit(text);
	}

	// ─── Paste from register ────────────────────────────────────────────

	private paste(after: boolean): void {
		const reg = this.getReg('"');
		if (!reg.text) return;

		this.pushUndo();
		const count = this.ec();
		let text = "";
		for (let i = 0; i < count; i++) text += reg.text;

		if (reg.linewise) {
			const pasteLines = text.split("\n");
			if (after) {
				this.es.lines.splice(this.es.cursorLine + 1, 0, ...pasteLines);
				this.es.cursorLine++;
			} else {
				this.es.lines.splice(this.es.cursorLine, 0, ...pasteLines);
			}
			this.es.cursorCol = this.firstNonBlank(this.es.cursorLine);
		} else {
			const ln = this.line();
			const col = after ? Math.min(this.es.cursorCol + 1, ln.length) : this.es.cursorCol;
			const before = ln.slice(0, col);
			const afterText = ln.slice(col);
			const pasteLines = text.split("\n");

			if (pasteLines.length === 1) {
				this.es.lines[this.es.cursorLine] = before + text + afterText;
				this.es.cursorCol = col + text.length - 1;
			} else {
				this.es.lines.splice(
					this.es.cursorLine,
					1,
					before + pasteLines[0],
					...pasteLines.slice(1, -1),
					pasteLines[pasteLines.length - 1] + afterText,
				);
				this.es.cursorLine += pasteLines.length - 1;
				this.es.cursorCol = (pasteLines[pasteLines.length - 1] || "").length - 1;
			}
		}
		this.resetPending();
		this.fireChange();
	}

	// ─── Main input handler ─────────────────────────────────────────────

	handleInput(data: string): void {
		// Ctrl+Enter: submit from ANY mode
		if (matchesKey(data, "ctrl+enter")) {
			this.enterNormal();
			this.submitPrompt();
			return;
		}

		// Ctrl+C: act as Escape in vim (don't clear the editor)
		if (matchesKey(data, "ctrl+c")) {
			if (this.mode === "insert" || this.mode === "visual" || this.mode === "visual-line" || this.mode === "command") {
				this.enterNormal();
			} else if (this.mode === "replace-char" || this.mode === "find-char") {
				this.mode = "normal";
				this.setCursorShape("normal");
				this.resetPending();
			} else {
				// Normal mode: cancel any pending operator/count, absorb the key
				this.resetPending();
			}
			return;
		}

		// Record keys for repeat (.) while in insert mode
		if (this.recording && this.mode === "insert" && !this.replaying) {
			this.changeKeys.push(data);
		}

		// Schedule buffer save on any input
		this.scheduleSave();

		switch (this.mode) {
			case "insert":
				return this.onInsert(data);
			case "normal":
				return this.onNormal(data);
			case "visual":
			case "visual-line":
				return this.onVisual(data);
			case "replace-char":
				return this.onReplaceChar(data);
			case "find-char":
				return this.onFindChar(data);
			case "command":
				return this.onCommand(data);
		}
	}

	// ─── INSERT mode ────────────────────────────────────────────────────

	private onInsert(data: string): void {
		if (matchesKey(data, "escape")) {
			this.enterNormal();
			return;
		}
		// Enter → new line (not submit) in insert mode
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			super.handleInput("\x1b[13;2~"); // Kitty Shift+Enter → newLine
			return;
		}
		// Everything else (including Ctrl+C, Tab, autocomplete, etc.)
		super.handleInput(data);
	}

	// ─── NORMAL mode ────────────────────────────────────────────────────

	private onNormal(data: string): void {
		// --- g prefix ---
		if (this.gPending) {
			this.gPending = false;
			if (data === "g") {
				const n = this.count > 0 ? this.count - 1 : 0;
				this.applyMotion({ line: n, col: 0 }, false, this.operator ? true : false);
				if (!this.operator) this.es.cursorCol = this.firstNonBlank(this.es.cursorLine);
				return;
			}
			if (data === "e") {
				this.applyMotion(this.motionGe(this.ec()), true, false);
				return;
			}
			this.resetPending();
			return;
		}

		// --- Count accumulation ---
		if (data.length === 1) {
			const c = data.charCodeAt(0);
			if (c >= 49 && c <= 57) {
				this.count = this.count * 10 + (c - 48);
				return;
			}
			if (c === 48 && this.count > 0) {
				this.count = this.count * 10;
				return;
			}
		}

		// --- Operator-pending: doubled operator (dd, cc, yy) ---
		if (this.operator) {
			const opKey = this.operator === "delete" ? "d" : this.operator === "change" ? "c" : "y";
			if (data === opKey) {
				const n = this.ec();
				const end = Math.min(this.es.cursorLine + n - 1, this.lc() - 1);
				this.applyOperatorLines(this.es.cursorLine, end);
				return;
			}
		}

		// --- Dispatch single char ---
		if (data.length === 1) {
			switch (data) {
				// Movement
				case "h":
					return this.applyMotion({ line: this.es.cursorLine, col: this.es.cursorCol - 1 }, false, false);
				case "l":
					return this.applyMotion({ line: this.es.cursorLine, col: this.es.cursorCol + 1 }, false, false);
				case "j": {
					const n = this.ec();
					if (this.operator) return this.applyMotion({ line: this.es.cursorLine + n, col: this.es.cursorCol }, false, true);
					this.setPos({ line: this.es.cursorLine + n, col: this.es.cursorCol });
					this.resetPending();
					return;
				}
				case "k": {
					const n = this.ec();
					if (this.operator) return this.applyMotion({ line: this.es.cursorLine - n, col: this.es.cursorCol }, false, true);
					this.setPos({ line: this.es.cursorLine - n, col: this.es.cursorCol });
					this.resetPending();
					return;
				}
				case "w":
					return this.applyMotion(this.motionWordForward(this.ec()), false, false);
				case "b":
					return this.applyMotion(this.motionWordBackward(this.ec()), false, false);
				case "e":
					return this.applyMotion(this.motionWordEnd(this.ec()), true, false);
				case "W":
					return this.applyMotion(this.motionWORDForward(this.ec()), false, false);
				case "B":
					return this.applyMotion(this.motionWORDBackward(this.ec()), false, false);
				case "E":
					return this.applyMotion(this.motionWORDEnd(this.ec()), true, false);
				case "0":
					return this.applyMotion({ line: this.es.cursorLine, col: 0 }, false, false);
				case "$":
					return this.applyMotion(
						{ line: this.es.cursorLine, col: Math.max(0, this.line().length - 1) },
						true,
						false,
					);
				case "^":
					return this.applyMotion(
						{ line: this.es.cursorLine, col: this.firstNonBlank(this.es.cursorLine) },
						false,
						false,
					);
				case "G": {
					const n = this.count > 0 ? this.count - 1 : this.lc() - 1;
					if (this.operator) return this.applyMotion({ line: n, col: 0 }, false, true);
					this.setPos({ line: n, col: this.firstNonBlank(Math.min(n, this.lc() - 1)) });
					this.resetPending();
					return;
				}
				case "g":
					this.gPending = true;
					return;

				// Find char
				case "f":
					this.mode = "find-char";
					this.setCursorShape("find-char");
					this.findDir = "f";
					return;
				case "F":
					this.mode = "find-char";
					this.setCursorShape("find-char");
					this.findDir = "F";
					return;
				case "t":
					this.mode = "find-char";
					this.setCursorShape("find-char");
					this.findDir = "t";
					return;
				case "T":
					this.mode = "find-char";
					this.setCursorShape("find-char");
					this.findDir = "T";
					return;
				case ";":
					if (this.lastFind) {
						const t = this.motionFindChar(this.lastFind.char, this.lastFind.dir, this.ec());
						if (t) this.applyMotion(t, true, false);
						else this.resetPending();
					}
					return;
				case ",":
					if (this.lastFind) {
						const rev = ({ f: "F", F: "f", t: "T", T: "t" } as const)[this.lastFind.dir];
						const t = this.motionFindChar(this.lastFind.char, rev, this.ec());
						if (t) this.applyMotion(t, true, false);
						else this.resetPending();
					}
					return;

				// Insert entry points
				case "i":
					this.startChange("i");
					this.enterInsert("before");
					return;
				case "I":
					this.startChange("I");
					this.enterInsert("lineStart");
					return;
				case "a":
					this.startChange("a");
					this.enterInsert("after");
					return;
				case "A":
					this.startChange("A");
					this.enterInsert("lineEnd");
					return;
				case "o":
					this.startChange("o");
					this.enterInsert("newBelow");
					return;
				case "O":
					this.startChange("O");
					this.enterInsert("newAbove");
					return;

				// Operators
				case "d":
					this.operator = "delete";
					return;
				case "c":
					this.operator = "change";
					return;
				case "y":
					this.operator = "yank";
					return;

				// Quick actions
				case "x": {
					const n = this.ec();
					const ln = this.line();
					if (ln.length > 0) {
						const end = Math.min(this.es.cursorCol + n - 1, ln.length - 1);
						this.deleteRangeImpl(
							this.pos(),
							{ line: this.es.cursorLine, col: end },
							false,
						);
					}
					this.resetPending();
					return;
				}
				case "X": {
					const n = this.ec();
					if (this.es.cursorCol > 0) {
						const start = Math.max(0, this.es.cursorCol - n);
						this.deleteRangeImpl(
							{ line: this.es.cursorLine, col: start },
							{ line: this.es.cursorLine, col: this.es.cursorCol - 1 },
							false,
						);
					}
					this.resetPending();
					return;
				}
				case "D": {
					const ln = this.line();
					if (this.es.cursorCol < ln.length) {
						this.deleteRangeImpl(
							this.pos(),
							{ line: this.es.cursorLine, col: ln.length - 1 },
							false,
						);
					}
					this.resetPending();
					return;
				}
				case "C": {
					const ln = this.line();
					if (this.es.cursorCol < ln.length) {
						this.deleteRangeImpl(
							this.pos(),
							{ line: this.es.cursorLine, col: ln.length - 1 },
							false,
						);
					}
					this.startChange("C");
					this.enterInsert("before");
					return;
				}
				case "Y": {
					const n = this.ec();
					const end = Math.min(this.es.cursorLine + n - 1, this.lc() - 1);
					const text = this.getRange(
						{ line: this.es.cursorLine, col: 0 },
						{ line: end, col: this.line(end).length },
						true,
					);
					this.setReg('"', text, true);
					this.showInfo(`${n} line${n > 1 ? "s" : ""} yanked`);
					this.resetPending();
					return;
				}

				case "p":
					return this.paste(true);
				case "P":
					return this.paste(false);

				case "u":
					if (this.popUndo()) this.showInfo("undo");
					this.resetPending();
					return;

				case "r":
					this.mode = "replace-char";
					this.setCursorShape("replace-char");
					return;

				case "J": {
					const n = this.ec();
					this.pushUndo();
					for (let i = 0; i < n; i++) {
						if (this.es.cursorLine < this.lc() - 1) {
							const cur = this.line();
							const next = this.line(this.es.cursorLine + 1).trimStart();
							const sep = cur.length > 0 ? " " : "";
							this.es.lines[this.es.cursorLine] = cur + sep + next;
							this.es.lines.splice(this.es.cursorLine + 1, 1);
							this.es.cursorCol = cur.length;
						}
					}
					this.resetPending();
					this.fireChange();
					return;
				}

				case ".":
					return this.repeatLastChange();

				// Visual mode
				case "v":
					return this.enterVisual("char");
				case "V":
					return this.enterVisual("line");

				// Command mode
				case ":":
					return this.enterCommand();

				// ~ : toggle case
				case "~": {
					const ln = this.line();
					if (this.es.cursorCol < ln.length) {
						this.pushUndo();
						const ch = ln[this.es.cursorCol];
						const toggled = ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
						this.es.lines[this.es.cursorLine] =
							ln.slice(0, this.es.cursorCol) + toggled + ln.slice(this.es.cursorCol + 1);
						if (this.es.cursorCol < ln.length - 1) this.es.cursorCol++;
						this.fireChange();
					}
					this.resetPending();
					return;
				}
			}
		}

		// --- Arrow keys (for users who reach for them by habit) ---
		if (matchesKey(data, "up")) {
			this.setPos({ line: this.es.cursorLine - 1, col: this.es.cursorCol });
			this.resetPending();
			return;
		}
		if (matchesKey(data, "down")) {
			this.setPos({ line: this.es.cursorLine + 1, col: this.es.cursorCol });
			this.resetPending();
			return;
		}
		if (matchesKey(data, "left")) {
			this.setPos({ line: this.es.cursorLine, col: this.es.cursorCol - 1 });
			this.resetPending();
			return;
		}
		if (matchesKey(data, "right")) {
			this.setPos({ line: this.es.cursorLine, col: this.es.cursorCol + 1 });
			this.resetPending();
			return;
		}

		// --- Special keys ---
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			this.submitPrompt();
			return;
		}
		if (matchesKey(data, "escape")) {
			if (this.operator || this.gPending) {
				this.resetPending();
				return;
			}
			// Pass to app (abort agent)
			super.handleInput(data);
			return;
		}
		// Note: Ctrl+C is handled globally in handleInput() as Esc

		// Forward unhandled non-printable keys to base editor for app-level keybindings
		// (model selector, thinking level, tool expansion, etc.)
		if (data.length !== 1 || data.charCodeAt(0) < 32) {
			super.handleInput(data);
		}
	}

	// ─── ge motion helper ───────────────────────────────────────────────

	private motionGe(count: number): Pos {
		let p = this.pos();
		for (let i = 0; i < count; i++) {
			// Go back to previous word end
			if (p.col === 0) {
				if (p.line > 0) {
					p.line--;
					p.col = Math.max(0, this.line(p.line).length - 1);
				}
				continue;
			}
			p.col--;
			const s = this.line(p.line);
			while (p.col >= 0 && this.isWs(s[p.col])) p.col--;
			if (p.col < 0) {
				if (p.line > 0) {
					p.line--;
					p.col = Math.max(0, this.line(p.line).length - 1);
				} else {
					p.col = 0;
				}
			}
		}
		return p;
	}

	// ─── Change recording for . ─────────────────────────────────────────

	private startChange(entryKey: string): void {
		if (!this.replaying) {
			this.recording = true;
			this.changeKeys = [entryKey];
		}
	}

	private repeatLastChange(): void {
		if (this.lastChangeKeys.length === 0) return;
		this.replaying = true;
		for (const key of this.lastChangeKeys) {
			this.handleInput(key);
		}
		this.replaying = false;
		this.resetPending();
	}

	// ─── FIND-CHAR mode ─────────────────────────────────────────────────

	private onFindChar(data: string): void {
		this.mode = "normal";
		this.setCursorShape("normal");
		if (matchesKey(data, "escape")) {
			this.resetPending();
			return;
		}
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.lastFind = { char: data, dir: this.findDir };
			const target = this.motionFindChar(data, this.findDir, this.ec());
			if (target) this.applyMotion(target, true, false);
			else this.resetPending();
		} else {
			this.resetPending();
		}
	}

	// ─── REPLACE-CHAR mode ──────────────────────────────────────────────

	private onReplaceChar(data: string): void {
		this.mode = "normal";
		this.setCursorShape("normal");
		if (matchesKey(data, "escape")) {
			this.resetPending();
			return;
		}
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			const n = this.ec();
			const ln = this.line();
			if (this.es.cursorCol + n <= ln.length) {
				this.pushUndo();
				let result = ln.slice(0, this.es.cursorCol);
				for (let i = 0; i < n; i++) result += data;
				result += ln.slice(this.es.cursorCol + n);
				this.es.lines[this.es.cursorLine] = result;
				this.es.cursorCol = Math.min(this.es.cursorCol + n - 1, result.length - 1);
				this.fireChange();
			}
		}
		this.resetPending();
	}

	// ─── VISUAL mode ────────────────────────────────────────────────────

	private onVisual(data: string): void {
		const isLinewise = this.mode === "visual-line";

		if (matchesKey(data, "escape")) {
			this.enterNormal();
			return;
		}

		// Toggle visual type
		if (data === "v") {
			if (this.mode === "visual") return this.enterNormal();
			this.mode = "visual";
			if (!this.visualAnchor) this.visualAnchor = this.pos();
			return;
		}
		if (data === "V") {
			if (this.mode === "visual-line") return this.enterNormal();
			this.mode = "visual-line";
			if (!this.visualAnchor) this.visualAnchor = this.pos();
			return;
		}

		// g prefix
		if (this.gPending) {
			this.gPending = false;
			if (data === "g") this.setPos({ line: 0, col: 0 });
			return;
		}

		// Movement
		switch (data) {
			case "h":
				this.setPos({ line: this.es.cursorLine, col: this.es.cursorCol - 1 });
				return;
			case "l":
				this.setPos({ line: this.es.cursorLine, col: this.es.cursorCol + 1 });
				return;
			case "j":
				this.setPos({ line: this.es.cursorLine + 1, col: this.es.cursorCol });
				return;
			case "k":
				this.setPos({ line: this.es.cursorLine - 1, col: this.es.cursorCol });
				return;
			case "w":
				this.setPos(this.motionWordForward(1));
				return;
			case "b":
				this.setPos(this.motionWordBackward(1));
				return;
			case "e":
				this.setPos(this.motionWordEnd(1));
				return;
			case "0":
				this.es.cursorCol = 0;
				return;
			case "$":
				this.es.cursorCol = Math.max(0, this.line().length - 1);
				return;
			case "^":
				this.es.cursorCol = this.firstNonBlank(this.es.cursorLine);
				return;
			case "G":
				this.setPos({ line: this.lc() - 1, col: 0 });
				return;
			case "g":
				this.gPending = true;
				return;
		}

		// Operations on selection
		const anchor = this.visualAnchor || this.pos();
		const cursor = this.pos();

		switch (data) {
			case "d":
			case "x":
				this.deleteRangeImpl(anchor, cursor, isLinewise);
				this.enterNormal();
				return;
			case "c":
				this.deleteRangeImpl(anchor, cursor, isLinewise);
				this.enterInsert("before");
				return;
			case "y": {
				const text = this.getRange(anchor, cursor, isLinewise);
				this.setReg('"', text, isLinewise);
				const minPos =
					anchor.line < cursor.line || (anchor.line === cursor.line && anchor.col < cursor.col)
						? anchor
						: cursor;
				this.setPos(minPos);
				this.showInfo(isLinewise ? `${Math.abs(cursor.line - anchor.line) + 1} lines yanked` : `${text.length} chars yanked`);
				this.enterNormal();
				return;
			}
			case "J": {
				const sLine = Math.min(anchor.line, cursor.line);
				const eLine = Math.max(anchor.line, cursor.line);
				this.pushUndo();
				for (let i = sLine; i < eLine && sLine < this.lc() - 1; i++) {
					const cur = this.line(sLine);
					const next = this.line(sLine + 1).trimStart();
					this.es.lines[sLine] = cur + (cur ? " " : "") + next;
					this.es.lines.splice(sLine + 1, 1);
				}
				this.es.cursorLine = sLine;
				this.fireChange();
				this.enterNormal();
				return;
			}
			case "~": {
				const sPos =
					anchor.line < cursor.line || (anchor.line === cursor.line && anchor.col <= cursor.col)
						? anchor
						: cursor;
				const ePos =
					anchor.line < cursor.line || (anchor.line === cursor.line && anchor.col <= cursor.col)
						? cursor
						: anchor;
				this.pushUndo();
				for (let ln = sPos.line; ln <= ePos.line; ln++) {
					const s = this.line(ln);
					const startCol = ln === sPos.line ? sPos.col : 0;
					const endCol = ln === ePos.line ? ePos.col : s.length - 1;
					let result = "";
					for (let c = 0; c < s.length; c++) {
						if (c >= startCol && c <= endCol) {
							const ch = s[c];
							result += ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
						} else {
							result += s[c];
						}
					}
					this.es.lines[ln] = result;
				}
				this.fireChange();
				this.enterNormal();
				return;
			}
			case ">": {
				const sLine = Math.min(anchor.line, cursor.line);
				const eLine = Math.max(anchor.line, cursor.line);
				this.pushUndo();
				for (let i = sLine; i <= eLine; i++) {
					this.es.lines[i] = "  " + this.es.lines[i];
				}
				this.fireChange();
				this.enterNormal();
				return;
			}
			case "<": {
				const sLine = Math.min(anchor.line, cursor.line);
				const eLine = Math.max(anchor.line, cursor.line);
				this.pushUndo();
				for (let i = sLine; i <= eLine; i++) {
					this.es.lines[i] = this.es.lines[i].replace(/^  /, "");
				}
				this.fireChange();
				this.enterNormal();
				return;
			}
		}
	}

	// ─── COMMAND mode ───────────────────────────────────────────────────

	private onCommand(data: string): void {
		if (matchesKey(data, "escape")) {
			this.enterNormal();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			this.execCommand(this.commandBuf.trim());
			this.enterNormal();
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (this.commandBuf.length > 0) this.commandBuf = this.commandBuf.slice(0, -1);
			else this.enterNormal();
			return;
		}
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.commandBuf += data;
		}
	}

	private execCommand(cmd: string): void {
		switch (cmd) {
			case "w":
			case "wq":
			case "send":
				this.submitPrompt();
				break;
			case "q":
			case "q!": {
				const handler = (this as any).onCtrlD;
				if (handler) handler();
				break;
			}
			case "noh":
			case "nohlsearch":
				this.showInfo("search cleared");
				break;
			default:
				if (/^\d+$/.test(cmd)) {
					// :42 → go to line 42
					const n = parseInt(cmd, 10) - 1;
					this.setPos({ line: n, col: this.firstNonBlank(Math.min(n, this.lc() - 1)) });
				} else {
					this.showInfo(`E492: Not an editor command: ${cmd}`);
				}
				break;
		}
	}

	// ─── Render (mode indicator on bottom border) ───────────────────────

	render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;

		// Strip the software cursor (reverse video block) from rendered output.
		// The base Editor renders the cursor as \x1b[7m<char>\x1b[0m. We remove
		// the reverse video escapes (keeping the character) so the hardware cursor
		// (whose shape we control via DECSCUSR) is the only visible cursor.
		// The CURSOR_MARKER is preserved for the TUI to position the hardware cursor.
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].includes("\x1b[7m")) {
				lines[i] = lines[i].replace(/\x1b\[7m([\s\S]+?)\x1b\[0m/, "$1");
			}
		}

		// Build mode label
		let label: string;
		let style: string;
		switch (this.mode) {
			case "normal":
				label = " NORMAL ";
				style = S.normal;
				break;
			case "insert":
				label = " INSERT ";
				style = S.insert;
				break;
			case "visual":
				label = " VISUAL ";
				style = S.visual;
				break;
			case "visual-line":
				label = " V-LINE ";
				style = S.visual;
				break;
			case "command":
				label = ` :${this.commandBuf}█ `;
				style = S.command;
				break;
			case "replace-char":
				label = " REPLACE ";
				style = S.replace;
				break;
			case "find-char":
				label = ` ${this.findDir}_ `;
				style = S.find;
				break;
			default:
				label = "";
				style = "";
		}

		// Build extras (pending operator, count, info)
		let extra = "";
		if (this.count > 0 && this.mode === "normal") extra += S.dim + ` ${this.count}` + S.R;
		if (this.operator) extra += S.dim + ` ${this.operator[0]}…` + S.R;
		if (this.infoMsg) extra += S.dim + ` ${this.infoMsg}` + S.R;

		const styled = style + label + S.R + extra;
		const styledWidth = visibleWidth(styled);

		// Find bottom border line (search from bottom for ─)
		let borderIdx = -1;
		for (let i = lines.length - 1; i >= 0; i--) {
			if (lines[i].includes("─")) {
				borderIdx = i;
				break;
			}
		}
		if (borderIdx === -1) borderIdx = lines.length - 1;

		if (styledWidth < width) {
			lines[borderIdx] = truncateToWidth(lines[borderIdx], width - styledWidth, "") + styled;
		}

		return lines;
	}
}

// ─── Utility ────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, v));
}

// ─── Extension entry point ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let vimEnabled = true;
	let activeTui: TUI | null = null;

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI || !vimEnabled) return;
		ctx.ui.setEditorComponent((tui, theme, kb) => {
			activeTui = tui;
			return new VimEditor(tui, theme, kb);
		});
		ctx.ui.setStatus("vim", "\x1b[1;44;97m VIM \x1b[0m");
	});

	pi.on("session_shutdown", () => {
		// Restore terminal cursor to default on shutdown
		// Write directly to stdout since we may not have UI context
		process.stdout.write(CURSOR.default);
		if (activeTui) activeTui.setShowHardwareCursor(false);
	});

	pi.registerCommand("vim", {
		description: "Enable vim mode",
		handler: async (_args, ctx) => {
			vimEnabled = true;
			ctx.ui.setEditorComponent((tui, theme, kb) => {
				activeTui = tui;
				return new VimEditor(tui, theme, kb);
			});
			ctx.ui.setStatus("vim", "\x1b[1;44;97m VIM \x1b[0m");
			ctx.ui.notify("Vim mode enabled", "info");
		},
	});

	pi.registerCommand("novim", {
		description: "Disable vim mode, restore default editor",
		handler: async (_args, ctx) => {
			vimEnabled = false;
			ctx.ui.setEditorComponent(undefined);
			ctx.ui.setStatus("vim", undefined);
			// Restore cursor shape to terminal default
			process.stdout.write(CURSOR.default);
			// Re-hide hardware cursor — default editor uses software (reverse video) cursor
			if (activeTui) activeTui.setShowHardwareCursor(false);
			activeTui = null;
			ctx.ui.notify("Default editor restored", "info");
		},
	});

	pi.registerCommand("vim-recover", {
		description: "Recover text from the last unsaved editor buffer",
		handler: async (_args, ctx) => {
			const text = loadRecoveryBuffer();
			if (text && text.trim()) {
				ctx.ui.notify(`Recovery buffer available (${text.split("\n").length} lines). Restoring...`, "info");
				// The VimEditor constructor handles recovery on reload
			} else {
				ctx.ui.notify("No recovery buffer found", "info");
			}
		},
	});
}
