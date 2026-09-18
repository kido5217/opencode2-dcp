/**
 * Minimal ambient types for the host runtime's `bun:sqlite` builtin (the
 * opencode host runs plugin modules on Bun). Only the read-only surface the
 * DCP bridge uses.
 */
declare module "bun:sqlite" {
  interface SqliteStatement {
    all(...params: unknown[]): unknown[];
  }
  export class Database {
    constructor(path: string, options?: { readonly?: boolean });
    query(sql: string): SqliteStatement;
    close(): void;
  }
}
