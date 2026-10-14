#!/usr/bin/env node

import os from "node:os";
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import sql from "mssql";
import * as dotenv from "dotenv";

dotenv.config();

// ตั้งค่าการเชื่อมต่อ SQL Server
const dbConfig: sql.config = {
  user: process.env.DB_USER || "",
  password: process.env.DB_PASSWORD || "",
  server: process.env.DB_SERVER || "",
  database: process.env.DB_NAME || "",
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 1433,
  options: {
    encrypt: true, // ตั้งเป็น true ถ้าใช้ Azure หรือบังคับ SSL
    trustServerCertificate: true, // ตั้งเป็น true สำหรับ Development ทั่วไป
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

let pool: sql.ConnectionPool | null = null;

async function getPool(): Promise<sql.ConnectionPool> {
  if (!pool || !pool.connected) {
    pool = new sql.ConnectionPool(dbConfig);
    await pool.connect();
  }
  return pool;
}

// ฟังก์ชันสร้างและผูก Handler สำหรับ MCP Server
function createMcpServer(): Server {
  const server = new Server(
    {
      name: "mssql-dynamic-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // 1. รายการ Tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "get_mssql_schema",
          description:
            "ดึงรายชื่อตารางและคอลัมน์ทั้งหมดใน SQL Server เพื่อให้ AI ทำความเข้าใจโครงสร้างข้อมูล",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "run_mssql_query",
          description:
            "รันคำสั่ง SQL SELECT บน SQL Server เท่านั้น (ห้ามใช้ INSERT, UPDATE, DELETE, DROP)",
          inputSchema: {
            type: "object",
            properties: {
              sql: {
                type: "string",
                description:
                  "คำสั่ง SQL SELECT ที่ถูกต้องตามโครงสร้างของ SQL Server",
              },
            },
            required: ["sql"],
          },
        },
      ],
    };
  });

  // 2. จัดการเมื่อ AI เรียกใช้ Tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const activePool = await getPool();

      // --- TOOL 1: ดึงโครงสร้างตาราง (Schema) ---
      if (name === "get_mssql_schema") {
        const query = `
          SELECT 
              t.TABLE_SCHEMA AS [Schema],
              t.TABLE_NAME AS [TableName],
              c.COLUMN_NAME AS [ColumnName],
              c.DATA_TYPE AS [DataType]
          FROM INFORMATION_SCHEMA.TABLES t
          INNER JOIN INFORMATION_SCHEMA.COLUMNS c 
              ON t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_SCHEMA = c.TABLE_SCHEMA
          WHERE t.TABLE_TYPE = 'BASE TABLE'
          ORDER BY t.TABLE_NAME, c.ORDINAL_POSITION;
        `;
        const result = await activePool.request().query(query);

        return {
          content: [
            { type: "text", text: JSON.stringify(result.recordset, null, 2) },
          ],
        };
      }

      // --- TOOL 2: รัน SQL Query แบบ Read-Only ---
      if (name === "run_mssql_query") {
        const sqlQuery = String(args?.sql || "").trim();

        // ถอด comments และ string literals ก่อนตรวจคำสั่งอันตราย
        const sanitizedSql = sqlQuery
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/--.*$/gm, "")
          .replace(/'(?:''|[^'])*'/g, "''");

        const trimmedUpper = sanitizedSql.trim().toUpperCase();

        // --- GUARDRAIL ความปลอดภัย ---
        if (
          !trimmedUpper.startsWith("SELECT") &&
          !trimmedUpper.startsWith("WITH")
        ) {
          throw new Error(
            "ไม่อนุญาต: ระบบอนุญาตให้รันเฉพาะคำสั่ง SELECT หรือ WITH (CTE) เท่านั้น",
          );
        }

        // ใช้ word boundary \b เพื่อป้องกัน false positive กับชื่อคอลัมน์เช่น created_at, updated_at
        const dangerousRegex =
          /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|EXEC|EXECUTE|GRANT|REVOKE|MERGE)\b/i;
        if (dangerousRegex.test(sanitizedSql)) {
          throw new Error(
            "ไม่อนุญาต: พบคำสั่งที่อยู่นอกเหนือขอบเขตการอ่านข้อมูล (Read-Only)",
          );
        }
        // ----------------------------

        const result = await activePool.request().query(sqlQuery);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result.recordset, null, 2),
            },
          ],
        };
      }

      throw new Error(`ไม่พบ Tool ชื่อ: ${name}`);
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `SQL Server Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// หา IP ของเครื่องในวง LAN
function getLanIp(): string {
  const interfaces = os.networkInterfaces();
  const candidates: string[] = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        // ข้าม Link-local / Loopback adapter (เช่น 169.254.x.x)
        if (!iface.address.startsWith("169.254.")) {
          candidates.push(iface.address);
        }
      }
    }
  }

  // เลือก IP วง LAN จริง (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
  const preferred = candidates.find(
    (ip) =>
      ip.startsWith("192.168.") ||
      ip.startsWith("10.") ||
      ip.startsWith("172."),
  );

  return preferred || candidates[0] || "localhost";
}

// -------------------------------------------------------------
// โหมด 1: Express Server สำหรับเชื่อมต่อผ่าน URL / LAN (HTTP + SSE)
// -------------------------------------------------------------
function startExpressServer(port: number) {
  const app = express();

  // กำหนด CORS Headers เพื่อให้ Client/IDE ในวงแลนเชื่อมต่อได้
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // รองรับ JSON request body
  app.use(express.json());

  const transports: Record<
    string,
    { transport: SSEServerTransport; server: Server }
  > = {};

  // 1. GET /sse -> เริ่มต้น SSE stream สำหรับ Client แต่ละตัว
  app.get("/sse", async (req, res) => {
    console.log(`[SSE] New client connected: ${req.ip}`);

    const transport = new SSEServerTransport("/messages", res);
    const mcpServer = createMcpServer();

    transports[transport.sessionId] = { transport, server: mcpServer };

    transport.onclose = () => {
      console.log(`[SSE] Session closed: ${transport.sessionId}`);
      delete transports[transport.sessionId];
    };

    transport.onerror = (err) => {
      console.error(`[SSE] Transport error:`, err);
    };

    await mcpServer.connect(transport);
  });

  // 2. POST /messages -> รับข้อความ JSON-RPC จาก Client
  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const session = sessionId ? transports[sessionId] : undefined;

    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // ส่ง req.body ไปเป็น parsedBody ให้กับ transport
    await session.transport.handlePostMessage(req, res, req.body);
  });

  // 3. Health check & Welcome
  app.get(["/", "/health"], (req, res) => {
    const host = req.get("host") || `localhost:${port}`;
    res.json({
      status: "ok",
      service: "MSSQL MCP Server (Express SSE)",
      endpoints: {
        sse: `http://${host}/sse`,
        messages: `http://${host}/messages`,
      },
    });
  });

  const lanIp = getLanIp();
  app.listen(port, "0.0.0.0", () => {
    console.log(`====================================================`);
    console.log(`🚀 MSSQL MCP Server (Express) is running!`);
    console.log(`📡 Local URL:   http://localhost:${port}/sse`);
    console.log(`🌐 LAN URL:     http://${lanIp}:${port}/sse`);
    console.log(`====================================================`);
    console.log(`👉 ให้ใส่ใน mcp_config.json:`);
    console.log(`{`);
    console.log(`  "mcpServers": {`);
    console.log(`    "mssql-remote-server": {`);
    console.log(`      "serverUrl": "http://${lanIp}:${port}/sse"`);
    console.log(`    }`);
    console.log(`  }`);
    console.log(`}`);
    console.log(`====================================================`);
  });
}

// -------------------------------------------------------------
// โหมด 2: Stdio Server สำหรับรันแบบ Local Process ดั้งเดิม
// -------------------------------------------------------------
async function startStdioServer() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MSSQL MCP Server running on stdio");
}

async function main() {
  const isSse =
    process.argv.includes("--sse") ||
    process.env.MCP_TRANSPORT === "sse" ||
    !!process.env.PORT;
  const port = parseInt(process.env.PORT || "3000", 10);

  if (isSse) {
    startExpressServer(port);
  } else {
    await startStdioServer();
  }
}

process.on("SIGINT", async () => {
  if (pool) await pool.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  if (pool) await pool.close();
  process.exit(0);
});

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
