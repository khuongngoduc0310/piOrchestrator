import { createServer, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import type { AgentInspection, AgentName, ArtifactContent, OrchestratorViewModel } from "./types.js";
import { DASHBOARD_HTML } from "./dashboard-page.js";

export interface DashboardDataProvider {
  getViewModel(): OrchestratorViewModel | undefined;
  getAgentInspection(name: AgentName): Promise<AgentInspection | undefined>;
  readArtifact(name: string): Promise<ArtifactContent | undefined>;
}

const ARTIFACT_PATH_RE = /^\/api\/artifacts\/(.+)$/;
const AGENT_PATH_RE = /^\/api\/agents\/([a-z]+)$/;

export class DashboardServer {
  private clients = new Set<ServerResponse>();
  private server?: Server;
  private startPromise?: Promise<string>;
  private heartbeat?: NodeJS.Timeout;
  private lastState?: OrchestratorViewModel;

  constructor(private readonly provider: DashboardDataProvider) {}

  async start(port = 0): Promise<string> {
    if (this.server?.listening) return this.url();
    if (this.startPromise) return this.startPromise;
    const server = createServer(async (req, res) => {
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("cache-control", "no-store");
      const method = req.method;
      const url = req.url ?? "/";
      try {
        if (method === "GET" && url === "/api/state") {
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify(this.provider.getViewModel() ?? this.lastState ?? null));
          return;
        }
        if (method === "GET" && url === "/events") {
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-store",
            connection: "keep-alive"
          });
          res.write(": connected\n\n");
          if (!this.lastState) this.lastState = this.provider.getViewModel();
          if (this.lastState) {
            res.write(`data: ${JSON.stringify(this.lastState)}\n\n`);
          }
          this.clients.add(res);
          const remove = (): void => { this.clients.delete(res); };
          req.on("close", remove);
          res.on("error", remove);
          return;
        }
        if (method === "GET" && (url === "/" || url === "/index.html")) {
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.setHeader("content-security-policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'");
          res.end(DASHBOARD_HTML);
          return;
        }
        if (method === "GET") {
          const agentMatch = url.match(AGENT_PATH_RE);
          if (agentMatch) {
            res.setHeader("content-type", "application/json; charset=utf-8");
            const data = await this.provider.getAgentInspection(agentMatch[1] as AgentName);
            res.end(JSON.stringify(data ?? null));
            return;
          }
          const artMatch = url.match(ARTIFACT_PATH_RE);
          if (artMatch) {
            const decoded = decodeURIComponent(artMatch[1]);
            const artName = path.basename(decoded);
            const data = await this.provider.readArtifact(artName);
            if (!data) {
              res.statusCode = 404;
              res.end("Not found");
              return;
            }
            res.setHeader("content-type", data.isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8");
            if (data.size !== undefined) res.setHeader("x-artifact-size", String(data.size));
            if (data.truncated !== undefined) res.setHeader("x-artifact-truncated", String(data.truncated));
            res.end(data.text);
            return;
          }
        }
        res.statusCode = 404;
        res.end("Not found");
      } catch {
        res.statusCode = 500;
        res.end("Internal error");
      }
    });
    this.server = server;
    this.startPromise = new Promise<string>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        this.server = undefined;
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        this.heartbeat = setInterval(() => this.writeToClients(": heartbeat\n\n"), 15_000);
        this.heartbeat.unref?.();
        resolve(this.url());
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    }).finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }

  publish(viewModel: OrchestratorViewModel): void {
    this.lastState = viewModel;
    this.writeToClients(`data: ${JSON.stringify(viewModel)}\n\n`);
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const client of this.clients) client.end();
    this.clients.clear();
    this.lastState = undefined;
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  private url(): string {
    const address = this.server?.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return `http://127.0.0.1:${port}`;
  }

  private writeToClients(message: string): void {
    for (const client of this.clients) {
      if (client.destroyed || client.writableEnded) {
        this.clients.delete(client);
        continue;
      }
      try {
        client.write(message);
      } catch {
        this.clients.delete(client);
        client.destroy();
      }
    }
  }
}
