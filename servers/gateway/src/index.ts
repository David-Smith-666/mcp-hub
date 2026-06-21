import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ─── Config ────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT = parseInt(process.env.MCP_GATEWAY_TIMEOUT || "30000", 10);
const MAX_RESPONSE_SIZE = parseInt(process.env.MCP_GATEWAY_MAX_SIZE || "1048576", 10); // 1MB
const ALLOWED_DOMAINS = (process.env.MCP_GATEWAY_ALLOWED || "")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);

// ─── Helpers ───────────────────────────────────────────────────────────────

function checkDomain(urlString: string): void {
  if (ALLOWED_DOMAINS.length === 0) return;
  try {
    const hostname = new URL(urlString).hostname;
    const allowed = ALLOWED_DOMAINS.some(
      (d) => hostname === d || hostname.endsWith("." + d)
    );
    if (!allowed) {
      throw new Error(
        `Domain "${hostname}" not in allowed list. Allowed: ${ALLOWED_DOMAINS.join(", ")}`
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Domain")) throw e;
    throw new Error(`Invalid URL: ${urlString}`);
  }
}

async function httpRequest(args: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: string; elapsedMs: number }> {
  const start = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs || DEFAULT_TIMEOUT);

  try {
    const fetchHeaders: Record<string, string> = {
      "User-Agent": "MCP-Gateway/1.0",
      ...args.headers,
    };

    // Auto-set Content-Type if body is provided and no Content-Type header
    if (args.body && !fetchHeaders["Content-Type"] && !fetchHeaders["content-type"]) {
      try {
        JSON.parse(args.body);
        fetchHeaders["Content-Type"] = "application/json";
      } catch {
        fetchHeaders["Content-Type"] = "text/plain";
      }
    }

    const response = await fetch(args.url, {
      method: args.method,
      headers: fetchHeaders,
      body: args.body && args.method !== "GET" && args.method !== "HEAD" ? args.body : undefined,
      signal: controller.signal,
    });

    let body = await response.text();

    // Truncate large responses
    if (body.length > MAX_RESPONSE_SIZE) {
      body = body.slice(0, MAX_RESPONSE_SIZE) + `\n\n... (truncated at ${MAX_RESPONSE_SIZE} bytes)`;
    }

    const elapsedMs = Date.now() - start;

    const resHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      resHeaders[key] = value;
    });

    return {
      status: response.status,
      statusText: response.statusText,
      headers: resHeaders,
      body,
      elapsedMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "mcp-gateway",
  version: "1.0.0",
});

// ─── http_get ──────────────────────────────────────────────────────────────

server.tool(
  "http_get",
  "Send an HTTP GET request to a URL.",
  {
    url: z.string().url().describe("The URL to GET"),
    headers: z.record(z.string()).optional().describe("Additional HTTP headers"),
    timeout: z.number().min(1000).max(120000).optional().default(30000).describe("Timeout in milliseconds"),
  },
  async ({ url, headers, timeout }) => {
    checkDomain(url);
    const result = await httpRequest({ method: "GET", url, headers, timeoutMs: timeout });

    return {
      content: [
        {
          type: "text",
          text: `HTTP ${result.status} ${result.statusText}  (${result.elapsedMs}ms)\n\n${result.body}`,
        },
      ],
    };
  }
);

// ─── http_post ─────────────────────────────────────────────────────────────

server.tool(
  "http_post",
  "Send an HTTP POST request with a JSON or text body.",
  {
    url: z.string().url().describe("The URL to POST to"),
    body: z.string().optional().describe("Request body (JSON string or text)"),
    headers: z.record(z.string()).optional().describe("Additional HTTP headers"),
    timeout: z.number().min(1000).max(120000).optional().default(30000).describe("Timeout in milliseconds"),
  },
  async ({ url, body, headers, timeout }) => {
    checkDomain(url);
    const result = await httpRequest({ method: "POST", url, headers, body, timeoutMs: timeout });

    return {
      content: [
        {
          type: "text",
          text: `HTTP ${result.status} ${result.statusText}  (${result.elapsedMs}ms)\nResponse headers: ${JSON.stringify(result.headers, null, 2)}\n\n${result.body}`,
        },
      ],
    };
  }
);

// ─── http_put ──────────────────────────────────────────────────────────────

server.tool(
  "http_put",
  "Send an HTTP PUT request to update a resource.",
  {
    url: z.string().url().describe("The URL to PUT to"),
    body: z.string().optional().describe("Request body"),
    headers: z.record(z.string()).optional().describe("Additional HTTP headers"),
    timeout: z.number().min(1000).max(120000).optional().default(30000).describe("Timeout in milliseconds"),
  },
  async ({ url, body, headers, timeout }) => {
    checkDomain(url);
    const result = await httpRequest({ method: "PUT", url, headers, body, timeoutMs: timeout });

    return {
      content: [
        {
          type: "text",
          text: `HTTP ${result.status} ${result.statusText}  (${result.elapsedMs}ms)\n\n${result.body}`,
        },
      ],
    };
  }
);

// ─── http_delete ───────────────────────────────────────────────────────────

server.tool(
  "http_delete",
  "Send an HTTP DELETE request.",
  {
    url: z.string().url().describe("The URL to DELETE"),
    headers: z.record(z.string()).optional().describe("Additional HTTP headers"),
    timeout: z.number().min(1000).max(120000).optional().default(30000).describe("Timeout in milliseconds"),
  },
  async ({ url, headers, timeout }) => {
    checkDomain(url);
    const result = await httpRequest({ method: "DELETE", url, headers, timeoutMs: timeout });

    return {
      content: [
        {
          type: "text",
          text: `HTTP ${result.status} ${result.statusText}  (${result.elapsedMs}ms)\n\n${result.body}`,
        },
      ],
    };
  }
);

// ─── http_patch ────────────────────────────────────────────────────────────

server.tool(
  "http_patch",
  "Send an HTTP PATCH request for partial updates.",
  {
    url: z.string().url().describe("The URL to PATCH"),
    body: z.string().optional().describe("Request body"),
    headers: z.record(z.string()).optional().describe("Additional HTTP headers"),
    timeout: z.number().min(1000).max(120000).optional().default(30000).describe("Timeout in milliseconds"),
  },
  async ({ url, body, headers, timeout }) => {
    checkDomain(url);
    const result = await httpRequest({ method: "PATCH", url, headers, body, timeoutMs: timeout });

    return {
      content: [
        {
          type: "text",
          text: `HTTP ${result.status} ${result.statusText}  (${result.elapsedMs}ms)\n\n${result.body}`,
        },
      ],
    };
  }
);

// ─── http_head ─────────────────────────────────────────────────────────────

server.tool(
  "http_head",
  "Send an HTTP HEAD request to get response headers only (no body).",
  {
    url: z.string().url().describe("The URL to send HEAD request to"),
    headers: z.record(z.string()).optional().describe("Additional HTTP headers"),
    timeout: z.number().min(1000).max(120000).optional().default(30000),
  },
  async ({ url, headers, timeout }) => {
    checkDomain(url);
    const result = await httpRequest({ method: "HEAD", url, headers, timeoutMs: timeout });
    return {
      content: [
        {
          type: "text",
          text: `HTTP ${result.status} ${result.statusText}  (${result.elapsedMs}ms)\nHeaders: ${JSON.stringify(result.headers, null, 2)}`,
        },
      ],
    };
  }
);

// ─── gateway_status (resource) ─────────────────────────────────────────────

server.resource(
  "gateway-status",
  "mcp-gateway://status",
  async () => ({
    contents: [
      {
        uri: "mcp-gateway://status",
        text: JSON.stringify(
          {
            status: "running",
            allowedDomains: ALLOWED_DOMAINS.length > 0 ? ALLOWED_DOMAINS : "(all domains allowed)",
            timeout: DEFAULT_TIMEOUT,
            maxResponseSize: MAX_RESPONSE_SIZE,
          },
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
