import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";

export class DashboardServer {
  private server: http.Server;
  private port = 3333;
  private clients: http.ServerResponse[] = [];
  public workspace: string;

  constructor(workspace: string) {
    this.workspace = workspace;
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  public start() {
    this.server.listen(this.port, () => {
      console.log(chalk.cyan(`\n🌐 Live Hybrid Dashboard active at: http://localhost:${this.port}`));
    });
    this.server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        console.log(chalk.dim(`Dashboard port ${this.port} in use, skipping...`));
      }
    });
  }

  public stop() {
    for (const res of this.clients) {
      res.end();
    }
    this.server.close();
  }

  public broadcast(event: string, data: any) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      client.write(payload);
    }
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    
    if (req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      });
      this.clients.push(res);
      req.on("close", () => {
        this.clients = this.clients.filter(c => c !== res);
      });
      return;
    }

    if (req.url === "/api/stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ 
        workspace: this.workspace,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage()
      }));
      return;
    }

    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Muse AI HUD</title>
          <style>
            body { background: #0f172a; color: #e2e8f0; font-family: monospace; padding: 2rem; }
            .panel { border: 1px solid #334155; padding: 1rem; border-radius: 8px; margin-bottom: 1rem; }
            h1 { color: #38bdf8; }
            #log { max-height: 400px; overflow-y: auto; background: #000; padding: 1rem; }
          </style>
        </head>
        <body>
          <h1>Muse AI : Hybrid Dashboard</h1>
          <div class="panel" id="stats">Loading telemetry...</div>
          <div class="panel">
            <h3>Live Telemetry Stream</h3>
            <div id="log"></div>
          </div>
          <script>
            async function fetchStats() {
              const res = await fetch('/api/stats');
              const data = await res.json();
              document.getElementById('stats').innerHTML = \`Workspace: \${data.workspace}<br>Uptime: \${data.uptime.toFixed(1)}s\`;
            }
            setInterval(fetchStats, 2000);
            fetchStats();

            const evtSource = new EventSource('/events');
            evtSource.addEventListener('log', (e) => {
              const data = JSON.parse(e.data);
              const log = document.getElementById('log');
              log.innerHTML += \`<div>[\${new Date().toLocaleTimeString()}] \${data.message}</div>\`;
              log.scrollTop = log.scrollHeight;
            });
          </script>
        </body>
        </html>
      `);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  }
}
