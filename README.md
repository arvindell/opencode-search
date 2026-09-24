# opencode-search

Search your OpenCode sessions with full text & fuzzy search; with message and file matching

## Install

Clone this repository, then link its source directory into OpenCode's global plugins folder:

```sh
mkdir -p ~/.config/opencode/plugins
ln -s "$(pwd)/src" ~/.config/opencode/plugins/opencode-search
```

Restart OpenCode, then run `/search` (or `/search terms`). Search starts in the current project; **Ctrl+A** toggles all projects. Use **↑/↓** to browse, **Enter** to open, **Ctrl+F** to pin, **Ctrl+R** to rename, and **Ctrl+D** twice to delete.

The first transcript search builds a local SQLite index. Subsequent searches update changed sessions.
