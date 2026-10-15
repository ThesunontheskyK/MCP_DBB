# MCP MSSQL Server

A Model Context Protocol (MCP) server for Microsoft SQL Server (MSSQL), providing dynamic database schema inspection and read-only query execution.

Supports both **HTTP/SSE (for LAN / Multi-user sharing)** and **Stdio (Local)** transports.

---

## Features

- **LAN Sharing (HTTP/SSE)**: Run on one machine in your office/home network, and everyone in the same Wi-Fi/LAN can connect via URL!
- **`get_mssql_schema`**: Fetches all table and column names with their data types from `INFORMATION_SCHEMA`.
- **`run_mssql_query`**: Executes read-only SQL queries (`SELECT`, `WITH` CTE) with safety guardrails blocking modifying statements (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `EXEC`, etc.).
- **Smart Guardrail**: Uses word-boundary regex so normal columns like `created_at`, `updated_at`, or `deleted_at` are not blocked.
- **Connection Pool**: Reuses persistent connections for high performance.

---

## Setup

1. Configure your database credentials in `.env`:
   ```env
   DB_SERVER=
   DB_USER=sa
   DB_PASSWORD=YourStrongPassword
   DB_NAME=YourDatabaseName
   DB_PORT=1433
   PORT=3000
   ```
2. Build the server:
   ```bash
   npm run build
   ```

---

## Mode 1: Run as LAN / Web Service (Recommended for Team)

Start the HTTP/SSE server:
```bash
npm start
```
You will see output in the terminal:
```text
====================================================
🚀 MSSQL MCP Server (HTTP/SSE) is running!
📡 Local:      http://localhost:3000/sse
🌐 LAN URL:    http://192.168.1.124:3000/sse
====================================================
```

### Configuration for Antigravity (For you and anyone in your LAN):

In `~/.gemini/config/mcp_config.json`:
```json
{
  "mcpServers": {
    "mssql": {
      "serverUrl": "http://192.168.1.124:3000/sse"
    }
  }
}
```

*(If testing on the same machine running the server, you can also use `http://localhost:3000/sse`)*

---

## Mode 2: Run as Local Stdio Process

If you want Antigravity to spawn the process directly on your local machine:
```json
{
  "mcpServers": {
    "mssql": {
      "command": "node",
      "args": ["d:/CodingProject/mcp-mssql-server/dist/index.js"]
    }
  }
}
```
