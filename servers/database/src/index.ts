import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import { resolve } from "path";

const DB_FILE = process.env.MCP_DB_PATH || resolve(process.cwd(), "mcp-shared.db");

const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ─── Server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "mcp-database",
  version: "1.0.0",
});

// ─── Helper: safe JSON serialize ───────────────────────────────────────────

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// ─── execute_query ─────────────────────────────────────────────────────────

server.tool(
  "execute_query",
  "Execute a SELECT query. Returns result rows as JSON. Use parameterized queries to prevent SQL injection.",
  {
    sql: z.string().describe("SQL SELECT query to execute. Use ? placeholders for parameters."),
    params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe("Query parameters for ? placeholders"),
  },
  async ({ sql, params }) => {
    const trimmed = sql.trim().toUpperCase();
    if (
      trimmed.startsWith("INSERT") ||
      trimmed.startsWith("UPDATE") ||
      trimmed.startsWith("DELETE") ||
      trimmed.startsWith("DROP") ||
      trimmed.startsWith("ALTER") ||
      trimmed.startsWith("CREATE")
    ) {
      return {
        content: [{ type: "text", text: "Error: execute_query only allows SELECT statements. Use execute_write for modifications." }],
        isError: true,
      };
    }

    const stmt = db.prepare(sql);
    const rows = params?.length ? stmt.all(...params) : stmt.all();

    return {
      content: [{ type: "text", text: safeStringify(rows) }],
    };
  }
);

// ─── execute_write ─────────────────────────────────────────────────────────

server.tool(
  "execute_write",
  "Execute INSERT, UPDATE, DELETE, CREATE, DROP, or ALTER statements. Always uses parameterized queries.",
  {
    sql: z.string().describe("SQL write statement. Use ? placeholders for parameters."),
    params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe("Query parameters"),
  },
  async ({ sql, params }) => {
    const stmt = db.prepare(sql);
    const result = params?.length ? stmt.run(...params) : stmt.run();

    return {
      content: [
        {
          type: "text",
          text: safeStringify({
            changes: result.changes,
            lastInsertRowid: Number(result.lastInsertRowid),
          }),
        },
      ],
    };
  }
);

// ─── list_tables ───────────────────────────────────────────────────────────

server.tool(
  "list_tables",
  "List all tables in the database.",
  {},
  async () => {
    const rows = db
      .prepare(
        `SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name`
      )
      .all();

    return {
      content: [{ type: "text", text: safeStringify(rows) }],
    };
  }
);

// ─── describe_table ────────────────────────────────────────────────────────

server.tool(
  "describe_table",
  "Get the schema (columns, types, constraints) of a table.",
  {
    table: z.string().describe("Table name"),
  },
  async ({ table }) => {
    // Validate table name to prevent injection
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      return {
        content: [{ type: "text", text: `Invalid table name: ${table}` }],
        isError: true,
      };
    }

    const columns = db.pragma(`table_info(${table})`);
    const createStmt = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
      .get(table) as { sql?: string } | undefined;

    return {
      content: [
        {
          type: "text",
          text: safeStringify({
            table,
            columns,
            ddl: createStmt?.sql ?? "(not available)",
          }),
        },
      ],
    };
  }
);

// ─── insert_rows ───────────────────────────────────────────────────────────

server.tool(
  "insert_rows",
  "Insert rows into a table. Provide column names and an array of value arrays.",
  {
    table: z.string().describe("Table name"),
    columns: z.array(z.string()).describe("Column names"),
    values: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe("Array of row values, each row is an array"),
  },
  async ({ table, columns, values }) => {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      return {
        content: [{ type: "text", text: `Invalid table name: ${table}` }],
        isError: true,
      };
    }

    const placeholders = columns.map(() => "?").join(", ");
    const colNames = columns.join(", ");
    const stmt = db.prepare(`INSERT INTO ${table} (${colNames}) VALUES (${placeholders})`);

    const insertMany = db.transaction((rows: typeof values) => {
      let count = 0;
      for (const row of rows) {
        stmt.run(...row);
        count++;
      }
      return count;
    });

    const count = insertMany(values);

    return {
      content: [{ type: "text", text: `Inserted ${count} row(s) into "${table}"` }],
    };
  }
);

// ─── Resource: database info ───────────────────────────────────────────────

server.resource(
  "db-info",
  "mcp-db://info",
  async () => ({
    contents: [
      {
        uri: "mcp-db://info",
        text: safeStringify({
          databaseFile: DB_FILE,
          sizeBytes: (() => { try { return require("fs").statSync(DB_FILE).size; } catch { return 0; } })(),
          tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
        }),
      },
    ],
  })
);

// ─── Start ─────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
