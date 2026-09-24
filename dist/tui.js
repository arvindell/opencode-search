// @bun
// src/tui.ts
import { Plugin } from "@opencode/plugin/tui";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";

// src/message-text.ts
function searchableText(input) {
  const message = input;
  const text = [];
  const add = (value) => {
    if (typeof value === "string" && value && !value.startsWith("data:"))
      text.push(value);
  };
  const strings = (value) => {
    if (typeof value === "string")
      return add(value);
    if (Array.isArray(value))
      return value.forEach(strings);
    if (!value || typeof value !== "object")
      return;
    for (const [key, field] of Object.entries(value)) {
      if (/base64|image|binary|credential|token|secret/i.test(key))
        continue;
      strings(field);
    }
  };
  if (message.type === "user" || message.type === "synthetic" || message.type === "system")
    add(message.text);
  if (message.type === "user")
    for (const file of message.files ?? []) {
      add(file.name);
      add(file.uri);
      add(file.description);
    }
  if (message.type === "shell") {
    add(message.command);
    add(message.output);
  }
  if (message.type === "compaction") {
    add(message.summary);
    add(message.recent);
  }
  if (message.type === "assistant") {
    for (const file of message.snapshot?.files ?? [])
      add(file);
    for (const part of message.content ?? []) {
      if (part.type === "text")
        add(part.text);
      if (part.type !== "tool")
        continue;
      strings(part.state?.input);
      for (const content of part.state?.content ?? []) {
        if (content.type === "text")
          add(content.text);
        add(content.name);
        add(content.uri);
      }
      for (const attachment of part.state?.attachments ?? []) {
        add(attachment.name);
        add(attachment.uri);
      }
      for (const path of part.state?.outputPaths ?? [])
        add(path);
    }
  }
  return text;
}

// src/picker.tsx
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { use as _$use } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { RGBA, TextAttributes } from "@opentui/core";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount } from "solid-js";
var debounceMs = 180;
var matchColor = RGBA.fromHex("#facc15");
function ellipsize(text, width) {
  const characters = Array.from(text);
  return characters.length > width ? `${characters.slice(0, width - 1).join("").trimEnd()}\u2026` : text;
}
function highlighted(text, query, color) {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length)
    return text;
  const pattern = new RegExp(`(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(pattern).map((part) => words.includes(part.toLowerCase()) ? (() => {
    var _el$ = _$createElement("span");
    _$insert(_el$, part);
    _$effect((_$p) => _$setProp(_el$, "style", {
      fg: color,
      attributes: TextAttributes.BOLD
    }, _$p));
    return _el$;
  })() : part);
}
function SessionPicker(props) {
  const context = props.context;
  const theme = context.theme;
  const [pins, updatePins] = context.storage.store("search-sessions.pins", {
    initial: {
      ids: []
    }
  });
  const [dimensions, setDimensions] = createSignal({
    width: context.renderer.width,
    height: context.renderer.height
  });
  const resize = (width, height) => setDimensions({
    width,
    height
  });
  onMount(() => {
    context.renderer.on("resize", resize);
    onCleanup(() => context.renderer.off("resize", resize));
  });
  const leftWidth = () => Math.min(55, Math.max(30, Math.floor((Math.min(dimensions().width - 2, 116) - 4) / 2)));
  const rightWidth = () => Math.max(8, Math.min(dimensions().width - 2, 116) - leftWidth() - 4);
  const bodyHeight = () => Math.max(8, Math.min(25, Math.floor(dimensions().height * 0.75) - 10));
  const visibleRows = bodyHeight;
  const matchesHeight = () => Math.max(2, Math.min(5, Math.floor(bodyHeight() / 5)));
  const timelineHeight = () => bodyHeight() - matchesHeight() - 3;
  const [query, setQuery] = createSignal(props.initial);
  const [all, setAll] = createSignal(props.all);
  const [results, setResults] = createSignal(props.initial ? [] : props.all);
  const [global, setGlobal] = createSignal(false);
  const items = createMemo(() => {
    const pinned = new Set(pins.ids);
    return results().filter((item) => global() || item.projectID === props.projectID).toSorted((a, b) => Number(pinned.has(b.value)) - Number(pinned.has(a.value)));
  });
  const [selected, setSelected] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [toDelete, setToDelete] = createSignal();
  const [actionBusy, setActionBusy] = createSignal(false);
  const [details, setDetails] = createSignal();
  const [detailsBusy, setDetailsBusy] = createSignal(false);
  const [detailsError, setDetailsError] = createSignal("");
  const timelineLines = createMemo(() => {
    const info = details();
    const lines = info?.timeline ?? [];
    const height = timelineHeight();
    if (!info || info.userCount + info.assistantCount <= height)
      return lines;
    const first = Math.ceil((height - 1) / 2);
    const last = height - first - 1;
    const visible = [...lines.slice(0, first), ...lines.slice(-last)];
    const users = info.userCount - visible.filter((line) => line.role === "You").length;
    const assistants = info.assistantCount - visible.filter((line) => line.role === "Assistant").length;
    const count = (amount, role) => `${amount} more ${role} message${amount === 1 ? "" : "s"}`;
    const folded = {
      text: [users && count(users, "user"), assistants && count(assistants, "assistant")].filter(Boolean).join(" \xB7 "),
      time: 0
    };
    return [...lines.slice(0, first), folded, ...lines.slice(-last)];
  });
  const detailsCache = new Map;
  let timer;
  let active;
  let input;
  let generation = 0;
  let mouse = false;
  const start = createMemo(() => Math.max(0, Math.min(selected() - Math.floor(visibleRows() / 2), items().length - visibleRows())));
  const visible = createMemo(() => items().slice(start(), start() + visibleRows()));
  function update(value) {
    const current = ++generation;
    if (timer)
      clearTimeout(timer);
    active?.abort();
    setQuery(value);
    setSelected(0);
    setToDelete(undefined);
    setError("");
    if (!value.trim()) {
      setBusy(false);
      setResults(all());
      return;
    }
    setBusy(true);
    setResults([]);
    timer = setTimeout(() => {
      const controller = new AbortController;
      active = controller;
      props.search(value, controller.signal).then((results) => {
        if (current !== generation)
          return;
        setResults(results);
        setBusy(false);
      }, (reason) => {
        if (current !== generation)
          return;
        setBusy(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    }, debounceMs);
  }
  if (props.initial.trim())
    timer = setTimeout(() => update(props.initial), 0);
  createEffect(() => {
    const id = items()[selected()]?.value;
    if (toDelete() && toDelete() !== id)
      setToDelete(undefined);
  });
  createEffect(() => {
    const id = items()[selected()]?.value;
    const value = query();
    setDetails(undefined);
    setDetailsError("");
    if (!id) {
      setDetailsBusy(false);
      return;
    }
    const key = `${id}\x00${value.trim()}`;
    const cached = detailsCache.get(key);
    if (cached) {
      setDetails(cached);
      setDetailsBusy(false);
      return;
    }
    setDetailsBusy(true);
    const controller = new AbortController;
    const pending = setTimeout(() => {
      props.details(id, value, controller.signal).then((result) => {
        if (controller.signal.aborted)
          return;
        detailsCache.set(key, result);
        if (detailsCache.size > 30)
          detailsCache.delete(detailsCache.keys().next().value);
        setDetails(result);
        setDetailsBusy(false);
      }, (error) => {
        if (controller.signal.aborted)
          return;
        setDetailsError(error instanceof Error ? error.message : String(error));
        setDetailsBusy(false);
      });
    }, 75);
    onCleanup(() => {
      clearTimeout(pending);
      controller.abort();
    });
  });
  onCleanup(() => {
    generation++;
    if (timer)
      clearTimeout(timer);
    active?.abort();
  });
  const move = (offset) => {
    mouse = false;
    setSelected((index) => Math.max(0, Math.min(items().length - 1, index + offset)));
  };
  const choose = () => {
    const item = items()[selected()];
    if (item && !actionBusy())
      props.onChoose(item.value);
  };
  const toggleScope = () => {
    setGlobal((value) => !value);
    setSelected(0);
    setToDelete(undefined);
  };
  const togglePin = async () => {
    const item = items()[selected()];
    if (!item || actionBusy())
      return;
    try {
      await updatePins((draft) => {
        draft.ids = draft.ids.includes(item.value) ? draft.ids.filter((id) => id !== item.value) : [...draft.ids, item.value];
      });
      setSelected(items().findIndex((entry) => entry.value === item.value));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const rename = async () => {
    const item = items()[selected()];
    if (!item || actionBusy())
      return;
    setActionBusy(true);
    try {
      const title = await context.ui.dialog.prompt({
        title: "Rename session",
        value: item.title
      });
      context.ui.dialog.set({
        size: "xlarge",
        centered: true
      });
      if (!title?.trim() || title.trim() === item.title)
        return;
      const updated = await props.rename(item, title.trim());
      setAll((list) => list.map((entry) => entry.value === item.value ? updated : entry));
      setResults((list) => list.map((entry) => entry.value === item.value ? updated : entry));
      if (query().trim())
        update(query());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setActionBusy(false);
    }
  };
  const remove = async () => {
    const item = items()[selected()];
    if (!item || actionBusy())
      return;
    if (toDelete() !== item.value) {
      setToDelete(item.value);
      return;
    }
    setToDelete(undefined);
    setActionBusy(true);
    try {
      const removed = new Set(await props.delete(item));
      setAll((list) => list.filter((entry) => !removed.has(entry.value)));
      setResults((list) => list.filter((entry) => !removed.has(entry.value)));
      await updatePins((draft) => {
        draft.ids = draft.ids.filter((id) => !removed.has(id));
      });
      setSelected((index) => Math.max(0, Math.min(index, items().length - 1)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setActionBusy(false);
    }
  };
  const keypress = (event) => {
    if (!event.ctrl || context.renderer.currentFocusedRenderable !== input)
      return;
    if (event.name === "a") {
      event.preventDefault();
      toggleScope();
    }
    if (event.name === "f") {
      event.preventDefault();
      togglePin();
    }
    if (event.name === "d") {
      event.preventDefault();
      remove();
    }
    if (event.name === "r") {
      event.preventDefault();
      rename();
    }
  };
  onMount(() => {
    context.renderer.keyInput.on("keypress", keypress);
    onCleanup(() => context.renderer.keyInput.off("keypress", keypress));
  });
  context.keymap.layer(() => ({
    mode: "global",
    priority: 100,
    commands: [{
      id: "search-sessions.picker.up",
      bind: "up",
      run: () => move(-1)
    }, {
      id: "search-sessions.picker.down",
      bind: "down",
      run: () => move(1)
    }, {
      id: "search-sessions.picker.page-up",
      bind: "pageup",
      run: () => move(-visibleRows())
    }, {
      id: "search-sessions.picker.page-down",
      bind: "pagedown",
      run: () => move(visibleRows())
    }, {
      id: "search-sessions.picker.home",
      bind: "home",
      run: () => setSelected(0)
    }, {
      id: "search-sessions.picker.end",
      bind: "end",
      run: () => setSelected(Math.max(0, items().length - 1))
    }, {
      id: "search-sessions.picker.choose",
      bind: "return",
      run: choose
    }],
    bindings: ["search-sessions.picker.up", "search-sessions.picker.down", "search-sessions.picker.page-up", "search-sessions.picker.page-down", "search-sessions.picker.home", "search-sessions.picker.end", "search-sessions.picker.choose"]
  }));
  return (() => {
    var _el$2 = _$createElement("box"), _el$3 = _$createElement("text"), _el$4 = _$createElement("input"), _el$5 = _$createElement("text"), _el$6 = _$createElement("box"), _el$7 = _$createElement("box"), _el$8 = _$createElement("box"), _el$9 = _$createElement("box"), _el$0 = _$createElement("text"), _el$1 = _$createElement("text"), _el$10 = _$createTextNode(`Timeline \xB7 `), _el$11 = _$createTextNode(` user \xB7 `), _el$13 = _$createTextNode(` assistant`), _el$14 = _$createElement("box"), _el$15 = _$createElement("text"), _el$16 = _$createTextNode(`Matches \xB7 `), _el$17 = _$createTextNode(` messages`), _el$18 = _$createElement("scrollbox"), _el$19 = _$createElement("text"), _el$20 = _$createTextNode(`\u2191\u2193 select \xB7 Enter open \xB7 Ctrl+F pin \xB7 Ctrl+D delete \xB7 Ctrl+R rename \xB7 Ctrl+A `), _el$21 = _$createTextNode(` \xB7 Esc`);
    _$insertNode(_el$2, _el$3);
    _$insertNode(_el$2, _el$4);
    _$insertNode(_el$2, _el$5);
    _$insertNode(_el$2, _el$6);
    _$insertNode(_el$2, _el$19);
    _$setProp(_el$2, "flexDirection", "column");
    _$setProp(_el$2, "paddingLeft", 1);
    _$setProp(_el$2, "paddingRight", 1);
    _$setProp(_el$2, "paddingBottom", 1);
    _$setProp(_el$2, "gap", 1);
    _$insert(_el$3, (() => {
      var _c$ = _$memo(() => !!query().trim());
      return () => _c$() ? `${items().length} ${global() ? "global" : "project"} matches for \u201C${query()}\u201D` : `${items().length} ${global() ? "all-project" : "project"} sessions`;
    })());
    _$use((element) => {
      input = element;
      setTimeout(() => {
        if (!element.isDestroyed)
          element.focus();
      }, 0);
    }, _el$4);
    _$setProp(_el$4, "placeholder", "Search titles, messages, filenames and tool activity");
    _$setProp(_el$4, "onSubmit", choose);
    _$setProp(_el$4, "onInput", update);
    _$insert(_el$5, () => error() || (toDelete() ? "Press Ctrl+D again to delete this session" : undefined) || (busy() ? "Searching sessions\u2026" : query().trim() ? `${items().length} matches` : "Type to search all history, or use \u2191\u2193 to browse"));
    _$insertNode(_el$6, _el$7);
    _$insertNode(_el$6, _el$8);
    _$insertNode(_el$6, _el$9);
    _$setProp(_el$6, "flexDirection", "row");
    _$setProp(_el$6, "gap", 1);
    _$setProp(_el$7, "flexDirection", "column");
    _$setProp(_el$7, "overflow", "hidden");
    _$insert(_el$7, _$createComponent(For, {
      get each() {
        return visible();
      },
      children: (item, index) => {
        const active = () => start() + index() === selected();
        return (() => {
          var _el$22 = _$createElement("box"), _el$23 = _$createElement("text"), _el$24 = _$createElement("text"), _el$25 = _$createTextNode(`  `);
          _$insertNode(_el$22, _el$23);
          _$insertNode(_el$22, _el$24);
          _$setProp(_el$22, "flexDirection", "row");
          _$setProp(_el$22, "onMouseMove", () => {
            mouse = true;
          });
          _$setProp(_el$22, "onMouseOver", () => {
            if (mouse)
              setSelected(start() + index());
          });
          _$setProp(_el$22, "onMouseDown", () => setSelected(start() + index()));
          _$setProp(_el$22, "onMouseUp", () => props.onChoose(item.value));
          _$setProp(_el$23, "flexGrow", 1);
          _$setProp(_el$23, "overflow", "hidden");
          _$setProp(_el$23, "wrapMode", "none");
          _$insert(_el$23, () => active() ? "\u203A " : "  ", null);
          _$insert(_el$23, () => pins.ids.includes(item.value) ? "\u2605 " : "  ", null);
          _$insert(_el$23, () => highlighted(ellipsize(item.title, leftWidth() - item.date.length - 6), query(), active() ? theme.text.action.primary.focused : theme.text.formfield.focused), null);
          _$insertNode(_el$24, _el$25);
          _$setProp(_el$24, "flexShrink", 0);
          _$insert(_el$24, () => item.date, null);
          _$effect((_p$) => {
            var _v$16 = active() ? theme.background.action.primary.focused : undefined, _v$17 = active() ? theme.text.action.primary.focused : theme.text.base, _v$18 = active() ? theme.text.action.primary.focused : theme.text.muted;
            _v$16 !== _p$.e && (_p$.e = _$setProp(_el$22, "backgroundColor", _v$16, _p$.e));
            _v$17 !== _p$.t && (_p$.t = _$setProp(_el$23, "fg", _v$17, _p$.t));
            _v$18 !== _p$.a && (_p$.a = _$setProp(_el$24, "fg", _v$18, _p$.a));
            return _p$;
          }, {
            e: undefined,
            t: undefined,
            a: undefined
          });
          return _el$22;
        })();
      }
    }));
    _$setProp(_el$8, "width", 1);
    _$insertNode(_el$9, _el$0);
    _$insertNode(_el$9, _el$1);
    _$insertNode(_el$9, _el$14);
    _$insertNode(_el$9, _el$15);
    _$insertNode(_el$9, _el$18);
    _$setProp(_el$9, "flexGrow", 1);
    _$setProp(_el$9, "flexDirection", "column");
    _$setProp(_el$9, "overflow", "hidden");
    _$setProp(_el$0, "wrapMode", "none");
    _$setProp(_el$0, "overflow", "hidden");
    _$insert(_el$0, (() => {
      var _c$2 = _$memo(() => !!items()[selected()]);
      return () => _c$2() ? ellipsize(`${items()[selected()].project} \xB7 ${items()[selected()].worktree}`, rightWidth()) : "Select a session";
    })());
    _$insertNode(_el$1, _el$10);
    _$insertNode(_el$1, _el$11);
    _$insertNode(_el$1, _el$13);
    _$insert(_el$1, () => details()?.userCount ?? 0, _el$11);
    _$insert(_el$1, () => details()?.assistantCount ?? 0, _el$13);
    _$setProp(_el$14, "flexDirection", "column");
    _$setProp(_el$14, "overflow", "hidden");
    _$insert(_el$14, (() => {
      var _c$3 = _$memo(() => !!detailsBusy());
      return () => _c$3() ? (() => {
        var _el$26 = _$createElement("text");
        _$insertNode(_el$26, _$createTextNode(`Loading messages\u2026`));
        _$effect((_$p) => _$setProp(_el$26, "fg", theme.text.muted, _$p));
        return _el$26;
      })() : null;
    })(), null);
    _$insert(_el$14, (() => {
      var _c$4 = _$memo(() => !!detailsError());
      return () => _c$4() ? (() => {
        var _el$28 = _$createElement("text");
        _$insert(_el$28, detailsError);
        _$effect((_$p) => _$setProp(_el$28, "fg", theme.text.feedback.error.base, _$p));
        return _el$28;
      })() : null;
    })(), null);
    _$insert(_el$14, (() => {
      var _c$5 = _$memo(() => !!(!detailsBusy() && details()?.timeline.length === 0));
      return () => _c$5() ? (() => {
        var _el$29 = _$createElement("text");
        _$insertNode(_el$29, _$createTextNode(`No messages`));
        _$effect((_$p) => _$setProp(_el$29, "fg", theme.text.muted, _$p));
        return _el$29;
      })() : null;
    })(), null);
    _$insert(_el$14, _$createComponent(For, {
      get each() {
        return timelineLines();
      },
      children: (line) => {
        const prefix = line.time ? `\u2022 ${line.role} \xB7 ` : "  ";
        return (() => {
          var _el$31 = _$createElement("text");
          _$setProp(_el$31, "overflow", "hidden");
          _$setProp(_el$31, "wrapMode", "none");
          _$setProp(_el$31, "height", 1);
          _$insert(_el$31, prefix, null);
          _$insert(_el$31, () => highlighted(ellipsize(line.text, rightWidth() - prefix.length), query(), matchColor), null);
          _$effect((_$p) => _$setProp(_el$31, "fg", line.time ? theme.text.base : theme.text.muted, _$p));
          return _el$31;
        })();
      }
    }), null);
    _$insertNode(_el$15, _el$16);
    _$insertNode(_el$15, _el$17);
    _$insert(_el$15, () => details()?.matchCount ?? 0, _el$17);
    _$insert(_el$15, () => (details()?.matchCount ?? 0) > (details()?.matches.length ?? 0) ? " (top 30)" : "", null);
    _$setProp(_el$18, "scrollbarOptions", {
      visible: false
    });
    _$insert(_el$18, (() => {
      var _c$6 = _$memo(() => !!!query().trim());
      return () => _c$6() ? (() => {
        var _el$32 = _$createElement("text");
        _$insertNode(_el$32, _$createTextNode(`Type to find matching messages`));
        _$effect((_$p) => _$setProp(_el$32, "fg", theme.text.muted, _$p));
        return _el$32;
      })() : null;
    })(), null);
    _$insert(_el$18, (() => {
      var _c$7 = _$memo(() => !!(!detailsBusy() && query().trim() && details()?.matches.length === 0));
      return () => _c$7() ? (() => {
        var _el$34 = _$createElement("text");
        _$insertNode(_el$34, _$createTextNode(`No direct message matches`));
        _$effect((_$p) => _$setProp(_el$34, "fg", theme.text.muted, _$p));
        return _el$34;
      })() : null;
    })(), null);
    _$insert(_el$18, _$createComponent(For, {
      get each() {
        return details()?.matches ?? [];
      },
      children: (line) => {
        const prefix = `${line.role} \xB7 `;
        return (() => {
          var _el$36 = _$createElement("text");
          _$setProp(_el$36, "overflow", "hidden");
          _$setProp(_el$36, "wrapMode", "none");
          _$setProp(_el$36, "height", 1);
          _$insert(_el$36, prefix, null);
          _$insert(_el$36, () => highlighted(ellipsize(line.text, rightWidth() - prefix.length), query(), matchColor), null);
          _$effect((_$p) => _$setProp(_el$36, "fg", theme.text.muted, _$p));
          return _el$36;
        })();
      }
    }), null);
    _$insertNode(_el$19, _el$20);
    _$insertNode(_el$19, _el$21);
    _$setProp(_el$19, "overflow", "hidden");
    _$setProp(_el$19, "wrapMode", "none");
    _$insert(_el$19, () => global() ? "project" : "all", _el$21);
    _$effect((_p$) => {
      var _v$ = theme.text.base, _v$2 = TextAttributes.BOLD, _v$3 = theme.text.muted, _v$4 = theme.text.formfield.focused, _v$5 = props.initial, _v$6 = error() || toDelete() ? theme.text.feedback.error.base : theme.text.muted, _v$7 = bodyHeight(), _v$8 = leftWidth(), _v$9 = theme.background.raised.high, _v$0 = theme.text.muted, _v$1 = theme.text.formfield.focused, _v$10 = TextAttributes.BOLD, _v$11 = timelineHeight(), _v$12 = theme.text.formfield.focused, _v$13 = TextAttributes.BOLD, _v$14 = matchesHeight(), _v$15 = theme.text.muted;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$3, "fg", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$3, "attributes", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = _$setProp(_el$4, "placeholderColor", _v$3, _p$.a));
      _v$4 !== _p$.o && (_p$.o = _$setProp(_el$4, "cursorColor", _v$4, _p$.o));
      _v$5 !== _p$.i && (_p$.i = _$setProp(_el$4, "value", _v$5, _p$.i));
      _v$6 !== _p$.n && (_p$.n = _$setProp(_el$5, "fg", _v$6, _p$.n));
      _v$7 !== _p$.s && (_p$.s = _$setProp(_el$6, "height", _v$7, _p$.s));
      _v$8 !== _p$.h && (_p$.h = _$setProp(_el$7, "width", _v$8, _p$.h));
      _v$9 !== _p$.r && (_p$.r = _$setProp(_el$8, "backgroundColor", _v$9, _p$.r));
      _v$0 !== _p$.d && (_p$.d = _$setProp(_el$0, "fg", _v$0, _p$.d));
      _v$1 !== _p$.l && (_p$.l = _$setProp(_el$1, "fg", _v$1, _p$.l));
      _v$10 !== _p$.u && (_p$.u = _$setProp(_el$1, "attributes", _v$10, _p$.u));
      _v$11 !== _p$.c && (_p$.c = _$setProp(_el$14, "height", _v$11, _p$.c));
      _v$12 !== _p$.w && (_p$.w = _$setProp(_el$15, "fg", _v$12, _p$.w));
      _v$13 !== _p$.m && (_p$.m = _$setProp(_el$15, "attributes", _v$13, _p$.m));
      _v$14 !== _p$.f && (_p$.f = _$setProp(_el$18, "height", _v$14, _p$.f));
      _v$15 !== _p$.y && (_p$.y = _$setProp(_el$19, "fg", _v$15, _p$.y));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined,
      n: undefined,
      s: undefined,
      h: undefined,
      r: undefined,
      d: undefined,
      l: undefined,
      u: undefined,
      c: undefined,
      w: undefined,
      m: undefined,
      f: undefined,
      y: undefined
    });
    return _el$2;
  })();
}
function selectSession(context, initial, all, projectID, search, details, rename, remove) {
  return new Promise((resolve) => {
    let settled = false;
    context.ui.dialog.show(() => _$createComponent(SessionPicker, {
      context,
      initial,
      all,
      projectID,
      search,
      details,
      rename,
      delete: remove,
      onChoose: (value) => {
        if (settled)
          return;
        settled = true;
        resolve(value);
        context.ui.dialog.clear();
      }
    }), () => {
      if (settled)
        return;
      settled = true;
      resolve(undefined);
    });
    context.ui.dialog.set({
      size: "xlarge",
      centered: true
    });
  });
}

// src/tui.ts
var pageSize = 200;
var indexVersion = 3;
var indexFile = () => join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "search-sessions.sqlite");
var normalize = (text) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function openIndex() {
  const file = indexFile();
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS indexed_sessions (id TEXT PRIMARY KEY, updated INTEGER NOT NULL, title TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
    CREATE VIRTUAL TABLE IF NOT EXISTS session_text USING fts5(id UNINDEXED, body, tokenize='unicode61 remove_diacritics 2');
    CREATE VIRTUAL TABLE IF NOT EXISTS session_words USING fts5vocab(session_text, 'row');
  `);
  if (!db.query("PRAGMA table_info(indexed_sessions)").all().some((column) => column.name === "version")) {
    db.exec("ALTER TABLE indexed_sessions ADD COLUMN version INTEGER NOT NULL DEFAULT 0");
  }
  return db;
}
function runWorker(request, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted)
      return reject(new DOMException("Search cancelled", "AbortError"));
    const worker = new Worker(new URL("./query-worker.js", import.meta.url));
    let finished = false;
    const done = (result) => {
      if (finished)
        return;
      finished = true;
      signal.removeEventListener("abort", cancel);
      worker.terminate();
      if (result instanceof Error)
        reject(result);
      else
        resolve(result);
    };
    const cancel = () => done(new DOMException("Search cancelled", "AbortError"));
    signal.addEventListener("abort", cancel, { once: true });
    worker.onmessage = (event) => {
      if (event.data.error)
        done(new Error(event.data.error));
      else
        done(event.data);
    };
    worker.onerror = (event) => done(new Error(event.message));
    worker.postMessage({ ...request, file: indexFile() });
    if (signal.aborted)
      cancel();
  });
}
function queryIndex(query, sessions, signal) {
  return runWorker({ type: "search", query, sessions }, signal).then((result) => result.ids ?? []);
}
function queryDetails(sessionID, query, sourceFile, updated, signal, messages) {
  return runWorker({ type: "details", sessionID, query, sourceFile, updated, messages }, signal).then((result) => result.details);
}
var tui_default = Plugin.define({
  id: "search-sessions",
  setup(context) {
    context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "search-sessions.open",
              title: "Search sessions",
              palette: true,
              slash: { name: "search", arguments: true },
              run: async (input) => {
                try {
                  const projectsReady = context.client.project.list().then((response) => response, () => []);
                  const sessions = [];
                  const visited = new Set;
                  let cursor;
                  for (;; ) {
                    const page = await context.client.session.list({
                      limit: pageSize,
                      cursor,
                      order: "desc"
                    });
                    sessions.push(...page.data);
                    const next = page.cursor.next ?? undefined;
                    if (!page.data.length || !next || visited.has(next))
                      break;
                    visited.add(next);
                    cursor = next;
                  }
                  sessions.sort((a, b) => b.time.updated - a.time.updated);
                  const projects = await projectsReady;
                  const byProjectID = new Map(projects.map((project) => [project.id, project]));
                  const byDirectory = new Map(projects.map((project) => [project.canonical, project]));
                  for (const project of projects)
                    for (const directory of project.sandboxes ?? [])
                      byDirectory.set(directory, project);
                  const describe = (session) => {
                    const directory = session.location.directory;
                    const worktreeID = directory.match(/[/\\]opencode[/\\]worktree[/\\]([a-f0-9]{6})[/\\]/)?.[1];
                    const project = byDirectory.get(directory) ?? (worktreeID ? projects.find((item) => item.id.startsWith(worktreeID)) : undefined) ?? byProjectID.get(session.projectID);
                    return {
                      title: session.title || "Untitled session",
                      value: session.id,
                      date: new Date(session.time.updated).toLocaleDateString(),
                      project: basename(project?.canonical ?? directory),
                      projectID: session.projectID,
                      worktree: !project || directory === project.canonical ? "main" : basename(directory)
                    };
                  };
                  const db = openIndex();
                  let indexReady;
                  const byID = new Map(sessions.map((session) => [session.id, session]));
                  const searchable = sessions.map((session) => ({
                    id: session.id,
                    title: session.title ?? "",
                    updated: session.time.updated
                  }));
                  try {
                    const search = async (query, signal) => {
                      if (!normalize(query))
                        return [];
                      if (!indexReady)
                        indexReady = (async () => {
                          const indexed = db.query("SELECT id, updated, version FROM indexed_sessions").all();
                          const known = new Map(indexed.map((item) => [item.id, item]));
                          const pending = sessions.filter((session) => known.get(session.id)?.updated !== session.time.updated || known.get(session.id)?.version !== indexVersion);
                          let position = 0;
                          let completed = 0;
                          let failed = 0;
                          if (pending.length) {
                            context.ui.toast.show({
                              message: `Indexing ${pending.length} sessions for transcript search\u2026`,
                              duration: 5000
                            });
                            const sourceFile = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "opencode.db");
                            let source;
                            if (existsSync(sourceFile)) {
                              try {
                                source = new Database(sourceFile, {
                                  readonly: true
                                });
                              } catch {}
                            }
                            const sourceSession = source?.query("SELECT time_updated FROM session_v2 WHERE id = ?");
                            const sourceMessages = source?.query("SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq");
                            try {
                              await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
                                while (position < pending.length) {
                                  const session = pending[position++];
                                  try {
                                    const text = [];
                                    const local = sourceSession?.get(session.id);
                                    if (local?.time_updated === session.time.updated && sourceMessages) {
                                      for (const row of sourceMessages.all(session.id)) {
                                        text.push(...searchableText({
                                          ...JSON.parse(row.data),
                                          type: row.type
                                        }));
                                      }
                                    } else {
                                      const seen = new Set;
                                      let next;
                                      for (;; ) {
                                        const page = await context.client.message.list({
                                          sessionID: session.id,
                                          limit: pageSize,
                                          cursor: next
                                        });
                                        for (const message of page.data)
                                          text.push(...searchableText(message));
                                        const cursor = page.cursor.next ?? undefined;
                                        if (!page.data.length || !cursor || seen.has(cursor))
                                          break;
                                        seen.add(cursor);
                                        next = cursor;
                                      }
                                    }
                                    db.transaction(() => {
                                      db.query("INSERT INTO indexed_sessions (id, updated, title, version) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated, title=excluded.title, version=excluded.version").run(session.id, session.time.updated, session.title ?? "", indexVersion);
                                      const row = db.query("SELECT rowid FROM indexed_sessions WHERE id = ?").get(session.id);
                                      db.query("DELETE FROM session_text WHERE rowid = ?").run(row.rowid);
                                      db.query("INSERT INTO session_text (rowid, id, body) VALUES (?, ?, ?)").run(row.rowid, session.id, text.join(`
`));
                                    })();
                                  } catch {
                                    failed++;
                                  }
                                  completed++;
                                  if (completed % 100 === 0) {
                                    context.ui.toast.show({
                                      message: `Indexed ${completed}/${pending.length} sessions\u2026`,
                                      duration: 3500
                                    });
                                  }
                                  await new Promise((resolve) => setTimeout(resolve, 0));
                                }
                              }));
                            } finally {
                              source?.close();
                            }
                          }
                          if (failed)
                            context.ui.toast.show({
                              message: `${failed} sessions could not be indexed; retry the command to include them.`,
                              variant: "warning"
                            });
                        })();
                      await indexReady;
                      if (signal.aborted)
                        return [];
                      const ids = await queryIndex(query, searchable, signal);
                      return ids.flatMap((id) => {
                        const session = byID.get(id);
                        return session ? [describe(session)] : [];
                      });
                    };
                    const details = async (sessionID, query, signal) => {
                      const sourceFile = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "opencode.db");
                      if (existsSync(sourceFile)) {
                        try {
                          const local = await queryDetails(sessionID, query, sourceFile, byID.get(sessionID)?.time.updated ?? 0, signal);
                          if (!local.unavailable)
                            return local;
                        } catch (error) {
                          if (signal.aborted)
                            throw error;
                        }
                      }
                      const messages = [];
                      const seen = new Set;
                      let cursor;
                      for (;; ) {
                        if (signal.aborted)
                          throw new DOMException("Details cancelled", "AbortError");
                        const page = await context.client.message.list({ sessionID, limit: pageSize, cursor }, { signal });
                        for (const message of page.data)
                          messages.push({
                            type: message.type,
                            time_created: message.time.created,
                            data: message
                          });
                        const next = page.cursor.next ?? undefined;
                        if (!page.data.length || !next || seen.has(next))
                          break;
                        seen.add(next);
                        cursor = next;
                      }
                      return queryDetails(sessionID, query, sourceFile, byID.get(sessionID)?.time.updated ?? 0, signal, messages);
                    };
                    const rename = async (item, title) => {
                      const response = await context.client.session.update({
                        sessionID: item.value,
                        title
                      });
                      if (response && typeof response === "object" && "error" in response && response.error)
                        throw new Error(String(response.error));
                      const session = byID.get(item.value);
                      session.title = title;
                      const refreshed = await context.client.session.get({
                        sessionID: item.value
                      });
                      const info = refreshed && typeof refreshed === "object" && "data" in refreshed ? refreshed.data : refreshed;
                      session.time.updated = info.time.updated;
                      const indexed = searchable.find((entry) => entry.id === item.value);
                      if (indexed) {
                        indexed.title = title;
                        indexed.updated = session.time.updated;
                      }
                      return describe(session);
                    };
                    const remove = async (item) => {
                      const response = await context.client.session.remove({
                        sessionID: item.value
                      });
                      if (response && typeof response === "object" && "error" in response && response.error)
                        throw new Error(String(response.error));
                      if (response && typeof response === "object" && "data" in response && response.data === false)
                        throw new Error("Session was not deleted");
                      const removed = new Set([item.value]);
                      let count = 0;
                      while (count !== removed.size) {
                        count = removed.size;
                        for (const session of sessions)
                          if (session.parentID && removed.has(session.parentID))
                            removed.add(session.id);
                      }
                      for (const id of removed)
                        byID.delete(id);
                      for (let index = searchable.length - 1;index >= 0; index--)
                        if (removed.has(searchable[index].id))
                          searchable.splice(index, 1);
                      db.transaction(() => {
                        for (const id of removed) {
                          const row = db.query("SELECT rowid FROM indexed_sessions WHERE id = ?").get(id);
                          if (!row)
                            continue;
                          db.query("DELETE FROM session_text WHERE rowid = ?").run(row.rowid);
                          db.query("DELETE FROM indexed_sessions WHERE id = ?").run(id);
                        }
                      })();
                      return [...removed];
                    };
                    const route = context.ui.router.current();
                    const projectID = (route.type === "session" ? byID.get(route.sessionID)?.projectID : undefined) ?? byDirectory.get((context.location ?? context.data.location.default()).directory)?.id ?? sessions.find((session) => session.location.directory === (context.location ?? context.data.location.default()).directory)?.projectID ?? "";
                    const selection = await selectSession(context, input?.trim() ?? "", sessions.map(describe), projectID, search, details, rename, remove);
                    if (selection)
                      context.ui.router.navigate({
                        type: "session",
                        sessionID: selection
                      });
                  } finally {
                    if (indexReady)
                      await indexReady.catch(() => {});
                    db.close();
                  }
                } catch (error) {
                  context.ui.toast.show({
                    variant: "error",
                    message: `Session search failed: ${error instanceof Error ? error.message : String(error)}`
                  });
                }
              }
            }
          ],
          bindings: []
        }));
        return null;
      }
    });
  }
});
export {
  tui_default as default
};
