/** @jsxImportSource @opentui/solid */
import type { Context } from "@opencode/plugin/tui/context";
import {
  InputRenderable,
  RGBA,
  TextAttributes,
  type KeyEvent,
} from "@opentui/core";
import type { DetailLine, SessionDetails } from "./message-text";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
} from "solid-js";

export type Item = {
  title: string;
  value: string;
  date: string;
  project: string;
  worktree: string;
  projectID: string;
};

const debounceMs = 180;
const matchColor = RGBA.fromHex("#facc15");

function ellipsize(text: string, width: number) {
  const characters = Array.from(text);
  return characters.length > width
    ? `${characters
        .slice(0, width - 1)
        .join("")
        .trimEnd()}…`
    : text;
}

function highlighted(
  text: string,
  query: string,
  color: Context["theme"]["text"]["base"],
) {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (!words.length) return text;
  const pattern = new RegExp(
    `(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi",
  );
  return text
    .split(pattern)
    .map((part) =>
      words.includes(part.toLowerCase()) ? (
        <span style={{ fg: color, attributes: TextAttributes.BOLD }}>
          {part}
        </span>
      ) : (
        part
      ),
    );
}

function SessionPicker(props: {
  context: Context;
  initial: string;
  all: Item[];
  projectID: string;
  search: (query: string, signal: AbortSignal) => Promise<Item[]>;
  details: (
    sessionID: string,
    query: string,
    signal: AbortSignal,
  ) => Promise<SessionDetails>;
  rename: (item: Item, title: string) => Promise<Item>;
  delete: (item: Item) => Promise<string[]>;
  onChoose: (value: string) => void;
}) {
  const context = props.context;
  const theme = context.theme;
  const [pins, updatePins] = context.storage.store("search-sessions.pins", {
    initial: { ids: [] as string[] },
  });
  const [dimensions, setDimensions] = createSignal({
    width: context.renderer.width,
    height: context.renderer.height,
  });
  const resize = (width: number, height: number) =>
    setDimensions({ width, height });
  context.renderer.on("resize", resize);
  onCleanup(() => context.renderer.off("resize", resize));
  const leftWidth = () =>
    Math.min(
      55,
      Math.max(30, Math.floor((Math.min(dimensions().width - 2, 116) - 4) / 2)),
    );
  const rightWidth = () =>
    Math.max(8, Math.min(dimensions().width - 2, 116) - leftWidth() - 4);
  const bodyHeight = () =>
    Math.max(8, Math.min(25, Math.floor(dimensions().height * 0.75) - 10));
  const visibleRows = bodyHeight;
  const matchesHeight = () =>
    Math.max(2, Math.min(5, Math.floor(bodyHeight() / 5)));
  const timelineHeight = () => bodyHeight() - matchesHeight() - 3;
  const [query, setQuery] = createSignal(props.initial);
  const [all, setAll] = createSignal(props.all);
  const [results, setResults] = createSignal(props.initial ? [] : props.all);
  const [global, setGlobal] = createSignal(false);
  const items = createMemo(() => {
    const pinned = new Set(pins.ids);
    return results()
      .filter((item) => global() || item.projectID === props.projectID)
      .toSorted(
        (a, b) => Number(pinned.has(b.value)) - Number(pinned.has(a.value)),
      );
  });
  const [selected, setSelected] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [toDelete, setToDelete] = createSignal<string>();
  const [actionBusy, setActionBusy] = createSignal(false);
  const [details, setDetails] = createSignal<SessionDetails>();
  const [detailsBusy, setDetailsBusy] = createSignal(false);
  const [detailsError, setDetailsError] = createSignal("");
  const timelineLines = createMemo(() => {
    const info = details();
    const lines = info?.timeline ?? [];
    const height = timelineHeight();
    if (!info || info.userCount + info.assistantCount <= height) return lines;
    const first = Math.ceil((height - 1) / 2);
    const last = height - first - 1;
    const visible = [...lines.slice(0, first), ...lines.slice(-last)];
    const users =
      info.userCount - visible.filter((line) => line.role === "You").length;
    const assistants =
      info.assistantCount -
      visible.filter((line) => line.role === "Assistant").length;
    const count = (amount: number, role: string) =>
      `${amount} more ${role} message${amount === 1 ? "" : "s"}`;
    const folded: DetailLine = {
      text: [
        users && count(users, "user"),
        assistants && count(assistants, "assistant"),
      ]
        .filter(Boolean)
        .join(" · "),
      time: 0,
    };
    return [...lines.slice(0, first), folded, ...lines.slice(-last)];
  });
  const detailsCache = new Map<string, SessionDetails>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: AbortController | undefined;
  let input: InputRenderable | undefined;
  let generation = 0;
  let mouse = false;

  const start = createMemo(() =>
    Math.max(
      0,
      Math.min(
        selected() - Math.floor(visibleRows() / 2),
        items().length - visibleRows(),
      ),
    ),
  );
  const visible = createMemo(() =>
    items().slice(start(), start() + visibleRows()),
  );

  function update(value: string) {
    const current = ++generation;
    if (timer) clearTimeout(timer);
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
      const controller = new AbortController();
      active = controller;
      void props.search(value, controller.signal).then(
        (results) => {
          if (current !== generation) return;
          setResults(results);
          setBusy(false);
        },
        (reason) => {
          if (current !== generation) return;
          setBusy(false);
          setError(reason instanceof Error ? reason.message : String(reason));
        },
      );
    }, debounceMs);
  }

  if (props.initial.trim()) timer = setTimeout(() => update(props.initial), 0);
  createEffect(() => {
    const id = items()[selected()]?.value;
    if (toDelete() && toDelete() !== id) setToDelete(undefined);
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
    const key = `${id}\0${value.trim()}`;
    const cached = detailsCache.get(key);
    if (cached) {
      setDetails(cached);
      setDetailsBusy(false);
      return;
    }
    setDetailsBusy(true);
    const controller = new AbortController();
    const pending = setTimeout(() => {
      void props.details(id, value, controller.signal).then(
        (result) => {
          if (controller.signal.aborted) return;
          detailsCache.set(key, result);
          if (detailsCache.size > 30)
            detailsCache.delete(detailsCache.keys().next().value!);
          setDetails(result);
          setDetailsBusy(false);
        },
        (error) => {
          if (controller.signal.aborted) return;
          setDetailsError(
            error instanceof Error ? error.message : String(error),
          );
          setDetailsBusy(false);
        },
      );
    }, 75);
    onCleanup(() => {
      clearTimeout(pending);
      controller.abort();
    });
  });
  onCleanup(() => {
    generation++;
    if (timer) clearTimeout(timer);
    active?.abort();
  });

  const move = (offset: number) => {
    mouse = false;
    setSelected((index) =>
      Math.max(0, Math.min(items().length - 1, index + offset)),
    );
  };
  const choose = () => {
    const item = items()[selected()];
    if (item && !actionBusy()) props.onChoose(item.value);
  };
  const toggleScope = () => {
    setGlobal((value) => !value);
    setSelected(0);
    setToDelete(undefined);
  };
  const togglePin = async () => {
    const item = items()[selected()];
    if (!item || actionBusy()) return;
    try {
      await updatePins((draft) => {
        draft.ids = draft.ids.includes(item.value)
          ? draft.ids.filter((id) => id !== item.value)
          : [...draft.ids, item.value];
      });
      setSelected(items().findIndex((entry) => entry.value === item.value));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const rename = async () => {
    const item = items()[selected()];
    if (!item || actionBusy()) return;
    setActionBusy(true);
    try {
      const title = await context.ui.dialog.prompt({
        title: "Rename session",
        value: item.title,
      });
      context.ui.dialog.set({ size: "xlarge", centered: true });
      if (!title?.trim() || title.trim() === item.title) return;
      const updated = await props.rename(item, title.trim());
      setAll((list) =>
        list.map((entry) => (entry.value === item.value ? updated : entry)),
      );
      setResults((list) =>
        list.map((entry) => (entry.value === item.value ? updated : entry)),
      );
      if (query().trim()) update(query());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setActionBusy(false);
    }
  };
  const remove = async () => {
    const item = items()[selected()];
    if (!item || actionBusy()) return;
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

  const keypress = (event: KeyEvent) => {
    if (!event.ctrl || context.renderer.currentFocusedRenderable !== input)
      return;
    if (event.name === "a") {
      event.preventDefault();
      toggleScope();
    }
    if (event.name === "f") {
      event.preventDefault();
      void togglePin();
    }
    if (event.name === "d") {
      event.preventDefault();
      void remove();
    }
    if (event.name === "r") {
      event.preventDefault();
      void rename();
    }
  };
  context.renderer.keyInput.on("keypress", keypress);
  onCleanup(() => context.renderer.keyInput.off("keypress", keypress));

  context.keymap.layer(() => ({
    mode: "global",
    priority: 100,
    commands: [
      { id: "search-sessions.picker.up", bind: "up", run: () => move(-1) },
      { id: "search-sessions.picker.down", bind: "down", run: () => move(1) },
      {
        id: "search-sessions.picker.page-up",
        bind: "pageup",
        run: () => move(-visibleRows()),
      },
      {
        id: "search-sessions.picker.page-down",
        bind: "pagedown",
        run: () => move(visibleRows()),
      },
      {
        id: "search-sessions.picker.home",
        bind: "home",
        run: () => setSelected(0),
      },
      {
        id: "search-sessions.picker.end",
        bind: "end",
        run: () => setSelected(Math.max(0, items().length - 1)),
      },
      { id: "search-sessions.picker.choose", bind: "return", run: choose },
    ],
    bindings: [
      "search-sessions.picker.up",
      "search-sessions.picker.down",
      "search-sessions.picker.page-up",
      "search-sessions.picker.page-down",
      "search-sessions.picker.home",
      "search-sessions.picker.end",
      "search-sessions.picker.choose",
    ],
  }));

  return (
    <box
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      paddingBottom={1}
      gap={1}
    >
      <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
        {query().trim()
          ? `${items().length} ${global() ? "global" : "project"} matches for “${query()}”`
          : `${items().length} ${global() ? "all-project" : "project"} sessions`}
      </text>
      <input
        placeholder="Search titles, messages, filenames and tool activity"
        placeholderColor={theme.text.muted}
        cursorColor={theme.text.formfield.focused}
        value={props.initial}
        onSubmit={choose}
        onInput={update}
        ref={(element) => {
          input = element;
          setTimeout(() => {
            if (!element.isDestroyed) element.focus();
          }, 0);
        }}
      />
      <text
        fg={
          error() || toDelete()
            ? theme.text.feedback.error.base
            : theme.text.muted
        }
      >
        {error() ||
          (toDelete()
            ? "Press Ctrl+D again to delete this session"
            : undefined) ||
          (busy()
            ? "Searching sessions…"
            : query().trim()
              ? `${items().length} matches`
              : "Type to search all history, or use ↑↓ to browse")}
      </text>
      <box flexDirection="row" height={bodyHeight()} gap={1}>
        <box flexDirection="column" width={leftWidth()} overflow="hidden">
          <For each={visible()}>
            {(item, index) => {
              const active = () => start() + index() === selected();
              return (
                <box
                  flexDirection="row"
                  backgroundColor={
                    active()
                      ? theme.background.action.primary.focused
                      : undefined
                  }
                  onMouseMove={() => {
                    mouse = true;
                  }}
                  onMouseOver={() => {
                    if (mouse) setSelected(start() + index());
                  }}
                  onMouseDown={() => setSelected(start() + index())}
                  onMouseUp={() => props.onChoose(item.value)}
                >
                  <text
                    flexGrow={1}
                    overflow="hidden"
                    wrapMode="none"
                    fg={
                      active()
                        ? theme.text.action.primary.focused
                        : theme.text.base
                    }
                  >
                    {active() ? "› " : "  "}
                    {pins.ids.includes(item.value) ? "★ " : "  "}
                    {highlighted(
                      ellipsize(item.title, leftWidth() - item.date.length - 6),
                      query(),
                      active()
                        ? theme.text.action.primary.focused
                        : theme.text.formfield.focused,
                    )}
                  </text>
                  <text
                    flexShrink={0}
                    fg={
                      active()
                        ? theme.text.action.primary.focused
                        : theme.text.muted
                    }
                  >
                    {"  "}
                    {item.date}
                  </text>
                </box>
              );
            }}
          </For>
        </box>
        <box width={1} backgroundColor={theme.background.raised.high} />
        <box flexGrow={1} flexDirection="column" overflow="hidden">
          <text fg={theme.text.muted} wrapMode="none" overflow="hidden">
            {items()[selected()]
              ? ellipsize(
                  `${items()[selected()]!.project} · ${items()[selected()]!.worktree}`,
                  rightWidth(),
                )
              : "Select a session"}
          </text>
          <text
            fg={theme.text.formfield.focused}
            attributes={TextAttributes.BOLD}
          >
            Timeline · {details()?.userCount ?? 0} user ·{" "}
            {details()?.assistantCount ?? 0} assistant
          </text>
          <box
            flexDirection="column"
            height={timelineHeight()}
            overflow="hidden"
          >
            {detailsBusy() ? (
              <text fg={theme.text.muted}>Loading messages…</text>
            ) : null}
            {detailsError() ? (
              <text fg={theme.text.feedback.error.base}>{detailsError()}</text>
            ) : null}
            {!detailsBusy() && details()?.timeline.length === 0 ? (
              <text fg={theme.text.muted}>No messages</text>
            ) : null}
            <For each={timelineLines()}>
              {(line) => {
                const prefix = line.time ? `• ${line.role} · ` : "  ";
                return (
                  <text
                    fg={line.time ? theme.text.base : theme.text.muted}
                    overflow="hidden"
                    wrapMode="none"
                    height={1}
                  >
                    {prefix}
                    {highlighted(
                      ellipsize(line.text, rightWidth() - prefix.length),
                      query(),
                      matchColor,
                    )}
                  </text>
                );
              }}
            </For>
          </box>
          <text
            fg={theme.text.formfield.focused}
            attributes={TextAttributes.BOLD}
          >
            Matches · {details()?.matchCount ?? 0} messages
            {(details()?.matchCount ?? 0) > (details()?.matches.length ?? 0)
              ? " (top 30)"
              : ""}
          </text>
          <scrollbox
            height={matchesHeight()}
            scrollbarOptions={{ visible: false }}
          >
            {!query().trim() ? (
              <text fg={theme.text.muted}>Type to find matching messages</text>
            ) : null}
            {!detailsBusy() &&
            query().trim() &&
            details()?.matches.length === 0 ? (
              <text fg={theme.text.muted}>No direct message matches</text>
            ) : null}
            <For each={details()?.matches ?? []}>
              {(line) => {
                const prefix = `${line.role} · `;
                return (
                  <text
                    fg={theme.text.muted}
                    overflow="hidden"
                    wrapMode="none"
                    height={1}
                  >
                    {prefix}
                    {highlighted(
                      ellipsize(line.text, rightWidth() - prefix.length),
                      query(),
                      matchColor,
                    )}
                  </text>
                );
              }}
            </For>
          </scrollbox>
        </box>
      </box>
      <text fg={theme.text.muted} overflow="hidden" wrapMode="none">
        ↑↓ select · Enter open · Ctrl+F pin · Ctrl+D delete · Ctrl+R rename ·
        Ctrl+A {global() ? "project" : "all"} · Esc
      </text>
    </box>
  );
}

export function selectSession(
  context: Context,
  initial: string,
  all: Item[],
  projectID: string,
  search: (query: string, signal: AbortSignal) => Promise<Item[]>,
  details: (
    sessionID: string,
    query: string,
    signal: AbortSignal,
  ) => Promise<SessionDetails>,
  rename: (item: Item, title: string) => Promise<Item>,
  remove: (item: Item) => Promise<string[]>,
) {
  return new Promise<string | undefined>((resolve) => {
    let settled = false;
    context.ui.dialog.show(
      () => (
        <SessionPicker
          context={context}
          initial={initial}
          all={all}
          projectID={projectID}
          search={search}
          details={details}
          rename={rename}
          delete={remove}
          onChoose={(value) => {
            if (settled) return;
            settled = true;
            resolve(value);
            context.ui.dialog.clear();
          }}
        />
      ),
      () => {
        if (settled) return;
        settled = true;
        resolve(undefined);
      },
    );
    context.ui.dialog.set({ size: "xlarge", centered: true });
  });
}
