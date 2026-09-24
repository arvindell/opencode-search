export type DetailLine = { text: string; time: number; role?: string };
export type SessionDetails = {
  timeline: DetailLine[];
  userCount: number;
  assistantCount: number;
  matches: DetailLine[];
  matchCount: number;
  unavailable?: boolean;
};

export function searchableText(input: unknown) {
  const message = input as {
    type: string;
    text?: string;
    files?: { uri?: string; name?: string; description?: string }[];
    command?: string;
    output?: string;
    summary?: string;
    recent?: string;
    snapshot?: { files?: string[] };
    content?: {
      type: string;
      text?: string;
      state?: {
        input?: unknown;
        content?: {
          type: string;
          text?: string;
          name?: string;
          uri?: string;
        }[];
        attachments?: { uri?: string; name?: string }[];
        outputPaths?: string[];
      };
    }[];
  };
  const text: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value && !value.startsWith("data:"))
      text.push(value);
  };
  const strings = (value: unknown) => {
    if (typeof value === "string") return add(value);
    if (Array.isArray(value)) return value.forEach(strings);
    if (!value || typeof value !== "object") return;
    for (const [key, field] of Object.entries(value)) {
      if (/base64|image|binary|credential|token|secret/i.test(key)) continue;
      strings(field);
    }
  };

  if (
    message.type === "user" ||
    message.type === "synthetic" ||
    message.type === "system"
  )
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
    for (const file of message.snapshot?.files ?? []) add(file);
    for (const part of message.content ?? []) {
      if (part.type === "text") add(part.text);
      if (part.type !== "tool") continue;
      strings(part.state?.input);
      for (const content of part.state?.content ?? []) {
        if (content.type === "text") add(content.text);
        add(content.name);
        add(content.uri);
      }
      for (const attachment of part.state?.attachments ?? []) {
        add(attachment.name);
        add(attachment.uri);
      }
      for (const path of part.state?.outputPaths ?? []) add(path);
    }
  }
  return text;
}
