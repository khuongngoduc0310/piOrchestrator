import { createServer, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentHistoryResponse, AgentInspection, AgentName, AgentTranscript, ArtifactContent, DashboardRunHistoryItem, InvocationDiffView, OrchestratorViewModel } from "../types.js";

export interface DashboardDataProvider {
  getViewModel(): OrchestratorViewModel | undefined;
  getAgentInspection(name: AgentName): Promise<AgentInspection | undefined>;
  getAgentTranscript?(stepId: string, invocation: number): Promise<AgentTranscript | undefined>;
  readArtifact(name: string): Promise<ArtifactContent | undefined>;
  listRuns?(): Promise<DashboardRunHistoryItem[]>;
  getRunViewModel?(runId: string): Promise<OrchestratorViewModel | undefined>;
  getRunAgentInspection?(runId: string, name: AgentName): Promise<AgentInspection | undefined>;
  getRunAgentHistory?(runId: string): Promise<AgentHistoryResponse | undefined>;
  getRunAgentTranscript?(runId: string, stepId: string, invocation: number): Promise<AgentTranscript | undefined>;
  getInvocationDiff?(runId: string, stepId: string, invocation: number): Promise<InvocationDiffView | undefined>;
  readRunArtifact?(runId: string, name: string): Promise<ArtifactContent | undefined>;
}

const DASHBOARD_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dashboard-dist",
);
const DASHBOARD_ASSET_MAP: Record<string, string> = {
  "/dashboard.js": "dashboard.js",
  "/dashboard.css": "dashboard.css",
};

function serveStaticAsset(res: ServerResponse, urlPath: string): boolean {
  const relative = DASHBOARD_ASSET_MAP[urlPath];
  if (!relative) return false;
  const filePath = path.resolve(DASHBOARD_DIR, relative);
  if (!filePath.startsWith(DASHBOARD_DIR)) return false;
  let content: string | undefined;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return false;
  }
  const ext = path.extname(relative);
  const mime =
    ext === ".js"
      ? "text/javascript; charset=utf-8"
      : ext === ".css"
        ? "text/css; charset=utf-8"
        : "text/plain; charset=utf-8";
  res.setHeader("content-type", mime);
  res.end(content);
  return true;
}

function serveDashboardHtml(res: ServerResponse): void {
  const filePath = path.resolve(DASHBOARD_DIR, "index.html");
  if (!filePath.startsWith(DASHBOARD_DIR)) {
    res.statusCode = 500;
    res.end("Internal error");
    return;
  }
  try {
    const html = fs.readFileSync(filePath, "utf-8");
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  } catch {
    res.statusCode = 500;
    res.end("Internal error");
  }
}

const ARTIFACT_PATH_RE = /^\/api\/artifacts\/(.+)$/;
const AGENT_PATH_RE = /^\/api\/agents\/([a-z]+)$/;
const TRANSCRIPT_PATH_RE = /^\/api\/steps\/(step-\d+)\/invocations\/(\d+)\/transcript$/;
const RUN_STATE_RE = /^\/api\/runs\/([^/]+)\/state$/;
const RUN_AGENT_RE = /^\/api\/runs\/([^/]+)\/agents\/([a-z]+)$/;
const RUN_AGENT_HISTORY_RE = /^\/api\/runs\/([^/]+)\/agent-history$/;
const RUN_TRANSCRIPT_RE = /^\/api\/runs\/([^/]+)\/steps\/(step-\d+)\/invocations\/(\d+)\/transcript$/;
const RUN_DIFF_RE = /^\/api\/runs\/([^/]+)\/steps\/(step-\d+)\/invocations\/(\d+)\/diff$/;
const RUN_ARTIFACT_RE = /^\/api\/runs\/([^/]+)\/artifacts\/([^/]+)$/;

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
      if (!isLocalDashboardRequest(req.headers.host, req.headers.origin)) {
        res.statusCode = 403;
        res.end("Forbidden");
        return;
      }
      const method = req.method;
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname;
      try {
        if (method === "GET" && pathname === "/api/state") {
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify(this.provider.getViewModel() ?? this.lastState ?? null));
          return;
        }
        if (method === "GET" && pathname === "/events") {
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
        if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
          res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
          serveDashboardHtml(res);
          return;
        }
        if (method === "GET" && serveStaticAsset(res, pathname)) {
          return;
        }
        if (method === "GET") {
          if (pathname === "/api/runs") {
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify(await this.provider.listRuns?.() ?? []));
            return;
          }
          const runStateMatch = pathname.match(RUN_STATE_RE);
          if (runStateMatch) {
            const data = await this.provider.getRunViewModel?.(decodeURIComponent(runStateMatch[1]));
            if (!data) return notFound(res);
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify(data));
            return;
          }
          const runTranscriptMatch = pathname.match(RUN_TRANSCRIPT_RE);
          if (runTranscriptMatch) {
            const data = await this.provider.getRunAgentTranscript?.(decodeURIComponent(runTranscriptMatch[1]), runTranscriptMatch[2], Number(runTranscriptMatch[3]));
            if (!data) return notFound(res);
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify(data));
            return;
          }
          const runAgentHistoryMatch = pathname.match(RUN_AGENT_HISTORY_RE);
          if (runAgentHistoryMatch) {
            const data = await this.provider.getRunAgentHistory?.(decodeURIComponent(runAgentHistoryMatch[1]));
            if (!data) return notFound(res);
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify(data));
            return;
          }
          const runDiffMatch = pathname.match(RUN_DIFF_RE);
          if (runDiffMatch) {
            const data = await this.provider.getInvocationDiff?.(decodeURIComponent(runDiffMatch[1]), runDiffMatch[2], Number(runDiffMatch[3]));
            if (!data) return notFound(res);
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify(data));
            return;
          }
          const runAgentMatch = pathname.match(RUN_AGENT_RE);
          if (runAgentMatch) {
            const data = await this.provider.getRunAgentInspection?.(decodeURIComponent(runAgentMatch[1]), runAgentMatch[2] as AgentName);
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify(data ?? null));
            return;
          }
          const runArtifactMatch = pathname.match(RUN_ARTIFACT_RE);
          if (runArtifactMatch) {
            const data = await this.provider.readRunArtifact?.(decodeURIComponent(runArtifactMatch[1]), decodeURIComponent(runArtifactMatch[2]));
            if (!data) return notFound(res);
            sendArtifact(res, data);
            return;
          }
          const transcriptMatch = pathname.match(TRANSCRIPT_PATH_RE);
          if (transcriptMatch) {
            const data = await this.provider.getAgentTranscript?.(transcriptMatch[1], Number(transcriptMatch[2]));
            if (!data) {
              res.statusCode = 404;
              res.end("Not found");
              return;
            }
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify(data));
            return;
          }
          const agentMatch = pathname.match(AGENT_PATH_RE);
          if (agentMatch) {
            res.setHeader("content-type", "application/json; charset=utf-8");
            const data = await this.provider.getAgentInspection(agentMatch[1] as AgentName);
            res.end(JSON.stringify(data ?? null));
            return;
          }
          const artMatch = pathname.match(ARTIFACT_PATH_RE);
          if (artMatch) {
            const decoded = decodeURIComponent(artMatch[1]);
            const artName = path.basename(decoded);
            const data = await this.provider.readArtifact(artName);
            if (!data) {
              res.statusCode = 404;
              res.end("Not found");
              return;
            }
            sendArtifact(res, data);
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

function notFound(res: ServerResponse): void {
  res.statusCode = 404;
  res.end("Not found");
}

function sendArtifact(res: ServerResponse, data: ArtifactContent): void {
  res.setHeader("content-type", data.isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8");
  res.setHeader("x-artifact-size", String(data.size));
  res.setHeader("x-artifact-truncated", String(data.truncated));
  res.end(data.text);
}

function isLocalDashboardRequest(host: string | undefined, origin: string | undefined): boolean {
  try {
    if (!host || !isLoopbackHostname(new URL(`http://${host}`).hostname)) return false;
    return !origin || isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}
