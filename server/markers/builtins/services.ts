/**
 * builtins/services.ts — 后台服务登记（复刻 pi-marker-tools）。
 */

import type { ApplyResult, MarkerTool, MarkerOverlay, ParsedToken, MarkerContext } from "../marker.js";

export const SVC_NAMESPACE = "svc";

export interface Service {
	id: number;
	name: string;
	command?: string;
	pid?: number;
	port?: number;
	startedAt: number;
	stopped: boolean;
	stoppedAt?: number;
}

export interface ServiceState {
	services: Service[];
	nextId: number;
}

export function initServiceState(): ServiceState {
	return { services: [], nextId: 1 };
}

function parseId(raw: string | undefined): number | null {
	if (raw === undefined) return null;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : null;
}

function toInt(raw: string | undefined): number | undefined {
	if (raw === undefined || raw === "") return undefined;
	const n = Number(raw);
	return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function findService(state: ServiceState, id: number): Service | undefined {
	return state.services.find((s) => s.id === id);
}

function lineOf(s: Service): string {
	const meta = [s.pid !== undefined ? `pid ${s.pid}` : "", s.port !== undefined ? `:${s.port}` : ""].filter(Boolean).join(" ");
	return `${s.stopped ? "[x]" : "[ ]"} #${s.id}: ${s.name}${meta ? ` (${meta})` : ""}${s.command ? ` — ${s.command}` : ""}`;
}

export function describeServices(state: ServiceState): string {
	if (!state || state.services.length === 0) return "[svc] (空)";
	return state.services.map(lineOf).join("\n");
}

export const servicesMarker: MarkerTool<ServiceState> = {
	name: "svc",
	guidance: [
		"- 后台服务登记（todo 风格）：[[svc:add:名称,pid=,port=,cmd=]] 登记；[[svc:stop:<id>]] 标记停止；[[svc:resume:<id>]] 标记运行；[[svc:remove:<id>]] 删除；[[svc:clear:]] 清空。",
		"- 用 bash 启动后台服务（nohup ... &、pm2 start、docker run -d 等）后，立即写 [[svc:add:...]] 登记，尽量带 pid= 和 port=；服务退出或被关闭后写 [[svc:stop:<id>]] 保持清单准确。",
	],

	async apply(token: ParsedToken, _ctx: MarkerContext, _state: ServiceState): Promise<ApplyResult> {
		const state = _state;
		const op = token.op;
		switch (op) {
			case "add": {
				const name = token.args[0]?.trim();
				if (!name) return { applied: false, error: "svc:add 需要一个名称参数 [[svc:add:<名称>,pid=,port=,cmd=]]" };
				const svc: Service = {
					id: state.nextId++,
					name,
					command: token.kwargs["cmd"],
					pid: toInt(token.kwargs["pid"]),
					port: toInt(token.kwargs["port"]),
					startedAt: Date.now(),
					stopped: false,
				};
				state.services.push(svc);
				const meta = [svc.pid !== undefined ? `pid ${svc.pid}` : "", svc.port !== undefined ? `:${svc.port}` : ""].filter(Boolean).join(" ");
				return { applied: true, feedback: `Registered #${svc.id}: ${name}${meta ? ` (${meta})` : ""}` };
			}
			case "stop": {
				const id = parseId(token.args[0]);
				if (id === null) return { applied: false, error: `svc:stop 的 id 无效: "${token.args[0] ?? ""}"` };
				const svc = findService(state, id);
				if (!svc) return { applied: false, error: `svc:stop 服务 #${id} 不存在` };
				svc.stopped = true;
				svc.stoppedAt = Date.now();
				return { applied: true, feedback: `#${id} ${svc.name} marked stopped` };
			}
			case "resume": {
				const id = parseId(token.args[0]);
				if (id === null) return { applied: false, error: `svc:resume 的 id 无效: "${token.args[0] ?? ""}"` };
				const svc = findService(state, id);
				if (!svc) return { applied: false, error: `svc:resume 服务 #${id} 不存在` };
				svc.stopped = false;
				svc.stoppedAt = undefined;
				return { applied: true, feedback: `#${id} ${svc.name} marked running` };
			}
			case "remove": {
				const id = parseId(token.args[0]);
				if (id === null) return { applied: false, error: `svc:remove 的 id 无效: "${token.args[0] ?? ""}"` };
				const before = state.services.length;
				state.services = state.services.filter((s) => s.id !== id);
				if (state.services.length === before) return { applied: false, error: `svc:remove 服务 #${id} 不存在` };
				return { applied: true, feedback: `Removed #${id}` };
			}
			case "clear": {
				const n = state.services.length;
				state.services = [];
				state.nextId = 1;
				return { applied: true, feedback: `Cleared ${n} service(s)` };
			}
			default:
				return { applied: false, error: `svc 未知操作: ${op}` };
		}
	},

	overlay(state: ServiceState): MarkerOverlay | undefined {
		if (!state || state.services.length === 0) return undefined;
		const running = state.services.filter((s) => !s.stopped).length;
		const lines = state.services.map((s) => {
			const mark = s.stopped ? "○" : "●";
			let line = ` ${mark} #${s.id} ${s.name}`;
			if (s.port !== undefined) line += ` :${s.port}`;
			if (s.pid !== undefined) line += ` (pid ${s.pid})`;
			if (s.stopped) line += " 已停止";
			return line;
		});
		return { tool: "svc", lines: [`${running}/${state.services.length} running`, ...lines] };
	},

	init: initServiceState,
};
