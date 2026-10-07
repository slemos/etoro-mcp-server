export interface RuntimeInfo {
  /** The Node.js version running the server (Claude Desktop bundles its own). */
  node: string;
  /** Whether the built-in `node:sqlite` module can be loaded here. */
  sqlite: boolean;
}

/** Reports what the host's Node.js can do, so features that need newer built-ins can be checked in place. */
export async function probeRuntime(): Promise<RuntimeInfo> {
  let sqlite = false;
  try {
    const mod = (await import("node:sqlite")) as { DatabaseSync?: unknown };
    sqlite = typeof mod.DatabaseSync === "function";
  } catch {
    // Older Node versions have no node:sqlite.
  }
  return { node: process.version, sqlite };
}
