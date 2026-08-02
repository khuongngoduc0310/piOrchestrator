import { createServer, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentHistoryResponse, AgentInspection, AgentName, AgentTranscript, ArtifactContent, DashboardDecisionPresentation, DashboardRunHistoryItem, InvocationDiffView, OrchestratorViewModel } from "../types.js";
import type { HumanDecisionAction } from "../orchestration/human-decision-types.js";

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

interface DecisionWaiter {
  resolve: (value: DashboardDecisionSubmission) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  removeListener: () => void;
}

export interface DashboardDecisionSubmission {
  action: HumanDecisionAction;
  feedback?: string;
  acknowledge: (error?: unknown) => void;
}

const DECISION_PREVIEW_RE = /^\/api\/decisions\/([^/]+)\/preview$/;

export class DashboardServer {
  private clients = new Set<ServerResponse>();
  private server?: Server;
  private startPromise?: Promise<string>;
  private heartbeat?: NodeJS.Timeout;
  private lastState?: OrchestratorViewModel;
  private decisionWaiters = new Map<string, DecisionWaiter>();
  private decisionPreviews = new Map<string, DashboardDecisionPresentation>();

  constructor(private readonly provider: DashboardDataProvider) {}

  get hasConnectedClients(): boolean {
    return this.clients.size > 0;
  }

  get isListening(): boolean {
    return this.server?.listening === true;
  }

  hasDecision(id: string): boolean {
    return this.decisionWaiters.has(id);
  }

  /**
   * Register a dashboard decision waiter with its preview.
   * Must be called before persist() publishes SSE so the preview
   * is guaranteed to exist when the browser fetches it.
   */
  registerDecision(
    id: string,
    presentation: DashboardDecisionPresentation,
    signal: AbortSignal,
  ): Promise<DashboardDecisionSubmission> {
    if (signal.aborted) throw abortError(signal.reason);
    if (this.decisionWaiters.has(id) || this.decisionPreviews.has(id)) {
      throw new Error(`Dashboard decision ${id} is already registered`);
    }
    this.decisionPreviews.set(id, presentation);
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.decisionWaiters.delete(id);
        this.decisionPreviews.delete(id);
        reject(abortError(signal.reason));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.decisionWaiters.set(id, {
        resolve,
        reject,
        signal,
        removeListener: () => signal.removeEventListener("abort", onAbort),
      });
    });
  }

  unregisterDecision(id: string, reason: unknown = new Error("Dashboard decision unregistered")): boolean {
    const waiter = this.decisionWaiters.get(id);
    if (!waiter) return false;
    waiter.removeListener();
    this.decisionWaiters.delete(id);
    this.decisionPreviews.delete(id);
    waiter.reject(abortError(reason));
    return true;
  }

  private rejectAllWaiters(reason: unknown): void {
    for (const [id, waiter] of this.decisionWaiters) {
      waiter.removeListener();
      waiter.reject(abortError(reason));
    }
    this.decisionWaiters.clear();
    this.decisionPreviews.clear();
  }

  /**
   * Resolve a pending decision from the dashboard POST endpoint.
   * Returns true if a waiter was found and resolved.
   */
  private submitDecision(id: string, action: HumanDecisionAction, feedback?: string): Promise<void> | undefined {
    const waiter = this.decisionWaiters.get(id);
    if (waiter) {
      waiter.removeListener();
      this.decisionWaiters.delete(id);
      this.decisionPreviews.delete(id);
      return new Promise<void>((resolve, reject) => {
        let acknowledged = false;
        waiter.resolve({
          action,
          feedback,
          acknowledge: error => {
            if (acknowledged) return;
            acknowledged = true;
            if (error === undefined) resolve();
            else reject(abortError(error));
          }
        });
      });
    }
    return undefined;
  }

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
          const remove = (): void => {
            this.clients.delete(res);
          };
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
        if (method === "POST" && pathname === "/api/decision") {
          let body = "";
          let bodySize = 0;
          req.on("data", (chunk: Buffer) => {
            bodySize += chunk.length;
            if (bodySize > 100_000) req.destroy(new Error("Payload too large"));
            else body += chunk.toString("utf-8");
          });
          await new Promise<void>((resolve, reject) => {
            req.once("end", resolve);
            req.once("error", reject);
          }).catch(() => undefined);
          if (bodySize > 100_000) {
            res.statusCode = 413;
            res.end(JSON.stringify({ ok: false, error: "Payload too large" }));
            return;
          }
          try {
            const parsed = JSON.parse(body) as { id?: unknown; action?: unknown; feedback?: unknown };
            if (typeof parsed.id !== "string" || parsed.id.length === 0) {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: "Missing or invalid id" }));
              return;
            }
            if (typeof parsed.action !== "string") {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: "Missing action" }));
              return;
            }
            if (parsed.feedback !== undefined && typeof parsed.feedback !== "string") {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: "Invalid feedback" }));
              return;
            }
            if (parsed.feedback && parsed.feedback.length > 10_000) {
              res.statusCode = 413;
              res.end(JSON.stringify({ ok: false, error: "Feedback too long" }));
              return;
            }
            const presentation = this.decisionPreviews.get(parsed.id);
            if (!presentation) {
              res.statusCode = 409;
              res.end(JSON.stringify({ ok: false, error: "Decision is no longer active" }));
              return;
            }
            const descriptor = presentation.actions.find(candidate => candidate.value === parsed.action);
            if (!descriptor) {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: `Action ${parsed.action} not allowed for this decision` }));
              return;
            }
            const feedback = typeof parsed.feedback === "string" ? parsed.feedback.trim() : undefined;
            if (descriptor.requiresFeedback && !feedback) {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: `Action ${parsed.action} requires nonblank feedback` }));
              return;
            }
            const accepted = this.submitDecision(parsed.id, descriptor.value, feedback);
            if (!accepted) {
              res.statusCode = 409;
              res.end(JSON.stringify({ ok: false, error: "Decision already resolved" }));
              return;
            }
            try {
              await accepted;
            } catch (error) {
              res.statusCode = 409;
              res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Decision was not recorded" }));
              return;
            }
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: true }));
          } catch {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
          }
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
          const previewMatch = pathname.match(DECISION_PREVIEW_RE);
          if (previewMatch) {
            const decisionId = decodeURIComponent(previewMatch[1]);
            const presentation = this.decisionPreviews.get(decisionId);
            if (!presentation) {
              res.statusCode = 404;
              res.end(JSON.stringify({ ok: false, error: "Decision not found" }));
              return;
            }
            const active = this.decisionWaiters.has(decisionId);
            if (!active) {
              res.statusCode = 409;
              res.end(JSON.stringify({ ok: false, error: "Decision is no longer active" }));
              return;
            }
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify(presentation));
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
    this.rejectAllWaiters(new Error("Dashboard server stopped"));
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

function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error("Dashboard decision aborted");
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
