import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, writeFile, readdir, stat, mkdir, rm, rename } from "fs/promises";
import { resolve, basename, dirname, extname, join, relative } from "path";
import { glob } from "glob";

const ROOTS = (process.env.MCP_FS_ROOTS || "C:/Users/夏云飞")
  .split(";")
  .map((r) => resolve(r));

function safeResolve(p: string): string {
  const r = resolve(p);
  const allowed = ROOTS.some((root) => {
    const sep = root.endsWith("/") || root.endsWith("\\") ? "" : "/";
    const normalized = (root + sep).replace(/\\/g, "/");
    return r.replace(/\\/g, "/").startsWith(normalized) || r.replace(/\\/g, "/") === root.replace(/\\/g, "/");
  });
  if (!allowed) {
    throw new Error(
      `Access denied: "${p}" is outside allowed roots. Allowed: ${ROOTS.join(", ")}`
    );
  }
  return r;
}

function fileIcon(entry: { name: string; isDir: boolean }): string {
  if (entry.isDir) return "📁";
  const ext = extname(entry.name).toLowerCase();
  const icons: Record<string, string> = {
    ".ts": "🔷", ".tsx": "⚛️", ".js": "🟨", ".jsx": "⚛️",
    ".json": "📋", ".md": "📝", ".html": "🌐", ".css": "🎨",
    ".py": "🐍", ".rs": "🦀", ".go": "🔵", ".java": "☕",
    ".sql": "🗄️", ".db": "🗄️", ".sqlite": "🗄️",
    ".png": "🖼️", ".jpg": "🖼️", ".jpeg": "🖼️", ".gif": "🖼️",
    ".pdf": "📕", ".zip": "📦", ".tar": "📦", ".gz": "📦",
    ".exe": "⚙️", ".dll": "⚙️", ".so": "⚙️",
    ".sh": "🐚", ".bash": "🐚", ".ps1": "🐚", ".bat": "🐚",
    ".yaml": "⚙️", ".yml": "⚙️", ".toml": "⚙️",
    ".env": "🔒", ".gitignore": "🙈",
  };
  return icons[ext] || "📄";
}

function isTextFile(filePath: string): boolean {
  const textExts = [
    ".txt", ".md", ".json", ".js", ".ts", ".tsx", ".jsx", ".html", ".css",
    ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp",
    ".yaml", ".yml", ".toml", ".xml", ".csv", ".sql", ".sh", ".bash",
    ".ps1", ".bat", ".env", ".gitignore", ".log", ".ini", ".cfg",
    ".vue", ".svelte", ".astro", ".graphql", ".proto",
  ];
  return textExts.includes(extname(filePath).toLowerCase());
}

// ─── Server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "mcp-filesystem",
  version: "1.0.0",
});

// ─── read_file ─────────────────────────────────────────────────────────────

server.tool(
  "read_file",
  "Read file contents. Returns text for text files, base64 for binary files.",
  {
    path: z.string().describe("Absolute or relative path to the file"),
    encoding: z.enum(["utf8", "base64"]).optional().default("utf8").describe("Encoding to use"),
  },
  async ({ path: filePath, encoding }) => {
    const resolved = safeResolve(filePath);

    if (encoding === "base64" || !isTextFile(resolved)) {
      const buffer = await readFile(resolved);
      return {
        content: [{ type: "text", text: buffer.toString("base64") }],
      };
    }

    const content = await readFile(resolved, "utf-8");
    const size = Buffer.byteLength(content, "utf-8");
    const lines = content.split("\n").length;

    return {
      content: [
        {
          type: "text",
          text: content.length > 50000
            ? content.slice(0, 50000) + `\n\n... (truncated, ${size} bytes, ${lines} lines total)`
            : content,
        },
      ],
    };
  }
);

// ─── write_file ────────────────────────────────────────────────────────────

server.tool(
  "write_file",
  "Write or overwrite a file. Creates parent directories if needed.",
  {
    path: z.string().describe("Path to the file to write"),
    content: z.string().describe("Content to write"),
    encoding: z.enum(["utf8", "base64"]).optional().default("utf8"),
  },
  async ({ path: filePath, content, encoding }) => {
    const resolved = safeResolve(filePath);
    await mkdir(dirname(resolved), { recursive: true });

    if (encoding === "base64") {
      await writeFile(resolved, Buffer.from(content, "base64"));
    } else {
      await writeFile(resolved, content, "utf-8");
    }

    const info = await stat(resolved);
    return {
      content: [{ type: "text", text: `File written: ${resolved} (${info.size} bytes)` }],
    };
  }
);

// ─── list_directory ────────────────────────────────────────────────────────

server.tool(
  "list_directory",
  "List contents of a directory with file metadata.",
  {
    path: z.string().describe("Path to the directory"),
    showHidden: z.boolean().optional().default(false).describe("Show hidden files (starting with .)"),
  },
  async ({ path: dirPath, showHidden }) => {
    const resolved = safeResolve(dirPath);
    const entries = await readdir(resolved, { withFileTypes: true });

    const items = await Promise.all(
      entries
        .filter((e) => showHidden || !e.name.startsWith("."))
        .map(async (entry) => {
          const fullPath = join(resolved, entry.name);
          let info;
          try {
            info = await stat(fullPath);
          } catch {
            info = null;
          }
          return {
            name: entry.name,
            type: entry.isDirectory() ? "directory" : "file",
            icon: fileIcon({ name: entry.name, isDir: entry.isDirectory() }),
            size: info?.size ?? 0,
            modified: info?.mtime.toISOString() ?? "",
          };
        })
    );

    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const lines = items.map(
      (i) => `${i.icon} ${i.name}${i.type === "directory" ? "/" : ""}  ${i.size} bytes  ${i.modified}`
    );

    return {
      content: [{ type: "text", text: lines.join("\n") || "(empty directory)" }],
    };
  }
);

// ─── create_directory ──────────────────────────────────────────────────────

server.tool(
  "create_directory",
  "Create a new directory, including any missing parent directories.",
  {
    path: z.string().describe("Path to the new directory"),
  },
  async ({ path: dirPath }) => {
    const resolved = safeResolve(dirPath);
    await mkdir(resolved, { recursive: true });
    return {
      content: [{ type: "text", text: `Directory created: ${resolved}` }],
    };
  }
);

// ─── delete_file ───────────────────────────────────────────────────────────

server.tool(
  "delete_file",
  "Delete a file or an empty directory.",
  {
    path: z.string().describe("Path to the file or directory to delete"),
    recursive: z.boolean().optional().default(false).describe("Recursively delete directories"),
  },
  async ({ path: deletePath, recursive }) => {
    const resolved = safeResolve(deletePath);
    await rm(resolved, { recursive, force: false });
    return {
      content: [{ type: "text", text: `Deleted: ${resolved}` }],
    };
  }
);

// ─── move_file ─────────────────────────────────────────────────────────────

server.tool(
  "move_file",
  "Move or rename a file or directory.",
  {
    source: z.string().describe("Source path"),
    destination: z.string().describe("Destination path"),
  },
  async ({ source, destination }) => {
    const src = safeResolve(source);
    const dst = safeResolve(destination);
    await mkdir(dirname(dst), { recursive: true });
    await rename(src, dst);
    return {
      content: [{ type: "text", text: `Moved: ${src} → ${dst}` }],
    };
  }
);

// ─── search_files ──────────────────────────────────────────────────────────

server.tool(
  "search_files",
  "Search for files matching a glob pattern.",
  {
    pattern: z.string().describe("Glob pattern (e.g. '**/*.ts', 'src/**/*.json')"),
    root: z.string().optional().describe("Root directory for the search (defaults to first allowed root)"),
    maxResults: z.number().optional().default(100).describe("Maximum number of results"),
  },
  async ({ pattern, root, maxResults }) => {
    const searchRoot = root ? safeResolve(root) : ROOTS[0];
    const results = await glob(pattern, {
      cwd: searchRoot,
      absolute: true,
      nodir: false,
      maxDepth: 20,
    });

    const limited = results.slice(0, maxResults);
    const display = limited
      .map((f) => relative(searchRoot, f))
      .join("\n");

    return {
      content: [
        {
          type: "text",
          text: display || "(no matches)",
        },
      ],
    };
  }
);

// ─── get_file_info ─────────────────────────────────────────────────────────

server.tool(
  "get_file_info",
  "Get metadata about a file or directory.",
  {
    path: z.string().describe("Path to the file or directory"),
  },
  async ({ path: infoPath }) => {
    const resolved = safeResolve(infoPath);
    const info = await stat(resolved);

    const details = {
      path: resolved,
      name: basename(resolved),
      size: info.size,
      isDirectory: info.isDirectory(),
      isFile: info.isFile(),
      created: info.birthtime.toISOString(),
      modified: info.mtime.toISOString(),
      accessed: info.atime.toISOString(),
      permissions: info.mode.toString(8),
    };

    return {
      content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    };
  }
);

// ─── roots_info (resource) ─────────────────────────────────────────────────

server.resource(
  "roots",
  "mcp-fs://roots",
  async () => ({
    contents: [
      {
        uri: "mcp-fs://roots",
        text: JSON.stringify(
          { allowedRoots: ROOTS, cwd: process.cwd() },
          null,
          2
        ),
      },
    ],
  })
);

// ─── Start ─────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
