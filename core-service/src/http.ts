import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { join } from "path";
import * as log from "./log.js";
import type { BotContext, BotHandler } from "./types.js";

// ============================================================================
// HTTP context adapter
// ============================================================================

type SseEmitter = (event: object) => void;

function createHttpContext(opts: {
	channelId: string;
	userName: string;
	text: string;
	ts: string;
	send: SseEmitter;
	workingDir: string;
	attachments?: Array<{ local: string }>;
}): BotContext {
	const { channelId, userName, text, ts, send, workingDir, attachments = [] } = opts;

	const logToFile = (entry: object) => {
		const dir = join(workingDir, channelId);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	};

	return {
		message: {
			text,
			rawText: text,
			user: "web-user",
			userName,
			channel: channelId,
			ts,
			attachments,
		},
		channelName: channelId,
		channels: [{ id: channelId, name: channelId }],
		users: [{ id: "web-user", userName, displayName: userName }],

		respond: async (responseText: string, shouldLog = true) => {
			send({ type: "delta", text: responseText });
			if (shouldLog) {
				const responseTs = (Date.now() / 1000).toFixed(6);
				logToFile({
					date: new Date().toISOString(),
					ts: responseTs,
					user: "bot",
					text: responseText,
					attachments: [],
					isBot: true,
				});
			}
		},

		replaceMessage: async (responseText: string) => {
			send({ type: "replace", text: responseText });
			const responseTs = (Date.now() / 1000).toFixed(6);
			logToFile({
				date: new Date().toISOString(),
				ts: responseTs,
				user: "bot",
				text: responseText,
				attachments: [],
				isBot: true,
				isFinal: true,
			});
		},

		respondInThread: async (responseText: string) => {
			send({ type: "thread", text: responseText });
			const responseTs = (Date.now() / 1000).toFixed(6);
			logToFile({
				date: new Date().toISOString(),
				ts: responseTs,
				user: "bot",
				text: responseText,
				attachments: [],
				isBot: true,
				isThread: true,
			});
		},

		setTyping: async (isTyping: boolean) => {
			send({ type: "status", status: isTyping ? "thinking" : "idle" });
		},

		uploadFile: async (filePath: string, title?: string) => {
			send({ type: "file", path: filePath, title });
		},

		setWorking: async (working: boolean) => {
			send({ type: "status", status: working ? "working" : "idle" });
		},

		deleteMessage: async () => {
			send({ type: "delete" });
		},
	};
}

// ============================================================================
// HTTP SSE Server
// ============================================================================

/**
 * HTTP server that exposes the bot via Server-Sent Events.
 *
 * Endpoints:
 *   POST /chat      – { channelId, text, userName? }  → SSE stream
 *   POST /stop      – { channelId }                   → { ok, message }
 *   GET  /status/:channelId                           → { running }
 *   GET  /sessions                                    → SessionInfo[]
 *
 * SSE event shapes:
 *   { type: "status",  status: "thinking"|"working"|"idle"|"stopped" }
 *   { type: "delta",   text: string }   – new text appended to response
 *   { type: "replace", text: string }   – final full response text
 *   { type: "thread",  text: string }   – tool detail / thread message
 *   { type: "file",    path: string, title?: string }
 *   { type: "delete" }
 *   { type: "done",    stopReason: string }
 *   { type: "error",   message: string }
 */
export class HttpServer {
	private port: number;
	private workingDir: string;
	private handler: BotHandler;

	constructor(config: {
		port: number;
		workingDir: string;
		handler: BotHandler;
	}) {
		this.port = config.port;
		this.workingDir = config.workingDir;
		this.handler = config.handler;
	}

	start(): void {
		const server = createServer((req, res) => {
			this.handleRequest(req, res).catch((err) => {
				log.logWarning("HTTP handler error", err instanceof Error ? err.message : String(err));
				if (!res.writableEnded) {
					res.writeHead(500);
					res.end();
				}
			});
		});

		server.listen(this.port, () => {
			log.logInfo(`HTTP SSE server listening on port ${this.port}`);
		});
	}

	// ==========================================================================
	// Request routing
	// ==========================================================================

	private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type");

		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		const url = req.url || "";

		if (req.method === "POST" && url === "/chat") {
			await this.handleChat(req, res);
		} else if (req.method === "POST" && url === "/stop") {
			await this.handleStop(req, res);
		} else if (req.method === "GET" && url.startsWith("/status/")) {
			const channelId = url.slice("/status/".length);
			this.handleStatus(channelId, res);
		} else if (req.method === "GET" && url === "/sessions") {
			this.handleSessions(res);
		} else if (req.method === "GET" && url.startsWith("/messages/")) {
			const channelId = decodeURIComponent(url.slice("/messages/".length));
			this.handleMessages(channelId, res);
		} else if (req.method === "GET" && url.startsWith("/file?")) {
			const filePath = new URLSearchParams(url.slice(url.indexOf("?"))).get("path") || "";
			this.handleFile(filePath, res);
		} else if (req.method === "GET" && url.startsWith("/artifact-url?")) {
			const filePath = new URLSearchParams(url.slice(url.indexOf("?"))).get("path") || "";
			this.handleArtifactUrl(filePath, res);
		} else if (req.method === "GET" && url.startsWith("/artifacts/")) {
			this.handleArtifactStatic(url.slice("/artifacts/".length), res);
		} else {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Not found" }));
		}
	}

	// ==========================================================================
	// Handlers
	// ==========================================================================

	private async handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
		type AttachmentPayload = { fileName: string; mimeType: string; content: string };
		let body: { channelId?: string; text?: string; userName?: string; attachments?: AttachmentPayload[] };
		try {
			const raw = await this.readBody(req);
			body = JSON.parse(raw);
		} catch {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Invalid JSON body" }));
			return;
		}

		const { channelId, text, userName = "user", attachments = [] } = body;
		if (!channelId || !text) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Missing channelId or text" }));
			return;
		}

		if (this.handler.isRunning(channelId)) {
			res.writeHead(409, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Already running. POST /stop first." }));
			return;
		}

		// Open SSE stream
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});

		const send: SseEmitter = (event) => {
			if (!res.writableEnded) {
				res.write(`data: ${JSON.stringify(event)}\n\n`);
			}
		};

		const ts = (Date.now() / 1000).toFixed(6);
		const channelDir = join(this.workingDir, channelId);
		if (!existsSync(channelDir)) mkdirSync(channelDir, { recursive: true });

		// Save attachments to disk and build local refs for the agent
		const savedAttachments: Array<{ local: string }> = [];
		if (attachments.length > 0) {
			const attachDir = join(channelDir, "attachments");
			if (!existsSync(attachDir)) mkdirSync(attachDir, { recursive: true });
			for (const att of attachments) {
				const safeName = `${Date.now()}_${att.fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
				const filePath = join(attachDir, safeName);
				writeFileSync(filePath, Buffer.from(att.content, "base64"));
				savedAttachments.push({ local: `${channelId}/attachments/${safeName}` });
			}
		}

		const ctx = createHttpContext({ channelId, userName, text, ts, send, workingDir: this.workingDir, attachments: savedAttachments });

		// Log user message
		appendFileSync(
			join(channelDir, "log.jsonl"),
			`${JSON.stringify({
				date: new Date().toISOString(),
				ts,
				user: "web-user",
				userName,
				text,
				attachments: savedAttachments,
				isBot: false,
			})}\n`,
		);

		log.logInfo(`[${channelId}] HTTP: Starting run: ${text.substring(0, 50)}`);

		try {
			await this.handler.handleEvent(channelId, ctx);
			send({ type: "done" });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.logWarning(`[${channelId}] HTTP run error`, msg);
			send({ type: "error", message: msg });
		} finally {
			res.end();
		}
	}

	private async handleStop(req: IncomingMessage, res: ServerResponse): Promise<void> {
		let body: { channelId?: string };
		try {
			const raw = await this.readBody(req);
			body = JSON.parse(raw);
		} catch {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Invalid JSON body" }));
			return;
		}

		const { channelId } = body;
		if (!channelId) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Missing channelId" }));
			return;
		}

		if (this.handler.isRunning(channelId)) {
			await this.handler.handleStop(
				channelId,
				async () => {
					// HTTP: nothing to post — the open SSE stream handles status
				},
				async () => {
					// HTTP: nothing to update — the SSE stream sends its own done/stopped events
				},
			);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, message: "Stopping..." }));
		} else {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: false, message: "Nothing running" }));
		}
	}

	private handleStatus(channelId: string, res: ServerResponse): void {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ running: this.handler.isRunning(channelId) }));
	}

	private handleMessages(channelId: string, res: ServerResponse): void {
		type ContextEntry = { type: string; timestamp?: string; message?: Record<string, any> };
		type ChatMessage = { role: "user" | "assistant"; text: string; thread?: string; files?: Array<{ path: string; title?: string }> };

		const formatArgs = (args: Record<string, any>): string => {
			const lines: string[] = [];
			for (const [key, value] of Object.entries(args)) {
				if (key === "label") continue;
				if (key === "path" && typeof value === "string") {
					const range = args.offset !== undefined && args.limit !== undefined
						? `:${args.offset}-${args.offset + args.limit}`
						: "";
					lines.push(value + range);
					continue;
				}
				if (key === "offset" || key === "limit") continue;
				const str = typeof value === "string" ? value : JSON.stringify(value);
				lines.push(str.length > 300 ? str.slice(0, 300) + "…" : str);
			}
			return lines.join("\n");
		};

		const contextFile = join(this.workingDir, channelId, "context.jsonl");
		const messages: ChatMessage[] = [];

		if (existsSync(contextFile)) {
			try {
				const content = readFileSync(contextFile, "utf-8");
				const lines = content.trim().split("\n").filter(Boolean);

				const entries: ContextEntry[] = [];
				for (const line of lines) {
					try { entries.push(JSON.parse(line)); } catch { /* skip */ }
				}

				// Group into conversation turns. Each "user" message with text content
				// starts a new turn; assistant + toolResult entries belong to the previous turn.
				type ToolCall = { id: string; name: string; label?: string; args: Record<string, any> };
				type ToolResult = { toolCallId: string; toolName: string; text: string; isError: boolean };
				type Turn = {
					userText: string;
					toolCalls: ToolCall[];
					toolResults: ToolResult[];
					assistantTexts: string[];
				};

				// Strip "[2026-03-09 19:44:55+07:00] [user]: " or "[user]: " prefix from user text
				const stripPrefix = (text: string) =>
					text.replace(/^(?:\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] )?\[[^\]]+\]: /, "");

				const turns: Turn[] = [];

				for (const entry of entries) {
					if (entry.type !== "message" || !entry.message) continue;
					const msg = entry.message;

					if (msg.role === "user") {
						const textPart = (msg.content as any[])?.find((c: any) => c.type === "text");
						if (!textPart?.text) continue;
						turns.push({ userText: stripPrefix(textPart.text), toolCalls: [], toolResults: [], assistantTexts: [] });

					} else if (msg.role === "assistant") {
						if (turns.length === 0) continue;
						const turn = turns[turns.length - 1];
						for (const part of (msg.content as any[]) || []) {
							if (part.type === "toolCall") {
								turn.toolCalls.push({ id: part.id, name: part.name, label: part.arguments?.label, args: part.arguments ?? {} });
							} else if (part.type === "text" && part.text?.trim()) {
								turn.assistantTexts.push(part.text.trim());
							}
						}

					} else if (msg.role === "toolResult") {
						if (turns.length === 0) continue;
						const turn = turns[turns.length - 1];
						const text = (msg.content as any[])?.find((c: any) => c.type === "text")?.text ?? "";
						turn.toolResults.push({ toolCallId: msg.toolCallId, toolName: msg.toolName, text, isError: msg.isError });
					}
				}

					for (const turn of turns) {
					messages.push({ role: "user", text: turn.userText });

					const mainText = turn.assistantTexts[turn.assistantTexts.length - 1] ?? "";

					// Format tool calls + results as markdown thread, matched by toolCallId
					const threadParts: string[] = [];
					const files: Array<{ path: string; title?: string }> = [];
					for (const tc of turn.toolCalls) {
						const result = turn.toolResults.find((r) => r.toolCallId === tc.id);
						let block = `**${result?.isError ? "✗" : "✓"} ${tc.name}**`;
						if (tc.label) block += `: ${tc.label}`;
						const argsStr = formatArgs(tc.args);
						if (argsStr) block += `\n\`\`\`\n${argsStr}\n\`\`\``;
						if (result) {
							const resultStr = result.text;
							block += `\n**Result:**\n\`\`\`\n${resultStr.slice(0, 500)}${resultStr.length > 500 ? "\n…" : ""}\n\`\`\``;
						}
						threadParts.push(block);
						// Extract file refs from attach tool calls
						if (tc.name === "attach" && tc.args.path) {
							files.push({ path: tc.args.path as string, title: tc.args.title as string | undefined });
						}
					}

					const thread = threadParts.length > 0 ? threadParts.join("\n\n") : undefined;
					if (mainText || thread) {
						messages.push({ role: "assistant", text: mainText, thread, files: files.length > 0 ? files : undefined });
					}
				}
			} catch {
				// unreadable file
			}
		}

		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(messages));
	}

	private handleArtifactUrl(filePath: string, res: ServerResponse): void {
		// Artifacts files live at {workingDir}/artifacts/files/
		const artifactsFilesDir = join(this.workingDir, "artifacts", "files");

		if (!filePath || !filePath.startsWith(artifactsFilesDir)) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ url: null }));
			return;
		}

		const relativePath = filePath.slice(artifactsFilesDir.length).replace(/^\//, "");

		// Prefer public Cloudflare Tunnel URL (not localhost), otherwise serve via core-service
		let url = `http://localhost:${this.port}/artifacts/${relativePath}`;
		const tunnelUrlFile = "/tmp/artifacts-url.txt";
		if (existsSync(tunnelUrlFile)) {
			try {
				const tunnelUrl = readFileSync(tunnelUrlFile, "utf-8").trim();
				if (tunnelUrl && !tunnelUrl.includes("localhost") && !tunnelUrl.includes("127.0.0.1")) {
					url = `${tunnelUrl}/${relativePath}`;
				}
			} catch { /* use local fallback */ }
		}

		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ url }));
	}

	private handleArtifactStatic(relativePath: string, res: ServerResponse): void {
		// Decode URL-encoded characters and strip query string
		const cleanPath = decodeURIComponent(relativePath.split("?")[0]);
		const resolved = join(this.workingDir, "artifacts", "files", cleanPath);

		// Security: must stay within artifacts/files/
		const artifactsFilesDir = join(this.workingDir, "artifacts", "files");
		if (!resolved.startsWith(artifactsFilesDir)) {
			res.writeHead(403);
			res.end();
			return;
		}

		if (!existsSync(resolved)) {
			res.writeHead(404);
			res.end();
			return;
		}

		const ext = resolved.split(".").pop()?.toLowerCase() ?? "";
		const mimeTypes: Record<string, string> = {
			html: "text/html", htm: "text/html",
			css: "text/css", js: "text/javascript", mjs: "text/javascript",
			json: "application/json", txt: "text/plain",
			png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
			gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
			woff: "font/woff", woff2: "font/woff2",
		};
		const contentType = mimeTypes[ext] ?? "application/octet-stream";

		try {
			const content = readFileSync(resolved);
			res.writeHead(200, { "Content-Type": contentType, "Access-Control-Allow-Origin": "*" });
			res.end(content);
		} catch {
			res.writeHead(500);
			res.end();
		}
	}

	private handleFile(filePath: string, res: ServerResponse): void {
		if (!filePath) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Missing path" }));
			return;
		}

		// Security: only allow files within workingDir
		const resolved = filePath.startsWith("/") ? filePath : join(this.workingDir, filePath);
		if (!resolved.startsWith(this.workingDir)) {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Forbidden" }));
			return;
		}

		if (!existsSync(resolved)) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Not found" }));
			return;
		}

		const ext = resolved.split(".").pop()?.toLowerCase() ?? "";
		const mimeTypes: Record<string, string> = {
			html: "text/html", htm: "text/html",
			css: "text/css", js: "text/javascript", ts: "text/plain",
			json: "application/json", md: "text/plain", txt: "text/plain",
			png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
			gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
			pdf: "application/pdf",
		};
		const contentType = mimeTypes[ext] ?? "application/octet-stream";

		try {
			const content = readFileSync(resolved);
			res.writeHead(200, { "Content-Type": contentType, "Access-Control-Allow-Origin": "*" });
			res.end(content);
		} catch {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Read error" }));
		}
	}

	private handleSessions(res: ServerResponse): void {
		type SessionInfo = { channelId: string; preview: string; messageCount: number; lastModified: number };
		const sessions: SessionInfo[] = [];

		try {
			if (existsSync(this.workingDir)) {
				const entries = readdirSync(this.workingDir, { withFileTypes: true });
				for (const entry of entries) {
					if (!entry.isDirectory()) continue;
					const logFile = join(this.workingDir, entry.name, "log.jsonl");
					if (!existsSync(logFile)) continue;

					try {
						const stat = statSync(logFile);
						const content = readFileSync(logFile, "utf-8");
						const lines = content.trim().split("\n").filter(Boolean);
						let messageCount = 0;
						let preview = "";

						for (const line of lines) {
							try {
								const msg = JSON.parse(line);
								if (!msg.isBot && msg.text) {
									messageCount++;
									if (!preview) preview = msg.text;
								}
							} catch {
								// skip malformed lines
							}
						}

						sessions.push({
							channelId: entry.name,
							preview: preview.length > 80 ? preview.slice(0, 80) + "…" : preview,
							messageCount,
							lastModified: stat.mtimeMs,
						});
					} catch {
						// skip unreadable sessions
					}
				}
			}
		} catch {
			// workingDir unreadable
		}

		sessions.sort((a, b) => b.lastModified - a.lastModified);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(sessions));
	}

	// ==========================================================================
	// Helpers
	// ==========================================================================

	private readBody(req: IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
			req.on("error", reject);
		});
	}
}
