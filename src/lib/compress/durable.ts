import type { WithPart, WithPartInfo, WithParts } from "./withparts.ts";
import type { ToolStatus } from "../types.ts";

/**
 * v2 durable session messages -> v1 `WithParts` adapter — the single point
 * of shape adaptation for the compress tool.
 *
 * `ctx.session.context({ sessionID })` resolves to durable
 * `SessionMessageInfo[]` (structural mirror of the installed @opencode/schema
 * `session-message` schema):
 *
 *   user       { type, id, text, time: { created }, ... }
 *   assistant  { type, id, agent?, model?: { id, providerID, variant? },
 *                content?: (text | reasoning | tool)[], tokens?,
 *                time: { created } }
 *   compaction { type, id, status?, summary?, recent?, time: { created } }
 *
 * The adapter produces `WithParts` (withparts.ts), the shape the v1 compress
 * internals (search, range/message utils, state, pipeline) operate on
 * verbatim.
 */

export interface DurableTime {
  created?: number;
  ran?: number;
  completed?: number;
  [key: string]: unknown;
}

export interface DurableFileText {
  type?: string;
  text?: string;
  uri?: string;
  [key: string]: unknown;
}

export interface DurableToolState {
  status?: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  output?: DurableFileText[];
  error?: DurableFileText[];
  time?: DurableTime;
  [key: string]: unknown;
}

export interface DurableContentPart {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  state?: DurableToolState;
  [key: string]: unknown;
}

export interface DurableMessage {
  type: string;
  id?: string;
  text?: string;
  agent?: string;
  model?: {
    id?: string;
    providerID?: string;
    variant?: string;
    [key: string]: unknown;
  };
  content?: DurableContentPart[];
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
    [key: string]: unknown;
  };
  summary?: string;
  status?: string;
  time?: DurableTime;
  [key: string]: unknown;
}

function readCreated(value: unknown): number {
  if (value && typeof value === "object" && typeof (value as DurableTime).created === "number") {
    return (value as DurableTime).created as number;
  }
  return 0;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function filesToText(parts: DurableFileText[] | undefined): string | undefined {
  if (!Array.isArray(parts)) return undefined;
  const lines = parts.map((part) =>
    part.type === "file" && typeof part.uri === "string" ? part.uri : (part.text ?? ""),
  );
  const joined = lines.filter((line) => line.length > 0).join("\n");
  return joined.length > 0 ? joined : undefined;
}

function mapToolState(state: DurableToolState | undefined): WithPart["state"] {
  const status: ToolStatus =
    state?.status === "completed"
      ? "completed"
      : state?.status === "error"
        ? "error"
        : state?.status === "streaming" || state?.status === "running"
          ? "running"
          : "pending";
  const time = state?.time;
  return {
    status,
    input: state?.input,
    output: filesToText(state?.output),
    error: filesToText(state?.error),
    metadata: state?.metadata,
    time: {
      start: finite(time?.ran) ?? finite(time?.created),
      end: finite(time?.completed),
    },
  };
}

/**
 * Adapt durable session messages to the v1 `WithParts` shape. Entries without
 * a string `id` (e.g. `agent-switched`, `model-selected`, `location-switched`,
 * `idle`, `synthetic`, `system`, `skill`, `shell`) carry no transcript
 * content for the compress pipeline and are dropped.
 */
export function toWithParts(messages: readonly DurableMessage[], sessionID: string): WithParts[] {
  const out: WithParts[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (typeof message.id !== "string" || message.id.length === 0) continue;
    const created = readCreated(message.time);
    switch (message.type) {
      case "user": {
        out.push({
          info: { id: message.id, sessionID, role: "user", time: { created } },
          parts:
            typeof message.text === "string" && message.text.length > 0
              ? [{ type: "text", text: message.text }]
              : [],
        });
        break;
      }
      case "assistant": {
        const info: WithPartInfo = {
          id: message.id,
          sessionID,
          role: "assistant",
          time: { created },
        };
        const model = message.model;
        if (typeof message.agent === "string") info.agent = message.agent;
        if (model && typeof model === "object") {
          info.model = {
            providerID: typeof model.providerID === "string" ? model.providerID : undefined,
            modelID: typeof model.id === "string" ? model.id : undefined,
            variant: typeof model.variant === "string" ? model.variant : undefined,
          };
        }
        const tokens = message.tokens;
        if (tokens && typeof tokens === "object") {
          info.tokens = {
            input: finite(tokens.input),
            output: finite(tokens.output),
            reasoning: finite(tokens.reasoning),
            cache: {
              read: finite(tokens.cache?.read),
              write: finite(tokens.cache?.write),
            },
          };
        }
        const parts: WithPart[] = [];
        for (const part of message.content ?? []) {
          if (!part || typeof part !== "object") continue;
          if (part.type === "text" && typeof part.text === "string") {
            parts.push({ type: "text", text: part.text });
          } else if (part.type === "reasoning" && typeof part.text === "string") {
            parts.push({ type: "reasoning", text: part.text });
          } else if (part.type === "tool" && typeof part.id === "string") {
            parts.push({
              type: "tool",
              tool: typeof part.name === "string" ? part.name : undefined,
              callID: part.id,
              state: mapToolState(part.state),
            });
          }
        }
        out.push({ info, parts });
        break;
      }
      case "compaction": {
        // A failed compaction produced no summary; treating it as the v1
        // compaction marker (info.summary === true) would wrongly anchor
        // lastCompaction, so skip it. Running/completed entries map to the
        // v1 marker with the summary text kept as a part for the search
        // context.
        if (message.status === "failed") break;
        out.push({
          info: {
            id: message.id,
            sessionID,
            role: "assistant",
            summary: true,
            time: { created },
          },
          parts:
            typeof message.summary === "string" && message.summary.length > 0
              ? [{ type: "text", text: message.summary }]
              : [],
        });
        break;
      }
      default:
        break;
    }
  }
  return out;
}
