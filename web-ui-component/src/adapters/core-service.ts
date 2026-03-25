export type SseEvent =
	| { type: "status"; status: "thinking" | "working" | "idle" | "stopped" }
	| { type: "delta"; text: string }
	| { type: "replace"; text: string }
	| { type: "thread"; text: string }
	| { type: "file"; path: string; title?: string }
	| { type: "delete" }
	| { type: "done" }
	| { type: "error"; message: string };

export type AttachmentPayload = {
	fileName: string;
	mimeType: string;
	content: string; // base64
};

export class CoreServiceClient {
	constructor(private baseUrl: string) {}

	async *chat(channelId: string, text: string, userName?: string, signal?: AbortSignal, attachments?: AttachmentPayload[]): AsyncGenerator<SseEvent> {
		const response = await fetch(`${this.baseUrl}/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ channelId, text, userName, attachments }),
			signal,
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${await response.text()}`);
		}

		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					if (line.startsWith("data: ")) {
						const data = line.slice(6).trim();
						try {
							yield JSON.parse(data) as SseEvent;
						} catch {
							// ignore malformed lines
						}
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	async stop(channelId: string): Promise<void> {
		await fetch(`${this.baseUrl}/stop`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ channelId }),
		});
	}

	async isRunning(channelId: string): Promise<boolean> {
		const response = await fetch(`${this.baseUrl}/status/${encodeURIComponent(channelId)}`);
		if (!response.ok) return false;
		const data = await response.json();
		return data.running === true;
	}

	async getMessages(channelId: string): Promise<Array<{ role: "user" | "assistant"; text: string }>> {
		try {
			const response = await fetch(`${this.baseUrl}/messages/${encodeURIComponent(channelId)}`);
			if (!response.ok) return [];
			return response.json();
		} catch {
			return [];
		}
	}

	async getArtifactUrl(path: string): Promise<string | null> {
		try {
			const response = await fetch(`${this.baseUrl}/artifact-url?path=${encodeURIComponent(path)}`);
			if (!response.ok) return null;
			const data = await response.json();
			return data.url ?? null;
		} catch {
			return null;
		}
	}

	async getFileContent(path: string): Promise<{ content: string; mimeType: string } | null> {
		try {
			const response = await fetch(`${this.baseUrl}/file?path=${encodeURIComponent(path)}`);
			if (!response.ok) return null;
			const mimeType = response.headers.get("content-type") ?? "text/plain";
			const content = await response.text();
			return { content, mimeType };
		} catch {
			return null;
		}
	}

	async getSessions(): Promise<SessionInfo[]> {
		try {
			const response = await fetch(`${this.baseUrl}/sessions`);
			if (!response.ok) return [];
			return response.json();
		} catch {
			return [];
		}
	}
}

export type SessionInfo = {
	channelId: string;
	preview: string;
	messageCount: number;
	lastModified: number;
};
