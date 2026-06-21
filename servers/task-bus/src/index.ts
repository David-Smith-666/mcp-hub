import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import { resolve } from "path";

const DB_FILE = process.env.MCP_TASK_DB || process.env.MCP_DB_PATH || resolve(process.cwd(), "mcp-shared.db");

const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ─── Init schema ───────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS task_queue (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    description TEXT,
    status      TEXT    NOT NULL DEFAULT 'pending'
                       CHECK(status IN ('pending','assigned','in_progress','completed','failed')),
    priority    INTEGER NOT NULL DEFAULT 0,
    assigned_agent TEXT,
    created_by  TEXT,
    result      TEXT,
    error       TEXT,
    context_json TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS shared_state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Layer 3: AI-to-AI task routing
  CREATE TABLE IF NOT EXISTS agent_registry (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL UNIQUE,
    display_name TEXT    NOT NULL,
    role         TEXT    NOT NULL,
    capabilities TEXT    NOT NULL DEFAULT '[]',
    status       TEXT    NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active','inactive')),
    layer        INTEGER NOT NULL DEFAULT 3,
    metadata     TEXT,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS route_rules (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern      TEXT    NOT NULL,
    description  TEXT,
    target_agent TEXT    NOT NULL,
    priority     INTEGER NOT NULL DEFAULT 5,
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (target_agent) REFERENCES agent_registry(name) ON DELETE CASCADE
  );
`);

// ─── Helpers ───────────────────────────────────────────────────────────────

const TASK_STATUSES = ["pending", "assigned", "in_progress", "completed", "failed"] as const;

function safeStringify(value: unknown): string {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function taskRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assigned_agent: row.assigned_agent,
    created_by: row.created_by,
    result: row.result,
    error: row.error,
    context: row.context_json ? JSON.parse(row.context_json as string) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function agentRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    display_name: row.display_name,
    role: row.role,
    capabilities: row.capabilities ? JSON.parse(row.capabilities as string) : [],
    status: row.status,
    layer: row.layer,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function ruleRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    pattern: row.pattern,
    description: row.description,
    target_agent: row.target_agent,
    priority: row.priority,
    enabled: row.enabled,
    created_at: row.created_at,
  };
}

// ─── Default Layer-3 agents (excludes Claude Code Desktop official) ─────────

const DEFAULT_AGENTS: Array<{
  name: string; display_name: string; role: string; capabilities: string[]; metadata?: Record<string, unknown>;
}> = [
  {
    name: "claude-code",
    display_name: "Claude Code",
    role: "思考/规划",
    capabilities: ["planning", "architecture", "code-review", "debugging", "refactoring"],
    metadata: { provider: "DeepSeek", model: "deepseek-v4-pro", type: "cli" },
  },
  {
    name: "codex",
    display_name: "Codex",
    role: "执行/编码",
    capabilities: ["code-generation", "file-operations", "shell-execution", "testing", "build"],
    metadata: { provider: "OpenAI", model: "gpt-5.5" },
  },
  {
    name: "hermes-agent",
    display_name: "Hermes Agent",
    role: "本地智能体",
    capabilities: ["local-operations", "automation", "memory-management", "skill-execution"],
    metadata: { type: "local" },
  },
  {
    name: "qclaw",
    display_name: "QClaw",
    role: "Windows系统操控/微信远程",
    capabilities: ["windows-control", "wechat", "browser", "screenshot", "system-monitoring"],
    metadata: { provider: "Tencent", type: "desktop" },
  },
  {
    name: "kun",
    display_name: "鲲",
    role: "本地DeepSeek Agent",
    capabilities: ["code-analysis", "document-processing", "local-inference"],
    metadata: { provider: "DeepSeek", type: "local" },
  },
  {
    name: "kimi",
    display_name: "Kimi",
    role: "研究/调研",
    capabilities: ["research", "web-search", "document-analysis", "summarization"],
    metadata: { provider: "Moonshot", type: "cloud" },
  },
];

// Seed default agents if registry is empty
const existingCount = (db.prepare("SELECT COUNT(*) as c FROM agent_registry").get() as { c: number }).c;
if (existingCount === 0) {
  const insertAgent = db.prepare(
    `INSERT INTO agent_registry (name, display_name, role, capabilities, layer, metadata)
     VALUES (?, ?, ?, ?, 3, ?)`
  );
  for (const agent of DEFAULT_AGENTS) {
    insertAgent.run(agent.name, agent.display_name, agent.role, JSON.stringify(agent.capabilities), agent.metadata ? JSON.stringify(agent.metadata) : null);
  }
}

// Seed default routing rules if empty
const existingRules = (db.prepare("SELECT COUNT(*) as c FROM route_rules").get() as { c: number }).c;
if (existingRules === 0) {
  const insertRule = db.prepare(
    `INSERT INTO route_rules (pattern, description, target_agent, priority) VALUES (?, ?, ?, ?)`
  );
  const defaultRules = [
    ["代码分析|code.analysis|code.review|性能|performance|优化|optimization|文档处理|document.processing", "代码分析/性能优化/文档处理", "kun", 10],
    ["调研|研究|research|搜索|search|文献|资料整理|综述|分析报告", "调研/分析类任务", "kimi", 10],
    ["实现|implement|build|refactor|编写|修改|重构|新增功能|写代码|脚本|script|开发|develop|create|编程", "编码/实现类任务", "codex", 10],
    ["测试|test|调试|debug|修复|fix|bug|错误|排错", "测试/修复类任务", "codex", 10],
    ["规划|架构|设计|design|architecture|方案|计划", "规划/架构类任务", "claude-code", 10],
    ["Windows|截图|微信|browser|浏览器|桌面操控|系统操控", "Windows系统/微信操控", "qclaw", 9],
    ["本地|自动化|automation|memory|skill|定时|排程|cron", "本地自动化任务", "hermes-agent", 7],
  ];
  for (const [pattern, description, target_agent, priority] of defaultRules) {
    insertRule.run(pattern, description, target_agent, priority);
  }
}

// ─── Server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "mcp-task-bus",
  version: "1.0.0",
});

// ─── task_create ───────────────────────────────────────────────────────────

server.tool(
  "task_create",
  "Create a new task in the collaboration queue. Use this to delegate work to another AI agent.",
  {
    title: z.string().describe("Task title — short and actionable"),
    description: z.string().optional().describe("Detailed task description"),
    priority: z.number().int().min(0).max(10).optional().default(5).describe("Priority 0-10, higher = more urgent"),
    assigned_agent: z.string().optional().describe("Target agent name (e.g. 'Codex', 'Kimi', 'Claude Code') — leave empty for any"),
    created_by: z.string().optional().describe("Agent creating this task"),
    context: z.record(z.unknown()).optional().describe("Structured context data (file paths, URLs, config, etc.)"),
  },
  async ({ title, description, priority, assigned_agent, created_by, context }) => {
    const stmt = db.prepare(
      `INSERT INTO task_queue (title, description, priority, assigned_agent, created_by, context_json, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`
    );
    const result = stmt.run(title, description ?? null, priority, assigned_agent ?? null, created_by ?? null, context ? JSON.stringify(context) : null);

    const task = db.prepare("SELECT * FROM task_queue WHERE id = ?").get(Number(result.lastInsertRowid)) as Record<string, unknown>;

    return {
      content: [{ type: "text", text: safeStringify(taskRow(task)) }],
    };
  }
);

// ─── task_claim ────────────────────────────────────────────────────────────

server.tool(
  "task_claim",
  "Claim a pending task to take ownership. Status changes: pending → assigned.",
  {
    task_id: z.number().int().describe("Task ID to claim"),
    agent: z.string().describe("Agent name claiming this task"),
  },
  async ({ task_id, agent }) => {
    const task = db.prepare("SELECT * FROM task_queue WHERE id = ?").get(task_id) as Record<string, unknown> | undefined;

    if (!task) {
      return { content: [{ type: "text", text: `Task #${task_id} not found` }], isError: true };
    }
    if (task.status !== "pending") {
      return { content: [{ type: "text", text: `Task #${task_id} is already ${task.status}, cannot claim` }], isError: true };
    }

    db.prepare(
      `UPDATE task_queue SET status = 'assigned', assigned_agent = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(agent, task_id);

    const updated = db.prepare("SELECT * FROM task_queue WHERE id = ?").get(task_id) as Record<string, unknown>;
    return {
      content: [{ type: "text", text: safeStringify(taskRow(updated)) }],
    };
  }
);

// ─── task_start ────────────────────────────────────────────────────────────

server.tool(
  "task_start",
  "Start working on an assigned task. Status changes: assigned → in_progress.",
  {
    task_id: z.number().int().describe("Task ID to start"),
    agent: z.string().describe("Agent name confirming start"),
  },
  async ({ task_id, agent }) => {
    const task = db.prepare("SELECT * FROM task_queue WHERE id = ?").get(task_id) as Record<string, unknown> | undefined;

    if (!task) {
      return { content: [{ type: "text", text: `Task #${task_id} not found` }], isError: true };
    }
    if (task.status !== "assigned" && task.status !== "pending") {
      return { content: [{ type: "text", text: `Task #${task_id} is ${task.status}, cannot start` }], isError: true };
    }
    if (task.assigned_agent && task.assigned_agent !== agent) {
      return { content: [{ type: "text", text: `Task #${task_id} is assigned to ${task.assigned_agent}, not ${agent}` }], isError: true };
    }

    db.prepare(
      `UPDATE task_queue SET status = 'in_progress', assigned_agent = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(agent, task_id);

    const updated = db.prepare("SELECT * FROM task_queue WHERE id = ?").get(task_id) as Record<string, unknown>;
    return {
      content: [{ type: "text", text: safeStringify(taskRow(updated)) }],
    };
  }
);

// ─── task_complete ─────────────────────────────────────────────────────────

server.tool(
  "task_complete",
  "Mark a task as completed with results. Status changes: in_progress → completed.",
  {
    task_id: z.number().int().describe("Task ID to complete"),
    agent: z.string().describe("Agent name confirming completion"),
    result: z.string().optional().describe("Summary of what was done / output produced"),
  },
  async ({ task_id, agent, result }) => {
    const task = db.prepare("SELECT * FROM task_queue WHERE id = ?").get(task_id) as Record<string, unknown> | undefined;

    if (!task) {
      return { content: [{ type: "text", text: `Task #${task_id} not found` }], isError: true };
    }
    if (task.status !== "in_progress" && task.status !== "assigned") {
      return { content: [{ type: "text", text: `Task #${task_id} is ${task.status}, cannot complete` }], isError: true };
    }

    db.prepare(
      `UPDATE task_queue SET status = 'completed', result = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(result ?? null, task_id);

    const updated = db.prepare("SELECT * FROM task_queue WHERE id = ?").get(task_id) as Record<string, unknown>;
    return {
      content: [{ type: "text", text: safeStringify(taskRow(updated)) }],
    };
  }
);

// ─── task_fail ─────────────────────────────────────────────────────────────

server.tool(
  "task_fail",
  "Mark a task as failed with an error description.",
  {
    task_id: z.number().int().describe("Task ID to fail"),
    agent: z.string().describe("Agent reporting the failure"),
    error: z.string().describe("Description of what went wrong"),
  },
  async ({ task_id, agent, error }) => {
    const task = db.prepare("SELECT * FROM task_queue WHERE id = ?").get(task_id) as Record<string, unknown> | undefined;

    if (!task) {
      return { content: [{ type: "text", text: `Task #${task_id} not found` }], isError: true };
    }

    db.prepare(
      `UPDATE task_queue SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(error, task_id);

    const updated = db.prepare("SELECT * FROM task_queue WHERE id = ?").get(task_id) as Record<string, unknown>;
    return {
      content: [{ type: "text", text: safeStringify(taskRow(updated)) }],
    };
  }
);

// ─── task_list ─────────────────────────────────────────────────────────────

server.tool(
  "task_list",
  "List tasks in the collaboration queue with optional filters.",
  {
    status: z.enum(TASK_STATUSES).optional().describe("Filter by status"),
    agent: z.string().optional().describe("Filter by assigned agent"),
    created_by: z.string().optional().describe("Filter by creator"),
    limit: z.number().int().min(1).max(200).optional().default(50).describe("Max results"),
    offset: z.number().int().min(0).optional().default(0).describe("Pagination offset"),
  },
  async ({ status, agent, created_by, limit, offset }) => {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status) { conditions.push("status = ?"); params.push(status); }
    if (agent) { conditions.push("assigned_agent = ?"); params.push(agent); }
    if (created_by) { conditions.push("created_by = ?"); params.push(created_by); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT * FROM task_queue ${where} ORDER BY priority DESC, created_at DESC LIMIT ? OFFSET ?`;

    const rows = db.prepare(sql).all(...params, limit, offset) as Record<string, unknown>[];
    const tasks = rows.map(taskRow);

    return {
      content: [{ type: "text", text: safeStringify(tasks) }],
    };
  }
);

// ─── task_get ──────────────────────────────────────────────────────────────

server.tool(
  "task_get",
  "Get full details of a specific task by ID.",
  {
    task_id: z.number().int().describe("Task ID"),
  },
  async ({ task_id }) => {
    const task = db.prepare("SELECT * FROM task_queue WHERE id = ?").get(task_id) as Record<string, unknown> | undefined;

    if (!task) {
      return { content: [{ type: "text", text: `Task #${task_id} not found` }], isError: true };
    }

    return {
      content: [{ type: "text", text: safeStringify(taskRow(task)) }],
    };
  }
);

// ─── task_reassign ─────────────────────────────────────────────────────────

server.tool(
  "task_reassign",
  "Reassign a failed or pending task to a different agent.",
  {
    task_id: z.number().int().describe("Task ID"),
    new_agent: z.string().describe("New agent name"),
  },
  async ({ task_id, new_agent }) => {
    const task = db.prepare("SELECT * FROM task_queue WHERE id = ?").get(task_id) as Record<string, unknown> | undefined;

    if (!task) {
      return { content: [{ type: "text", text: `Task #${task_id} not found` }], isError: true };
    }
    if (task.status !== "failed" && task.status !== "pending") {
      return { content: [{ type: "text", text: `Task #${task_id} is ${task.status}, can only reassign failed or pending tasks` }], isError: true };
    }

    db.prepare(
      `UPDATE task_queue SET status = 'assigned', assigned_agent = ?, error = NULL, updated_at = datetime('now') WHERE id = ?`
    ).run(new_agent, task_id);

    const updated = db.prepare("SELECT * FROM task_queue WHERE id = ?").get(task_id) as Record<string, unknown>;
    return {
      content: [{ type: "text", text: safeStringify(taskRow(updated)) }],
    };
  }
);

// ─── state_set ─────────────────────────────────────────────────────────────

server.tool(
  "state_set",
  "Set a shared key-value state entry. All connected AI agents can read this.",
  {
    key: z.string().min(1).describe("State key"),
    value: z.string().describe("State value (string, or JSON-encoded object)"),
  },
  async ({ key, value }) => {
    db.prepare(
      `INSERT INTO shared_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    ).run(key, value);

    return {
      content: [{ type: "text", text: `State "${key}" set.` }],
    };
  }
);

// ─── state_get ─────────────────────────────────────────────────────────────

server.tool(
  "state_get",
  "Get a shared state value by key.",
  {
    key: z.string().describe("State key to retrieve"),
  },
  async ({ key }) => {
    const row = db.prepare("SELECT * FROM shared_state WHERE key = ?").get(key) as Record<string, unknown> | undefined;

    if (!row) {
      return { content: [{ type: "text", text: `State "${key}" not found` }], isError: true };
    }

    return {
      content: [{ type: "text", text: safeStringify({ key: row.key, value: row.value, updated_at: row.updated_at }) }],
    };
  }
);

// ─── state_list ────────────────────────────────────────────────────────────

server.tool(
  "state_list",
  "List all shared state keys.",
  {
    prefix: z.string().optional().describe("Filter keys by prefix"),
  },
  async ({ prefix }) => {
    let rows: Record<string, unknown>[];
    if (prefix) {
      rows = db.prepare("SELECT key, updated_at FROM shared_state WHERE key LIKE ? ORDER BY key").all(prefix + "%") as Record<string, unknown>[];
    } else {
      rows = db.prepare("SELECT key, updated_at FROM shared_state ORDER BY key").all() as Record<string, unknown>[];
    }

    return {
      content: [{ type: "text", text: safeStringify(rows) }],
    };
  }
);

// ─── state_delete ──────────────────────────────────────────────────────────

server.tool(
  "state_delete",
  "Delete a shared state entry.",
  {
    key: z.string().describe("State key to delete"),
  },
  async ({ key }) => {
    const result = db.prepare("DELETE FROM shared_state WHERE key = ?").run(key);
    return {
      content: [{ type: "text", text: result.changes > 0 ? `State "${key}" deleted.` : `State "${key}" not found.` }],
    };
  }
);

// ─── task_stats ────────────────────────────────────────────────────────────

server.tool(
  "task_stats",
  "Get task queue statistics — count by status and agent.",
  {},
  async () => {
    const byStatus = db.prepare("SELECT status, COUNT(*) as count FROM task_queue GROUP BY status").all();
    const byAgent = db.prepare("SELECT assigned_agent, status, COUNT(*) as count FROM task_queue WHERE assigned_agent IS NOT NULL GROUP BY assigned_agent, status ORDER BY assigned_agent").all();

    return {
      content: [{ type: "text", text: safeStringify({ by_status: byStatus, by_agent: byAgent }) }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
//  Layer 3: AI-to-AI Task Routing
// ═══════════════════════════════════════════════════════════════════════════════

// ─── agent_register ─────────────────────────────────────────────────────────

server.tool(
  "agent_register",
  "[Layer 3] Register an AI agent into the task routing layer. Registered agents become eligible to receive auto-routed tasks.",
  {
    name: z.string().regex(/^[a-z0-9_-]+$/).describe("Unique agent identifier (slug: lowercase, hyphens, underscores)"),
    display_name: z.string().describe("Human-readable agent name, e.g. 'Claude Code'"),
    role: z.string().describe("Agent's role description, e.g. '思考/规划', '执行/编码'"),
    capabilities: z.array(z.string()).describe("List of capabilities, e.g. ['planning', 'code-review']"),
    metadata: z.record(z.unknown()).optional().describe("Additional metadata (provider, model, etc.)"),
  },
  async ({ name, display_name, role, capabilities, metadata }) => {
    const existing = db.prepare("SELECT id FROM agent_registry WHERE name = ?").get(name);
    if (existing) {
      return { content: [{ type: "text", text: `Agent "${name}" is already registered. Use agent_update to modify.` }], isError: true };
    }

    db.prepare(
      `INSERT INTO agent_registry (name, display_name, role, capabilities, layer, metadata)
       VALUES (?, ?, ?, ?, 3, ?)`
    ).run(name, display_name, role, JSON.stringify(capabilities), metadata ? JSON.stringify(metadata) : null);

    const agent = db.prepare("SELECT * FROM agent_registry WHERE name = ?").get(name) as Record<string, unknown>;
    return { content: [{ type: "text", text: safeStringify(agentRow(agent)) }] };
  }
);

// ─── agent_unregister ──────────────────────────────────────────────────────

server.tool(
  "agent_unregister",
  "[Layer 3] Remove an agent from the routing layer. Routed tasks will no longer target this agent.",
  {
    name: z.string().describe("Agent identifier to remove"),
  },
  async ({ name }) => {
    const result = db.prepare("DELETE FROM agent_registry WHERE name = ? AND layer = 3").run(name);
    if (result.changes === 0) {
      return { content: [{ type: "text", text: `Agent "${name}" not found in routing layer.` }], isError: true };
    }
    return { content: [{ type: "text", text: `Agent "${name}" removed from Layer-3 routing.` }] };
  }
);

// ─── agent_list ─────────────────────────────────────────────────────────────

server.tool(
  "agent_list",
  "[Layer 3] List all agents registered in the routing layer.",
  {
    status: z.enum(["active", "inactive"]).optional().describe("Filter by status"),
    layer: z.number().int().optional().default(3).describe("Layer filter (default 3)"),
  },
  async ({ status, layer }) => {
    const conditions: string[] = ["layer = ?"];
    const params: unknown[] = [layer ?? 3];
    if (status) { conditions.push("status = ?"); params.push(status); }

    const rows = db.prepare(
      `SELECT * FROM agent_registry WHERE ${conditions.join(" AND ")} ORDER BY name`
    ).all(...params) as Record<string, unknown>[];

    return { content: [{ type: "text", text: safeStringify(rows.map(agentRow)) }] };
  }
);

// ─── agent_update ───────────────────────────────────────────────────────────

server.tool(
  "agent_update",
  "[Layer 3] Update an agent's status, capabilities, or metadata.",
  {
    name: z.string().describe("Agent identifier"),
    status: z.enum(["active", "inactive"]).optional().describe("New status"),
    capabilities: z.array(z.string()).optional().describe("New capabilities list"),
    metadata: z.record(z.unknown()).optional().describe("New metadata (merged into existing)"),
  },
  async ({ name, status, capabilities, metadata }) => {
    const agent = db.prepare("SELECT * FROM agent_registry WHERE name = ? AND layer = 3").get(name) as Record<string, unknown> | undefined;
    if (!agent) {
      return { content: [{ type: "text", text: `Agent "${name}" not found in routing layer.` }], isError: true };
    }

    if (status) {
      db.prepare("UPDATE agent_registry SET status = ?, updated_at = datetime('now') WHERE name = ?").run(status, name);
    }
    if (capabilities) {
      db.prepare("UPDATE agent_registry SET capabilities = ?, updated_at = datetime('now') WHERE name = ?").run(JSON.stringify(capabilities), name);
    }
    if (metadata) {
      const existingMeta = agent.metadata ? JSON.parse(agent.metadata as string) : {};
      const merged = { ...existingMeta, ...metadata };
      db.prepare("UPDATE agent_registry SET metadata = ?, updated_at = datetime('now') WHERE name = ?").run(JSON.stringify(merged), name);
    }

    const updated = db.prepare("SELECT * FROM agent_registry WHERE name = ?").get(name) as Record<string, unknown>;
    return { content: [{ type: "text", text: safeStringify(agentRow(updated)) }] };
  }
);

// ─── task_route ─────────────────────────────────────────────────────────────

function matchAgent(title: string, description?: string | null): string | null {
  const text = [title, description].filter(Boolean).join(" ");
  const rules = db.prepare(
    "SELECT * FROM route_rules WHERE enabled = 1 ORDER BY priority DESC, id ASC"
  ).all() as Record<string, unknown>[];

  for (const rule of rules) {
    try {
      const regex = new RegExp((rule.pattern as string).split("|").join("|"), "i");
      if (regex.test(text)) {
        // Verify agent is active
        const agent = db.prepare("SELECT status FROM agent_registry WHERE name = ? AND layer = 3").get(rule.target_agent as string) as { status: string } | undefined;
        if (agent && agent.status === "active") {
          return rule.target_agent as string;
        }
      }
    } catch {
      // Skip invalid regex
    }
  }
  return null;
}

server.tool(
  "task_route",
  "[Layer 3] Create a task and auto-route it to the best-matching agent based on routing rules. Also creates the task in the queue and assigns it in one step.",
  {
    title: z.string().describe("Task title — used for auto-routing pattern matching"),
    description: z.string().optional().describe("Detailed task description — also used for routing"),
    priority: z.number().int().min(0).max(10).optional().default(5).describe("Priority 0-10"),
    created_by: z.string().optional().describe("Agent or user creating this task"),
    context: z.record(z.unknown()).optional().describe("Structured context data"),
    force_agent: z.string().optional().describe("Skip routing and assign to this specific agent"),
  },
  async ({ title, description, priority, created_by, context, force_agent }) => {
    const assigned = force_agent || matchAgent(title, description);
    const route_info = force_agent
      ? { method: "manual", target_agent: assigned }
      : assigned
        ? { method: "auto-routed", target_agent: assigned }
        : { method: "unrouted", target_agent: null };

    const stmt = db.prepare(
      `INSERT INTO task_queue (title, description, priority, assigned_agent, created_by, context_json, status)
       VALUES (?, ?, ?, ?, ?, ?, 'assigned')`
    );
    const result = stmt.run(title, description ?? null, priority, assigned, created_by ?? null, context ? JSON.stringify(context) : null);

    const task = db.prepare("SELECT * FROM task_queue WHERE id = ?").get(Number(result.lastInsertRowid)) as Record<string, unknown>;

    return {
      content: [{
        type: "text",
        text: safeStringify({ route: route_info, task: taskRow(task) }),
      }],
    };
  }
);

// ─── route_rule_add ─────────────────────────────────────────────────────────

server.tool(
  "route_rule_add",
  "[Layer 3] Add a routing rule. When task title/description matches the pattern, the task is auto-routed to the target agent.",
  {
    pattern: z.string().describe("Regex-like pattern (use | to separate alternatives), e.g. '规划|架构|plan|architecture'"),
    target_agent: z.string().describe("Agent name to route matching tasks to"),
    description: z.string().optional().describe("Human-readable explanation of when this rule applies"),
    priority: z.number().int().min(0).max(10).optional().default(5).describe("Rule priority 0-10, higher wins on conflict"),
  },
  async ({ pattern, target_agent, description, priority }) => {
    // Validate target agent exists in layer 3
    const agent = db.prepare("SELECT name FROM agent_registry WHERE name = ? AND layer = 3").get(target_agent);
    if (!agent) {
      return { content: [{ type: "text", text: `Target agent "${target_agent}" is not registered in Layer-3 routing. Register it first with agent_register.` }], isError: true };
    }

    const stmt = db.prepare(
      `INSERT INTO route_rules (pattern, description, target_agent, priority) VALUES (?, ?, ?, ?)`
    );
    const result = stmt.run(pattern, description ?? null, target_agent, priority);
    const rule = db.prepare("SELECT * FROM route_rules WHERE id = ?").get(Number(result.lastInsertRowid)) as Record<string, unknown>;

    return { content: [{ type: "text", text: safeStringify(ruleRow(rule)) }] };
  }
);

// ─── route_rule_list ────────────────────────────────────────────────────────

server.tool(
  "route_rule_list",
  "[Layer 3] List all routing rules, ordered by priority.",
  {
    target_agent: z.string().optional().describe("Filter by target agent"),
  },
  async ({ target_agent }) => {
    let rows: Record<string, unknown>[];
    if (target_agent) {
      rows = db.prepare("SELECT * FROM route_rules WHERE target_agent = ? ORDER BY priority DESC").all(target_agent) as Record<string, unknown>[];
    } else {
      rows = db.prepare("SELECT * FROM route_rules ORDER BY priority DESC").all() as Record<string, unknown>[];
    }

    return { content: [{ type: "text", text: safeStringify(rows.map(ruleRow)) }] };
  }
);

// ─── route_rule_delete ─────────────────────────────────────────────────────

server.tool(
  "route_rule_delete",
  "[Layer 3] Delete a routing rule by ID.",
  {
    rule_id: z.number().int().describe("Rule ID to delete"),
  },
  async ({ rule_id }) => {
    const result = db.prepare("DELETE FROM route_rules WHERE id = ?").run(rule_id);
    if (result.changes === 0) {
      return { content: [{ type: "text", text: `Rule #${rule_id} not found.` }], isError: true };
    }
    return { content: [{ type: "text", text: `Route rule #${rule_id} deleted.` }] };
  }
);

// ─── route_test ─────────────────────────────────────────────────────────────

server.tool(
  "route_test",
  "[Layer 3] Test routing: given a task title/description, show which agent would receive it (without creating a task).",
  {
    title: z.string().describe("Task title to test"),
    description: z.string().optional().describe("Task description to test"),
  },
  async ({ title, description }) => {
    const matched = matchAgent(title, description);
    const allRules = db.prepare("SELECT * FROM route_rules WHERE enabled = 1 ORDER BY priority DESC").all() as Record<string, unknown>[];
    const matchedRule = matched
      ? allRules.find(r => r.target_agent === matched)
      : null;

    return {
      content: [{
        type: "text",
        text: safeStringify({
          input: { title, description },
          result: matched
            ? { routed_to: matched, matched_rule: matchedRule ? ruleRow(matchedRule) : null }
            : { routed_to: null, reason: "No matching rule or target agent inactive" },
          active_agents: db.prepare("SELECT name, status FROM agent_registry WHERE layer = 3 AND status = 'active'").all(),
          total_rules: allRules.length,
        }),
      }],
    };
  }
);

// ─── Resource (updated for Layer 3) ─────────────────────────────────────────

server.resource(
  "task-bus-status",
  "mcp-task-bus://status",
  async () => ({
    contents: [
      {
        uri: "mcp-task-bus://status",
        text: safeStringify({
          database: DB_FILE,
          pendingTasks: (db.prepare("SELECT COUNT(*) as c FROM task_queue WHERE status='pending'").get() as { c: number }).c,
          inProgressTasks: (db.prepare("SELECT COUNT(*) as c FROM task_queue WHERE status='in_progress'").get() as { c: number }).c,
          completedTasks: (db.prepare("SELECT COUNT(*) as c FROM task_queue WHERE status='completed'").get() as { c: number }).c,
          stateKeys: (db.prepare("SELECT COUNT(*) as c FROM shared_state").get() as { c: number }).c,
          layer3: {
            agents: (db.prepare("SELECT COUNT(*) as c FROM agent_registry WHERE layer = 3").get() as { c: number }).c,
            activeAgents: (db.prepare("SELECT COUNT(*) as c FROM agent_registry WHERE layer = 3 AND status = 'active'").get() as { c: number }).c,
            routingRules: (db.prepare("SELECT COUNT(*) as c FROM route_rules WHERE enabled = 1").get() as { c: number }).c,
          },
        }),
      },
    ],
  })
);

// ─── Start ─────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
