import { html, LitElement } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import type { MessageEditor } from "./MessageEditor.js";
import { CoreServiceClient, type AttachmentPayload, type SseEvent } from "../adapters/core-service.js";
import type { Attachment } from "../utils/attachment-utils.js";
import "./MessageEditor.js";
import "./SandboxedIframe.js";
import type { SandboxIframe } from "./SandboxedIframe.js";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";

// ============================================================================
// File viewer sub-component
// ============================================================================

@customElement("core-service-file-viewer")
class CoreServiceFileViewer extends LitElement {
	@property() declare path: string;
	@property() declare title: string;
	@property() declare baseUrl: string;

	@state() private declare content: string | null;
	@state() private declare mimeType: string;
	@state() private declare loading: boolean;
	@state() private declare artifactUrl: string | null;

	private sandboxRef = createRef<SandboxIframe>();

	constructor() {
		super();
		this.path = "";
		this.title = "";
		this.baseUrl = "";
		this.content = null;
		this.mimeType = "text/plain";
		this.loading = true;
		this.artifactUrl = null;
	}

	protected override createRenderRoot() { return this; }

	override async connectedCallback() {
		super.connectedCallback();
		await this.loadFile();
	}

	override async willUpdate(changed: Map<string, unknown>) {
		if (changed.has("path") && changed.get("path") !== undefined) {
			this.content = null;
			this.mimeType = "text/plain";
			this.artifactUrl = null;
			this.loading = true;
			await this.loadFile();
		}
	}

	private async loadFile() {
		if (!this.path) return;
		const client = new CoreServiceClient(this.baseUrl);
		const [result, artifactUrl] = await Promise.all([
			client.getFileContent(this.path),
			client.getArtifactUrl(this.path),
		]);
		if (result) {
			this.content = result.content;
			this.mimeType = result.mimeType.split(";")[0].trim();
		} else {
			this.content = null;
		}
		this.artifactUrl = artifactUrl;
		this.loading = false;
	}

	override updated() {
		if (this.isHtml && !this.artifactUrl && this.content && this.sandboxRef.value) {
			const sandboxId = `file-${this.path}`;
			this.sandboxRef.value.loadContent(sandboxId, this.content);
		}
	}

	private get isHtml() {
		return this.mimeType === "text/html";
	}

	private get isImage() {
		return this.mimeType.startsWith("image/");
	}

	override render() {
		const name = this.title || this.path.split("/").pop() || this.path;
		if (this.loading) {
			return html`<div class="text-xs text-muted-foreground italic">Loading ${name}…</div>`;
		}
		if (this.content === null) {
			return html`<div class="text-xs text-destructive">Could not load ${name}</div>`;
		}
		if (this.isHtml) {
			if (this.artifactUrl) {
				return html`<iframe src=${this.artifactUrl} style="display:block;width:100%;height:100%;min-height:400px;border:none"
					sandbox="allow-scripts allow-same-origin allow-modals allow-popups"></iframe>`;
			}
			return html`<sandbox-iframe ${ref(this.sandboxRef)} style="display:block;width:100%;height:400px"></sandbox-iframe>`;
		}
		if (this.isImage) {
			const src = `${this.baseUrl}/file?path=${encodeURIComponent(this.path)}`;
			return html`<img src=${src} class="max-w-full" alt=${name} />`;
		}
		return html`<markdown-block .content=${"\`\`\`\n" + this.content.slice(0, 2000) + (this.content.length > 2000 ? "\n…" : "") + "\n\`\`\`"}></markdown-block>`;
	}
}

type ChatMessage =
	| { role: "user"; text: string; attachments?: string[] }
	| { role: "assistant"; text: string; thread?: string; files?: FileRef[] }
	| { role: "error"; text: string };

type FileRef = { path: string; title?: string };

@customElement("core-service-chat-panel")
export class CoreServiceChatPanel extends LitElement {
	@property() declare baseUrl: string;
	@property() declare channelId: string;
	@property() declare userName: string | undefined;

	@state() private declare messages: ChatMessage[];
	@state() private declare streamingText: string;
	@state() private declare streamingThread: string;
	@state() private declare streamingStatus: string;
	@state() private declare streamingFiles: FileRef[];
	@state() private declare isStreaming: boolean;
	@state() private declare rightPanelFile: FileRef | null;
	@state() private declare rightPanelArtifactUrl: string | null;

	@query("message-editor") private declare _editor: MessageEditor;

	private client!: CoreServiceClient;
	private abortController?: AbortController;
	private scrollContainer?: HTMLElement;
	private autoScroll = true;

	constructor() {
		super();
		this.baseUrl = "http://localhost:3030";
		this.channelId = "default";
		this.userName = undefined;
		this.messages = [];
		this.streamingText = "";
		this.streamingThread = "";
		this.streamingStatus = "";
		this.streamingFiles = [];
		this.isStreaming = false;
		this.rightPanelFile = null;
		this.rightPanelArtifactUrl = null;
	}

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback() {
		super.connectedCallback();
		this.client = new CoreServiceClient(this.baseUrl);
		this.style.display = "flex";
		this.style.flexDirection = "column";
		this.style.flex = "1";
		this.style.width = "100%";
		this.style.height = "100%";
		this.style.minHeight = "0";
		this.loadHistory();
	}

	override willUpdate(changed: Map<string, unknown>) {
		if (changed.has("channelId") && changed.get("channelId") !== undefined) {
			// channelId changed after initial connect — reset and reload
			this.messages = [];
			this.streamingText = "";
			this.streamingThread = "";
			this.streamingStatus = "";
			this.streamingFiles = [];
			this.isStreaming = false;
			this.rightPanelFile = null;
			this.rightPanelArtifactUrl = null;
			this.scrollContainer = undefined;
			this.loadHistory();
		}
	}

	private async loadHistory() {
		const msgs = await this.client.getMessages(this.channelId);
		this.messages = msgs.map((m) => ({ role: m.role, text: m.text, thread: (m as any).thread, files: (m as any).files, attachments: (m as any).attachments }));
		this.autoScroll = true;
	}

	override updated() {
		if (!this.scrollContainer) {
			this.scrollContainer = this.querySelector(".overflow-y-auto") as HTMLElement;
			if (this.scrollContainer) {
				this.scrollContainer.addEventListener("scroll", this.handleScroll);
			}
		}
		if (this.autoScroll && this.scrollContainer) {
			this.scrollContainer.scrollTop = this.scrollContainer.scrollHeight;
		}
	}

	private handleScroll = () => {
		if (!this.scrollContainer) return;
		const { scrollTop, scrollHeight, clientHeight } = this.scrollContainer;
		this.autoScroll = scrollHeight - scrollTop - clientHeight < 50;
	};

	private async handleSend(text: string, attachments: Attachment[] = []) {
		if (!text.trim() && attachments.length === 0) return;
		if (this.isStreaming) return;

		const attachmentNames = attachments.map((a) => a.fileName);
	this.messages = [...this.messages, { role: "user", text, attachments: attachmentNames.length > 0 ? attachmentNames : undefined }];
		if (this._editor) {
			this._editor.value = "";
			this._editor.attachments = [];
		}
		this.streamingText = "";
		this.streamingThread = "";
		this.streamingStatus = "";
		this.streamingFiles = [];
		this.isStreaming = true;
		this.autoScroll = true;

		const attachmentPayloads: AttachmentPayload[] = attachments.map((a) => ({
			fileName: a.fileName,
			mimeType: a.mimeType,
			content: a.content,
		}));

		this.abortController = new AbortController();
		try {
			for await (const event of this.client.chat(this.channelId, text, this.userName, this.abortController.signal, attachmentPayloads)) {
				this.handleSseEvent(event);
			}
		} catch (err: any) {
			if (err.name !== "AbortError") {
				this.messages = [...this.messages, { role: "error", text: String(err) }];
			}
		} finally {
			const hasContent = this.streamingText || this.streamingThread || this.streamingFiles.length > 0;
			if (hasContent) {
				this.messages = [
					...this.messages,
					{
						role: "assistant",
						text: this.streamingText,
						thread: this.streamingThread || undefined,
						files: this.streamingFiles.length > 0 ? [...this.streamingFiles] : undefined,
					},
				];
			}
			this.streamingText = "";
			this.streamingThread = "";
			this.streamingStatus = "";
			this.streamingFiles = [];
			this.isStreaming = false;
		}
	}

	private handleSseEvent(event: SseEvent) {
		switch (event.type) {
			case "delta":
				this.streamingText += event.text;
				break;
			case "replace":
				this.streamingText = event.text;
				break;
			case "thread":
				this.streamingThread += event.text;
				break;
			case "status":
				this.streamingStatus = event.status;
				break;
			case "file":
				this.streamingFiles = [...this.streamingFiles, { path: event.path, title: event.title }];
				break;
			case "delete":
				// Bot deleted its current response — clear accumulated text
				this.streamingText = "";
				break;
			case "error":
				this.messages = [...this.messages, { role: "error", text: event.message }];
				break;
			case "done":
				// Stream ends naturally; finally block commits the message
				break;
		}
	}

	private handleAbort() {
		this.abortController?.abort();
		this.client.stop(this.channelId);
	}

	override render() {
		return html`
			<div class="flex flex-row h-full bg-background text-foreground overflow-hidden">
				<!-- Chat Column -->
				<div class="flex flex-col flex-1 min-w-0 h-full">
					<!-- Messages Area -->
					<div class="flex-1 overflow-y-auto">
						<div class="max-w-3xl mx-auto p-4 pb-6 flex flex-col gap-3">
							${this.messages.map((msg) => this.renderMessage(msg))}
							${this.isStreaming ? this.renderStreaming() : ""}
						</div>
					</div>

					<!-- Input Area -->
					<div class="shrink-0">
						<div class="max-w-3xl mx-auto px-2 pb-4">
							<message-editor
								.isStreaming=${this.isStreaming}
								.showAttachmentButton=${true}
								.showModelSelector=${false}
								.showThinkingSelector=${false}
								.onSend=${(text: string, attachments: Attachment[]) => this.handleSend(text, attachments)}
								.onAbort=${() => this.handleAbort()}
							></message-editor>
						</div>
					</div>
				</div>

				<!-- Right Panel -->
				${this.rightPanelFile ? this.renderRightPanel(this.rightPanelFile) : ""}
			</div>
		`;
	}

	private openRightPanel(f: FileRef) {
		this.rightPanelFile = f;
		this.rightPanelArtifactUrl = null;
		this.client.getArtifactUrl(f.path).then((url) => { this.rightPanelArtifactUrl = url; });
	}

	private renderRightPanel(f: FileRef) {
		const name = f.title || f.path.split("/").pop() || f.path;
		return html`
			<div class="flex flex-col w-[480px] shrink-0 border-l border-border h-full">
				<div class="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30 shrink-0">
					<span class="text-sm font-medium truncate">${name}</span>
					<div class="flex items-center gap-3 ml-2 shrink-0">
						${this.rightPanelArtifactUrl ? html`
							<a href=${this.rightPanelArtifactUrl} target="_blank" rel="noopener"
								class="text-xs text-muted-foreground hover:text-foreground">open ↗</a>
						` : ""}
						<button class="text-muted-foreground hover:text-foreground"
							@click=${() => { this.rightPanelFile = null; }}>✕</button>
					</div>
				</div>
				<div class="flex-1 overflow-auto">
					<core-service-file-viewer
						.path=${f.path}
						.title=${f.title || ""}
						.baseUrl=${this.baseUrl}
					></core-service-file-viewer>
				</div>
			</div>
		`;
	}

	private renderThreadBlock(block: string) {
		const nlIdx = block.indexOf("\n");
		const header = nlIdx === -1 ? block : block.slice(0, nlIdx);
		const body = nlIdx === -1 ? "" : block.slice(nlIdx + 1).trim();
		// Strip bold/italic markers: **✓ write** or *✓ write* → ✓ write
		const cleanHeader = header.replace(/\*+/g, "");

		if (!body) {
			return html`<div class="py-0.5 text-muted-foreground">${cleanHeader}</div>`;
		}
		return html`
			<details class="group">
				<summary class="cursor-pointer flex items-center gap-1.5 py-0.5 text-muted-foreground hover:text-foreground select-none [&::-webkit-details-marker]:hidden [&::marker]:hidden">
					<span class="text-[10px] transition-transform duration-150 group-open:rotate-90">▶</span>
					<span>${cleanHeader}</span>
				</summary>
				<div class="mt-1 ml-3.5">
					<markdown-block .content=${body}></markdown-block>
				</div>
			</details>
		`;
	}

	private renderThread(thread: string) {
		// Split into per-tool blocks: each starts with *✓ or *✗ (streaming) or **✓ /**✗ (history)
		const blocks = thread.split(/\n(?=\*{1,2}[✓✗])/).filter(Boolean);
		return html`
			<div class="flex flex-col border-l-2 border-border pl-3 text-sm">
				${blocks.map((b) => this.renderThreadBlock(b))}
			</div>
		`;
	}

	private renderMessage(msg: ChatMessage) {
		if (msg.role === "user") {
			return html`
				<div class="flex justify-start mx-4">
					<div class="user-message-container py-2 px-4 rounded-xl flex flex-col gap-2">
						${msg.attachments?.map((name) => html`
							<div class="flex items-center gap-1.5 text-xs opacity-70">
								<span>📎</span><span class="truncate max-w-xs">${name}</span>
							</div>
						`)}
						<markdown-block .content=${msg.text}></markdown-block>
					</div>
				</div>
			`;
		}
		if (msg.role === "assistant") {
			return html`
				<div class="px-4 flex flex-col gap-3">
					${msg.text ? html`<markdown-block .content=${msg.text}></markdown-block>` : ""}
					${msg.thread ? this.renderThread(msg.thread) : ""}
					${msg.files?.map((f) => this.renderFile(f))}
				</div>
			`;
		}
		if (msg.role === "error") {
			return html`
				<div class="mx-4 p-3 bg-destructive/10 text-destructive rounded-lg text-sm">
					<strong>Error:</strong> ${msg.text}
				</div>
			`;
		}
		return "";
	}

	private renderFile(f: FileRef) {
		const name = f.title || f.path.split("/").pop() || f.path;
		const isActive = this.rightPanelFile?.path === f.path;
		return html`
			<button
				class="flex items-center gap-2 px-3 py-2 rounded-lg border text-sm text-left transition-colors
					${isActive
						? "border-primary bg-primary/10 text-primary"
						: "border-border bg-muted/30 hover:bg-muted/60 text-foreground"}"
				@click=${() => this.openRightPanel(f)}
			>
				<span>📄</span>
				<span class="truncate">${name}</span>
				<span class="ml-auto text-xs text-muted-foreground shrink-0">open ↗</span>
			</button>
		`;
	}

	private renderStreaming() {
		const hasContent = this.streamingText || this.streamingThread || this.streamingFiles.length > 0;

		if (!hasContent) {
			const label = this.streamingStatus || "thinking";
			return html`<div class="px-4 text-sm text-muted-foreground italic animate-pulse">${label}...</div>`;
		}
		return html`
			<div class="px-4 flex flex-col gap-3">
				${this.streamingStatus
					? html`<div class="text-xs text-muted-foreground italic">${this.streamingStatus}...</div>`
					: ""}
				${this.streamingText ? html`<markdown-block .content=${this.streamingText}></markdown-block>` : ""}
				${this.streamingThread ? this.renderThread(this.streamingThread) : ""}
				${this.streamingFiles.map((f) => this.renderFile(f))}
			</div>
		`;
	}
}
