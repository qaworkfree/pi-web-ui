import { appSend } from "./app-globals";
import { randomUuid } from "./uuid";
import type { ClientMessage, ServerMessage } from "./types";

type DirectoryRequest = Extract<
	ClientMessage,
	{ type: "complete_path" | "set_cwd" | "make_dir" | "grant_folder_access" }
>;
export type DirectoryReply = Extract<ServerMessage, { type: "path_completions" | "directory_result" }>;
const pending = new Map<string, { finish: (reply?: DirectoryReply, error?: Error) => void }>();

/** Match replies to the picker request, independently of composer completions. */
export function receiveDirectoryReply(reply: DirectoryReply): void {
	if (reply.requestId) pending.get(reply.requestId)?.finish(reply);
}

export function disconnectDirectoryRequests(): void {
	for (const request of pending.values())
		request.finish(undefined, new Error("Connection lost. Reconnect and try again."));
}

export function requestDirectory(message: DirectoryRequest, signal?: AbortSignal): Promise<DirectoryReply> {
	return new Promise((resolve, reject) => {
		const requestId = randomUuid();
		const abort = () => finish(undefined, new Error("Request cancelled"));
		const timer = setTimeout(
			() => finish(undefined, new Error("The folder operation timed out. Check the connection and try again.")),
			60_000,
		);
		const finish = (reply?: DirectoryReply, error?: Error) => {
			if (!pending.delete(requestId)) return;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			if (error || (reply?.type === "directory_result" && reply.error)) reject(error ?? new Error(reply!.error));
			else if (reply) resolve(reply);
		};
		pending.set(requestId, { finish });
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		else if (!appSend({ ...message, requestId }))
			finish(undefined, new Error("Not connected. Reconnect and try again."));
	});
}
