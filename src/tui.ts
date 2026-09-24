import { Plugin } from "@opencode/plugin/tui";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { searchableText, type SessionDetails } from "./message-text";
import { selectSession, type Item } from "./picker";

type Session = {
  id: string;
  title?: string;
  parentID?: string;
  projectID: string;
  location: { directory: string };
  time: { updated: number };
};
type Project = { id: string; canonical: string; sandboxes?: string[] };

const pageSize = 200;
const indexVersion = 3;
const indexFile = () =>
  join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "opencode",
    "search-sessions.sqlite",
  );
const normalize = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

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
  if (
    !(
      db.query("PRAGMA table_info(indexed_sessions)").all() as {
        name: string;
      }[]
    ).some((column) => column.name === "version")
  ) {
    db.exec(
      "ALTER TABLE indexed_sessions ADD COLUMN version INTEGER NOT NULL DEFAULT 0",
    );
  }
  return db;
}

type WorkerReply = { ids?: string[]; details?: SessionDetails; error?: string };

function runWorker(request: object, signal: AbortSignal): Promise<WorkerReply> {
  return new Promise((resolve, reject) => {
    if (signal.aborted)
      return reject(new DOMException("Search cancelled", "AbortError"));
    const worker = new Worker(new URL("./query-worker.ts", import.meta.url));
    let finished = false;
    const done = (result: WorkerReply | Error) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", cancel);
      void worker.terminate();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const cancel = () =>
      done(new DOMException("Search cancelled", "AbortError"));
    signal.addEventListener("abort", cancel, { once: true });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      if (event.data.error) done(new Error(event.data.error));
      else done(event.data);
    };
    worker.onerror = (event) => done(new Error(event.message));
    worker.postMessage({ ...request, file: indexFile() });
    if (signal.aborted) cancel();
  });
}

function queryIndex(
  query: string,
  sessions: { id: string; title: string; updated: number }[],
  signal: AbortSignal,
) {
  return runWorker({ type: "search", query, sessions }, signal).then(
    (result) => result.ids ?? [],
  );
}

function queryDetails(
  sessionID: string,
  query: string,
  sourceFile: string,
  updated: number,
  signal: AbortSignal,
  messages?: { type: string; time_created: number; data: unknown }[],
) {
  return runWorker(
    { type: "details", sessionID, query, sourceFile, updated, messages },
    signal,
  ).then((result) => result.details!);
}

export default Plugin.define({
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
              run: async (input?: string) => {
                try {
                  const projectsReady = context.client.project.list().then(
                    (response) => response as Project[],
                    () => [] as Project[],
                  );
                  const sessions: Session[] = [];
                  const visited = new Set<string>();
                  let cursor: string | undefined;
                  for (;;) {
                    const page = await context.client.session.list({
                      limit: pageSize,
                      cursor,
                      order: "desc",
                    });
                    sessions.push(...page.data);
                    const next = page.cursor.next ?? undefined;
                    if (!page.data.length || !next || visited.has(next)) break;
                    visited.add(next);
                    cursor = next;
                  }
                  sessions.sort((a, b) => b.time.updated - a.time.updated);
                  const projects = await projectsReady;
                  const byProjectID = new Map(
                    projects.map((project) => [project.id, project]),
                  );
                  const byDirectory = new Map(
                    projects.map((project) => [project.canonical, project]),
                  );
                  for (const project of projects)
                    for (const directory of project.sandboxes ?? [])
                      byDirectory.set(directory, project);
                  const describe = (session: Session) => {
                    const directory = session.location.directory;
                    const worktreeID = directory.match(
                      /[/\\]opencode[/\\]worktree[/\\]([a-f0-9]{6})[/\\]/,
                    )?.[1];
                    const project =
                      byDirectory.get(directory) ??
                      (worktreeID
                        ? projects.find((item) =>
                            item.id.startsWith(worktreeID),
                          )
                        : undefined) ??
                      byProjectID.get(session.projectID);
                    return {
                      title: session.title || "Untitled session",
                      value: session.id,
                      date: new Date(session.time.updated).toLocaleDateString(),
                      project: basename(project?.canonical ?? directory),
                      projectID: session.projectID,
                      worktree:
                        !project || directory === project.canonical
                          ? "main"
                          : basename(directory),
                    };
                  };

                  const db = openIndex();
                  let indexReady: Promise<void> | undefined;
                  const byID = new Map(
                    sessions.map((session) => [session.id, session]),
                  );
                  const searchable = sessions.map((session) => ({
                    id: session.id,
                    title: session.title ?? "",
                    updated: session.time.updated,
                  }));
                  try {
                    const search = async (
                      query: string,
                      signal: AbortSignal,
                    ) => {
                      if (!normalize(query)) return [];
                      if (!indexReady)
                        indexReady = (async () => {
                          const indexed = db
                            .query(
                              "SELECT id, updated, version FROM indexed_sessions",
                            )
                            .all() as {
                            id: string;
                            updated: number;
                            version: number;
                          }[];
                          const known = new Map(
                            indexed.map((item) => [item.id, item]),
                          );
                          const pending = sessions.filter(
                            (session) =>
                              known.get(session.id)?.updated !==
                                session.time.updated ||
                              known.get(session.id)?.version !== indexVersion,
                          );
                          let position = 0;
                          let completed = 0;
                          let failed = 0;
                          if (pending.length) {
                            context.ui.toast.show({
                              message: `Indexing ${pending.length} sessions for transcript search…`,
                              duration: 5000,
                            });
                            // The local server keeps projected messages in SQLite. Read it without
                            // modifying its database; use the API for remote or out-of-date sessions.
                            const sourceFile = join(
                              process.env.XDG_DATA_HOME ||
                                join(homedir(), ".local", "share"),
                              "opencode",
                              "opencode.db",
                            );
                            let source: Database | undefined;
                            if (existsSync(sourceFile)) {
                              try {
                                source = new Database(sourceFile, {
                                  readonly: true,
                                });
                              } catch {
                                /* Fall back to the API. */
                              }
                            }
                            const sourceSession = source?.query(
                              "SELECT time_updated FROM session_v2 WHERE id = ?",
                            );
                            const sourceMessages = source?.query(
                              "SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq",
                            );
                            try {
                              await Promise.all(
                                Array.from(
                                  { length: Math.min(4, pending.length) },
                                  async () => {
                                    while (position < pending.length) {
                                      const session = pending[position++]!;
                                      try {
                                        const text: string[] = [];
                                        const local = sourceSession?.get(
                                          session.id,
                                        ) as
                                          | { time_updated: number }
                                          | undefined;
                                        if (
                                          local?.time_updated ===
                                            session.time.updated &&
                                          sourceMessages
                                        ) {
                                          for (const row of sourceMessages.all(
                                            session.id,
                                          ) as {
                                            type: string;
                                            data: string;
                                          }[]) {
                                            text.push(
                                              ...searchableText({
                                                ...JSON.parse(row.data),
                                                type: row.type,
                                              }),
                                            );
                                          }
                                        } else {
                                          const seen = new Set<string>();
                                          let next: string | undefined;
                                          for (;;) {
                                            const page =
                                              await context.client.message.list(
                                                {
                                                  sessionID: session.id,
                                                  limit: pageSize,
                                                  cursor: next,
                                                },
                                              );
                                            for (const message of page.data)
                                              text.push(
                                                ...searchableText(message),
                                              );
                                            const cursor =
                                              page.cursor.next ?? undefined;
                                            if (
                                              !page.data.length ||
                                              !cursor ||
                                              seen.has(cursor)
                                            )
                                              break;
                                            seen.add(cursor);
                                            next = cursor;
                                          }
                                        }
                                        db.transaction(() => {
                                          db.query(
                                            "INSERT INTO indexed_sessions (id, updated, title, version) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated, title=excluded.title, version=excluded.version",
                                          ).run(
                                            session.id,
                                            session.time.updated,
                                            session.title ?? "",
                                            indexVersion,
                                          );
                                          const row = db
                                            .query(
                                              "SELECT rowid FROM indexed_sessions WHERE id = ?",
                                            )
                                            .get(session.id) as {
                                            rowid: number;
                                          };
                                          db.query(
                                            "DELETE FROM session_text WHERE rowid = ?",
                                          ).run(row.rowid);
                                          db.query(
                                            "INSERT INTO session_text (rowid, id, body) VALUES (?, ?, ?)",
                                          ).run(
                                            row.rowid,
                                            session.id,
                                            text.join("\n"),
                                          );
                                        })();
                                      } catch {
                                        failed++;
                                      }
                                      completed++;
                                      if (completed % 100 === 0) {
                                        context.ui.toast.show({
                                          message: `Indexed ${completed}/${pending.length} sessions…`,
                                          duration: 3500,
                                        });
                                      }
                                      await new Promise((resolve) =>
                                        setTimeout(resolve, 0),
                                      );
                                    }
                                  },
                                ),
                              );
                            } finally {
                              source?.close();
                            }
                          }
                          if (failed)
                            context.ui.toast.show({
                              message: `${failed} sessions could not be indexed; retry the command to include them.`,
                              variant: "warning",
                            });
                        })();
                      await indexReady;
                      if (signal.aborted) return [];
                      const ids = await queryIndex(query, searchable, signal);
                      return ids.flatMap((id) => {
                        const session = byID.get(id);
                        return session ? [describe(session)] : [];
                      });
                    };
                    const details = async (
                      sessionID: string,
                      query: string,
                      signal: AbortSignal,
                    ) => {
                      const sourceFile = join(
                        process.env.XDG_DATA_HOME ||
                          join(homedir(), ".local", "share"),
                        "opencode",
                        "opencode.db",
                      );
                      if (existsSync(sourceFile)) {
                        try {
                          const local = await queryDetails(
                            sessionID,
                            query,
                            sourceFile,
                            byID.get(sessionID)?.time.updated ?? 0,
                            signal,
                          );
                          if (!local.unavailable) return local;
                        } catch (error) {
                          if (signal.aborted) throw error;
                        }
                      }
                      const messages: {
                        type: string;
                        time_created: number;
                        data: unknown;
                      }[] = [];
                      const seen = new Set<string>();
                      let cursor: string | undefined;
                      for (;;) {
                        if (signal.aborted)
                          throw new DOMException(
                            "Details cancelled",
                            "AbortError",
                          );
                        const page = await context.client.message.list(
                          { sessionID, limit: pageSize, cursor },
                          { signal },
                        );
                        for (const message of page.data)
                          messages.push({
                            type: message.type,
                            time_created: message.time.created,
                            data: message,
                          });
                        const next = page.cursor.next ?? undefined;
                        if (!page.data.length || !next || seen.has(next)) break;
                        seen.add(next);
                        cursor = next;
                      }
                      return queryDetails(
                        sessionID,
                        query,
                        sourceFile,
                        byID.get(sessionID)?.time.updated ?? 0,
                        signal,
                        messages,
                      );
                    };

                    const rename = async (item: Item, title: string) => {
                      const response: unknown =
                        await context.client.session.update({
                          sessionID: item.value,
                          title,
                        });
                      if (
                        response &&
                        typeof response === "object" &&
                        "error" in response &&
                        response.error
                      )
                        throw new Error(String(response.error));
                      const session = byID.get(item.value)!;
                      session.title = title;
                      const refreshed: unknown =
                        await context.client.session.get({
                          sessionID: item.value,
                        });
                      const info = (
                        refreshed &&
                        typeof refreshed === "object" &&
                        "data" in refreshed
                          ? refreshed.data
                          : refreshed
                      ) as Session;
                      session.time.updated = info.time.updated;
                      const indexed = searchable.find(
                        (entry) => entry.id === item.value,
                      );
                      if (indexed) {
                        indexed.title = title;
                        indexed.updated = session.time.updated;
                      }
                      return describe(session);
                    };
                    const remove = async (item: Item) => {
                      const response: unknown =
                        await context.client.session.remove({
                          sessionID: item.value,
                        });
                      if (
                        response &&
                        typeof response === "object" &&
                        "error" in response &&
                        response.error
                      )
                        throw new Error(String(response.error));
                      if (
                        response &&
                        typeof response === "object" &&
                        "data" in response &&
                        response.data === false
                      )
                        throw new Error("Session was not deleted");
                      const removed = new Set([item.value]);
                      let count = 0;
                      while (count !== removed.size) {
                        count = removed.size;
                        for (const session of sessions)
                          if (session.parentID && removed.has(session.parentID))
                            removed.add(session.id);
                      }
                      for (const id of removed) byID.delete(id);
                      for (
                        let index = searchable.length - 1;
                        index >= 0;
                        index--
                      )
                        if (removed.has(searchable[index]!.id))
                          searchable.splice(index, 1);
                      db.transaction(() => {
                        for (const id of removed) {
                          const row = db
                            .query(
                              "SELECT rowid FROM indexed_sessions WHERE id = ?",
                            )
                            .get(id) as { rowid: number } | null;
                          if (!row) continue;
                          db.query(
                            "DELETE FROM session_text WHERE rowid = ?",
                          ).run(row.rowid);
                          db.query(
                            "DELETE FROM indexed_sessions WHERE id = ?",
                          ).run(id);
                        }
                      })();
                      return [...removed];
                    };

                    const route = context.ui.router.current();
                    const projectID =
                      (route.type === "session"
                        ? byID.get(route.sessionID)?.projectID
                        : undefined) ??
                      byDirectory.get(
                        (context.location ?? context.data.location.default())
                          .directory,
                      )?.id ??
                      sessions.find(
                        (session) =>
                          session.location.directory ===
                          (context.location ?? context.data.location.default())
                            .directory,
                      )?.projectID ??
                      "";
                    const selection = await selectSession(
                      context,
                      input?.trim() ?? "",
                      sessions.map(describe),
                      projectID,
                      search,
                      details,
                      rename,
                      remove,
                    );
                    if (selection)
                      context.ui.router.navigate({
                        type: "session",
                        sessionID: selection,
                      });
                  } finally {
                    if (indexReady) await indexReady.catch(() => {});
                    db.close();
                  }
                } catch (error) {
                  context.ui.toast.show({
                    variant: "error",
                    message: `Session search failed: ${error instanceof Error ? error.message : String(error)}`,
                  });
                }
              },
            },
          ],
          bindings: [],
        }));
        return null;
      },
    });
  },
});
