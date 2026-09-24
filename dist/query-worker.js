// @bun
// src/query-worker.ts
import { Database } from "bun:sqlite";

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

// src/query-worker.ts
var normalize = (text) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max)
    return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1;i <= a.length; i++) {
    const current = [i];
    for (let j = 1;j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    if (Math.min(...current) > max)
      return max + 1;
    previous = current;
  }
  return previous[b.length];
}
function titleScore(title, query, terms) {
  const value = normalize(title);
  if (value.includes(query))
    return 120;
  const words = value.split(" ");
  const scores = terms.map((term) => {
    if (words.some((word) => word.startsWith(term)))
      return 85;
    if (term.length < 3)
      return 0;
    const max = term.length > 7 ? 2 : 1;
    return words.some((word) => distance(word, term, max) <= max) ? 55 : 0;
  });
  return scores.every(Boolean) ? Math.min(...scores) : 0;
}
function search(input) {
  const db = new Database(input.file, { readonly: true });
  try {
    const terms = normalize(input.query).split(" ").filter(Boolean);
    if (!terms.length)
      return [];
    const normalized = terms.join(" ");
    const found = new Map;
    const getHits = (expression) => db.query(`SELECT indexed_sessions.id AS id
           FROM session_text JOIN indexed_sessions ON indexed_sessions.rowid = session_text.rowid
           WHERE session_text MATCH ? ORDER BY bm25(session_text)`).all(expression);
    const termQuery = (word) => `"${word.replaceAll('"', '""')}"*`;
    if (terms.length > 1)
      for (const [rank, hit] of getHits(`"${normalized}"`).entries())
        found.set(hit.id, 110 + Math.max(0, 10 - rank));
    const exact = getHits(terms.map(termQuery).join(" AND "));
    for (const hit of exact)
      if (!found.has(hit.id))
        found.set(hit.id, 80);
    if (exact.length < 20) {
      const alternatives = terms.map((term) => {
        if (term.length < 3)
          return [term];
        const max = term.length > 7 ? 2 : 1;
        const words = db.query("SELECT term FROM session_words WHERE length(term) BETWEEN ? AND ?").all(term.length - max, term.length + max);
        return [
          term,
          ...words.map((row) => ({
            word: row.term,
            score: distance(row.term, term, max)
          })).filter((item) => item.score > 0 && item.score <= max).sort((a, b) => a.score - b.score).slice(0, 5).map((item) => item.word)
        ];
      });
      for (const hit of getHits(alternatives.map((group) => `(${group.map(termQuery).join(" OR ")})`).join(" AND ")))
        if (!found.has(hit.id))
          found.set(hit.id, 50);
    }
    return input.sessions.flatMap((session) => {
      const score = Math.max(titleScore(session.title, normalized, terms), found.get(session.id) ?? 0);
      return score ? [{ id: session.id, updated: session.updated, score }] : [];
    }).sort((a, b) => b.score - a.score || b.updated - a.updated).map((item) => item.id);
  } finally {
    db.close();
  }
}
function details(input) {
  const terms = normalize(input.query).split(" ").filter(Boolean);
  const timeline = [];
  const matches = [];
  let seen = 0;
  const excerpt = (text, at = 0, length = 190) => {
    const start = Math.max(0, at - 18);
    return `${start ? "\u2026" : ""}${text.slice(start, start + length).replace(/\s+/g, " ").trim()}`;
  };
  const collect = (row) => {
    seen++;
    const message = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
    if (row.type === "user" && message.text?.trim())
      timeline.push({
        text: excerpt(message.text, 0, 420),
        time: row.time_created,
        role: "You"
      });
    if (row.type === "assistant") {
      const text = message.content?.find((part) => part.type === "text" && part.text?.trim())?.text;
      if (text)
        timeline.push({
          text: excerpt(text, 0, 420),
          time: row.time_created,
          role: "Assistant"
        });
    }
    if (!terms.length)
      return;
    const part = searchableText({ ...message, type: row.type }).find((text) => {
      const value = normalize(text);
      return terms.every((term) => value.includes(term));
    });
    if (!part)
      return;
    const at = part.toLowerCase().indexOf(terms[0]);
    matches.push({
      text: excerpt(part, at < 0 ? 0 : at),
      time: row.time_created,
      role: row.type === "user" ? "You" : row.type === "assistant" ? "Assistant" : "Tool"
    });
  };
  if (input.messages) {
    for (const row of input.messages)
      collect(row);
  } else {
    const db = new Database(input.sourceFile, { readonly: true });
    try {
      const session = db.query("SELECT time_updated FROM session_v2 WHERE id = ?").get(input.sessionID);
      if (session?.time_updated !== input.updated)
        return {
          timeline: [],
          userCount: 0,
          assistantCount: 0,
          matches: [],
          matchCount: 0,
          unavailable: true
        };
      const sql = terms.length ? "SELECT type, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq" : "SELECT type, time_created, data FROM session_message WHERE session_id = ? AND type IN ('user', 'assistant') ORDER BY seq";
      for (const row of db.query(sql).iterate(input.sessionID))
        collect(row);
    } finally {
      db.close();
    }
  }
  if (!seen)
    return {
      timeline: [],
      userCount: 0,
      assistantCount: 0,
      matches: [],
      matchCount: 0,
      unavailable: !input.messages
    };
  const userCount = timeline.filter((line) => line.role === "You").length;
  const assistantCount = timeline.length - userCount;
  const matchCount = matches.length;
  const shownTimeline = timeline.length <= 80 ? timeline : [timeline[0], ...timeline.slice(-79)];
  const priority = (line) => line.role === "You" ? 0 : line.role === "Assistant" ? 1 : 2;
  return {
    timeline: shownTimeline,
    userCount,
    assistantCount,
    matches: matches.sort((a, b) => priority(a) - priority(b) || b.time - a.time).slice(0, 30),
    matchCount
  };
}
self.onmessage = (event) => {
  try {
    if (event.data.type === "search")
      self.postMessage({ ids: search(event.data) });
    else
      self.postMessage({ details: details(event.data) });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error)
    });
  }
};
