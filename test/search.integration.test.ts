import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchableText } from "../src/message-text";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "opencode-search-"));
  directories.push(directory);
  const file = join(directory, "sessions.sqlite");
  const db = new Database(file);
  db.exec(`
    CREATE TABLE indexed_sessions (id TEXT PRIMARY KEY, updated INTEGER NOT NULL, title TEXT NOT NULL);
    CREATE VIRTUAL TABLE session_text USING fts5(id UNINDEXED, body, tokenize='unicode61 remove_diacritics 2');
    CREATE VIRTUAL TABLE session_words USING fts5vocab(session_text, 'row');
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, time_updated INTEGER NOT NULL);
    CREATE TABLE session_message (session_id TEXT, seq INTEGER, type TEXT, time_created INTEGER, data TEXT);
  `);

  const sessions = [
    { id: "ses_export", title: "Billing export", updated: 100 },
    { id: "ses_invoice", title: "Invoice reconciliation", updated: 200 },
  ];
  for (const session of sessions) {
    db.query(
      "INSERT INTO indexed_sessions (id, updated, title) VALUES (?, ?, ?)",
    ).run(session.id, session.updated, session.title);
    db.query("INSERT INTO session_v2 (id, time_updated) VALUES (?, ?)").run(
      session.id,
      session.updated,
    );
  }
  const messages = [
    {
      sessionID: "ses_export",
      type: "user",
      time: 1,
      data: {
        text: "Please inspect the report",
        files: [
          {
            name: "quarterly-march.csv",
            uri: "file:///reports/quarterly-march.csv",
          },
        ],
      },
    },
    {
      sessionID: "ses_invoice",
      type: "assistant",
      time: 2,
      data: {
        content: [
          { type: "text", text: "I checked the records" },
          {
            type: "tool",
            state: {
              input: { file: "ledger.toml" },
              outputPaths: ["/reports/ledger.toml"],
            },
          },
        ],
      },
    },
    {
      sessionID: "ses_invoice",
      type: "shell",
      time: 3,
      data: {
        command: "cat ledger.toml",
        output: "Processed statement",
      },
    },
  ];
  for (const [index, message] of messages.entries()) {
    db.query(
      "INSERT INTO session_message (session_id, seq, type, time_created, data) VALUES (?, ?, ?, ?, ?)",
    ).run(
      message.sessionID,
      index,
      message.type,
      message.time,
      JSON.stringify(message.data),
    );
  }
  for (const session of sessions) {
    const body = messages
      .filter((message) => message.sessionID === session.id)
      .flatMap((message) =>
        searchableText({ ...message.data, type: message.type }),
      )
      .join("\n");
    const row = db
      .query("SELECT rowid FROM indexed_sessions WHERE id = ?")
      .get(session.id) as { rowid: number };
    db.query("INSERT INTO session_text (rowid, id, body) VALUES (?, ?, ?)").run(
      row.rowid,
      session.id,
      body,
    );
  }
  db.close();
  return { file, sessions };
}

function request(input: object): Promise<{
  ids?: string[];
  details?: {
    timeline: { text: string; role?: string; time: number }[];
    matches: { text: string; role?: string; time: number }[];
    userCount: number;
    assistantCount: number;
    matchCount: number;
  };
  error?: string;
}> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("../src/query-worker.ts", import.meta.url),
    );
    worker.onmessage = (event) => {
      void worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data);
    };
    worker.onerror = (event) => {
      void worker.terminate();
      reject(new Error(event.message));
    };
    worker.postMessage(input);
  });
}

test("searches titles fuzzily and matches filenames inside real FTS rows", async () => {
  const { file, sessions } = fixture();
  expect(
    (await request({ type: "search", file, sessions, query: "invoce" })).ids,
  ).toContain("ses_invoice");
  expect(
    (
      await request({
        type: "search",
        file,
        sessions,
        query: "quarterly-march.csv",
      })
    ).ids,
  ).toEqual(["ses_export"]);
  expect(
    (await request({ type: "search", file, sessions, query: "ledger.toml" }))
      .ids,
  ).toContain("ses_invoice");
});

test("loads a V2 transcript and shows tool matches without tool timeline entries", async () => {
  const { file } = fixture();
  const result = (
    await request({
      type: "details",
      file,
      sourceFile: file,
      sessionID: "ses_invoice",
      updated: 200,
      query: "processed",
    })
  ).details!;
  expect(result).toMatchObject({
    userCount: 0,
    assistantCount: 1,
    matchCount: 1,
  });
  expect(result.timeline).toEqual([
    { text: "I checked the records", role: "Assistant", time: 2 },
  ]);
  expect(result.matches[0]).toMatchObject({
    role: "Tool",
    text: "Processed statement",
  });
});
