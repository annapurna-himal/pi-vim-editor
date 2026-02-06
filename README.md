# pi-vim-editor

A vim-like modal editor extension for [Pi](https://github.com/badlogic/pi-mono), the coding agent by [@badlogic](https://github.com/badlogic).

Replaces Pi's default Emacs-flavored text input with proper vim modal editing.

## Install

Copy the extension into your Pi extensions directory:

```bash
# Clone
git clone git@github.com:annapurna-himal/pi-vim-editor.git

# Symlink into Pi extensions
ln -s "$(pwd)/pi-vim-editor" ~/.pi/agent/extensions/vim-editor

# Or just copy the file
mkdir -p ~/.pi/agent/extensions/vim-editor
cp pi-vim-editor/index.ts ~/.pi/agent/extensions/vim-editor/
```

Then `/reload` in Pi (or restart).

## Usage

The extension loads automatically. You start in **NORMAL** mode.

```
/vim      → enable vim mode (on by default)
/novim    → restore default editor
```

### Submitting Prompts

| Context | Action |
|---------|--------|
| Normal mode | `Enter` submits |
| Insert mode | `Enter` adds a new line |
| Command mode | `:w` or `:send` submits |
| Command mode | `:q` exits Pi |

**Typical flow:** type in insert mode → `Esc` → `Enter` to send.

## Modes

| Mode | Badge | Enter with | Exit with |
|------|-------|-----------|-----------|
| **NORMAL** | `NORMAL` (blue) | `Esc` | — |
| **INSERT** | `INSERT` (green) | `i` `a` `o` `A` `I` `O` | `Esc` |
| **VISUAL** | `VISUAL` (purple) | `v` | `Esc` |
| **V-LINE** | `V-LINE` (purple) | `V` | `Esc` |
| **COMMAND** | `:cmd` (yellow) | `:` | `Enter` / `Esc` |

## Keybindings

### Movement

| Key | Action |
|-----|--------|
| `h` `j` `k` `l` | Left, down, up, right |
| `w` `b` `e` | Word forward / backward / end |
| `W` `B` `E` | WORD (whitespace-delimited) |
| `0` `$` `^` | Line start / end / first non-blank |
| `G` / `gg` | End / start of buffer |
| `f{c}` `F{c}` | Find char forward / backward |
| `t{c}` `T{c}` | Till char forward / backward |
| `;` `,` | Repeat / reverse last find |
| Arrow keys | Also work (no judgment) |

### Operators

| Key | Action |
|-----|--------|
| `d` + motion | Delete (e.g., `dw`, `d$`, `d0`) |
| `c` + motion | Change (delete + enter insert) |
| `y` + motion | Yank (copy) |
| `dd` `cc` `yy` | Operate on whole line |

### Actions

| Key | Action |
|-----|--------|
| `x` / `X` | Delete char forward / backward |
| `D` / `C` | Delete / change to end of line |
| `Y` | Yank whole line |
| `p` / `P` | Paste after / before |
| `u` | Undo |
| `J` | Join lines |
| `r{c}` | Replace character |
| `~` | Toggle case |
| `.` | Repeat last change |

### Counts

Prefix any command: `3w` (3 words), `5dd` (delete 5 lines), `2fa` (find 2nd 'a').

### Visual Mode

Enter with `v` (char) or `V` (line), move to select, then:

| Key | Action |
|-----|--------|
| `d` / `x` | Delete selection |
| `c` | Change selection |
| `y` | Yank selection |
| `J` | Join selected lines |
| `~` | Toggle case |
| `>` / `<` | Indent / dedent |

### Command Mode

| Command | Action |
|---------|--------|
| `:w` / `:send` | Submit prompt |
| `:q` | Exit Pi |
| `:42` | Go to line 42 |

## Not Yet Implemented

- Text objects (`iw`, `aw`, `i"`, `a{`)
- Search (`/pattern`, `n`, `N`)
- Macros (`q`/`@`)
- Marks (`m`/`'`)
- Named registers (`"a`, `"b`)
- Visual selection highlighting
- Indent operators (`>>`, `<<`)

## How It Works

- Extends Pi's `CustomEditor` class (which extends `Editor`)
- Intercepts `handleInput()` and routes by vim mode
- Insert mode delegates to the base editor, so **autocomplete, Tab completion, and clipboard paste all work normally**
- Manipulates the editor's internal state directly for vim operations
- Integrates with the editor's undo stack
- Renders a styled mode indicator on the bottom border

## Author

Built by [Annapurna](https://github.com/annapurna-himal) 🏔️

## License

MIT
