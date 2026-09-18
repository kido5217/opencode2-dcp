import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DcpMessage } from "./types.ts";

export class Logger {
  private logDir: string;
  public enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
    const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    this.logDir = join(configHome, "opencode", "logs", "dcp");
  }

  private async ensureLogDir() {
    if (!existsSync(this.logDir)) {
      await mkdir(this.logDir, { recursive: true });
    }
  }

  private formatData(data?: Record<string, unknown>): string {
    if (!data) return "";

    const parts: string[] = [];
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined || value === null) continue;

      // Format arrays compactly
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        parts.push(
          `${key}=[${value.slice(0, 3).join(",")}${value.length > 3 ? `...+${value.length - 3}` : ""}]`,
        );
      } else if (typeof value === "object") {
        const str = JSON.stringify(value);
        if (str.length < 50) {
          parts.push(`${key}=${str}`);
        }
      } else {
        parts.push(`${key}=${value}`);
      }
    }
    return parts.join(" ");
  }

  private getCallerFile(skipFrames = 3): string {
    const originalPrepareStackTrace = Error.prepareStackTrace;
    try {
      const err = new Error();
      Error.prepareStackTrace = (_, stack) => stack;
      const stack = err.stack as unknown as NodeJS.CallSite[];
      Error.prepareStackTrace = originalPrepareStackTrace;

      // Skip specified number of frames to get to actual caller
      for (let i = skipFrames; i < stack.length; i++) {
        const filename = stack[i]?.getFileName();
        if (filename && !filename.includes("/logger.")) {
          // Extract just the filename without path and extension
          const match = filename.match(/([^/\\]+)\.[tj]s$/);
          return match ? match[1] : filename;
        }
      }
      return "unknown";
    } catch {
      return "unknown";
    }
  }

  private async write(
    level: string,
    component: string,
    message: string,
    data?: Record<string, unknown>,
  ) {
    if (!this.enabled) return;

    try {
      await this.ensureLogDir();

      const timestamp = new Date().toISOString();
      const dataStr = this.formatData(data);

      const logLine = `${timestamp} ${level.padEnd(5)} ${component}: ${message}${dataStr ? " | " + dataStr : ""}\n`;

      const dailyLogDir = join(this.logDir, "daily");
      if (!existsSync(dailyLogDir)) {
        await mkdir(dailyLogDir, { recursive: true });
      }

      const logFile = join(dailyLogDir, `${new Date().toISOString().split("T")[0]}.log`);
      await writeFile(logFile, logLine, { flag: "a" });
    } catch {
      // Logging must never fail the pipeline.
    }
  }

  info(message: string, data?: Record<string, unknown>) {
    const component = this.getCallerFile(2);
    return this.write("INFO", component, message, data);
  }

  debug(message: string, data?: Record<string, unknown>) {
    const component = this.getCallerFile(2);
    return this.write("DEBUG", component, message, data);
  }

  warn(message: string, data?: Record<string, unknown>) {
    const component = this.getCallerFile(2);
    return this.write("WARN", component, message, data);
  }

  error(message: string, data?: Record<string, unknown>) {
    const component = this.getCallerFile(2);
    return this.write("ERROR", component, message, data);
  }

  /**
   * v2 adaptation of v1's `minimizeForDebug`: strips provider metadata and
   * non-textual content parts from the request shape before writing the
   * context debug dump.
   */
  private minimizeForDebug(messages: DcpMessage[]): object[] {
    return messages.map((msg) => {
      const content = msg.content
        .map((part) => {
          switch (part.type) {
            case "text":
              return { type: "text", text: part.text };
            case "reasoning":
              return { type: "reasoning", text: part.text };
            case "tool-call":
              return { type: "tool-call", id: part.id, tool: part.name, input: part.input };
            case "tool-result":
              return {
                type: "tool-result",
                id: part.id,
                tool: part.name,
                resultType: part.result.type,
              };
            default:
              return null;
          }
        })
        .filter((part): part is NonNullable<typeof part> => part !== null);

      return { role: msg.role, content };
    });
  }

  async saveContext(sessionId: string, messages: DcpMessage[]): Promise<void> {
    if (!this.enabled) return;

    try {
      const contextDir = join(this.logDir, "context", sessionId);
      if (!existsSync(contextDir)) {
        await mkdir(contextDir, { recursive: true });
      }

      const minimized = this.minimizeForDebug(messages).filter(
        (msg) =>
          Array.isArray((msg as { content?: unknown[] }).content) &&
          (msg as { content: unknown[] }).content.length > 0,
      );
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const contextFile = join(contextDir, `${timestamp}.json`);
      await writeFile(contextFile, JSON.stringify(minimized, null, 2));
    } catch {
      // Debug dumps must never fail the pipeline.
    }
  }
}
