/**
 * goal-rpc.mjs — pi-web-ui DSH runtime 的 goal RPC 扩展插件。
 *
 * 在官方 dsh-sdk-jsonrpc-server 之上包一层，为 stdio JSON-RPC 面增加 goal
 * 方法（goal/set goal/get goal/clear goal/resume goal/edit），直连 DSH 原生
 * goal 域（ctx.goals 服务，dsh-goal）。这样 pi-web-ui 前端的目标条驱动的是
 * DSH 自己的持久化目标状态机 + goal-round-driver 自动轮次，而不是另造一套
 * 审查会话 —— 审查语义 = DSH 原生（模型自判定 complete/blocked，轮次自动续）。
 *
 * 与官方插件的差异：inject 增加 "goals"（goal 域服务依赖）；handleRequest
 * 增加 goal 分支；其余 stdio transport / shutdown 语义原样继承。
 *
 * 官方入口（做 base 类）从环境变量解析：PI_WEB_DSH_JSONRPC_ENTRY 由 dsh-client
 * 注入（指向项目 node_modules 的官方包）；兜底从本文件位置向上找项目依赖。
 */
import { resolve } from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 官方 jsonrpc-server 入口（env 优先，兜底项目 node_modules）。 */
const officialEntry = process.env.PI_WEB_DSH_JSONRPC_ENTRY
	? resolve(process.env.PI_WEB_DSH_JSONRPC_ENTRY)
	: join(
			resolve(HERE, "..", "..", "..", ".."),
			"node_modules",
			"@deepseek-ai",
			"dsh-sdk-jsonrpc-server",
			"lib",
			"index.js",
		);

const official = await import(pathToFileURL(officialEntry).href);
const {
	HarnessSdkJsonRpcServer,
	Config,
	apply: officialApply,
} = official;

/** 提问桥超时（P0-6）：PI_WEB_DSH_QUESTION_TIMEOUT_MS 可配置，默认 10 分钟。 */
const QUESTION_TIMEOUT_MS =
	Number(process.env.PI_WEB_DSH_QUESTION_TIMEOUT_MS) || 10 * 60_000;

/** goal view → RPC 载荷（紧凑 JSON；view 是扁平结构，无目标时 get 返回 undefined）。 */
function viewPayload(view) {
	if (!view || view.id === undefined) return { goal: null, activation: null };
	return {
		goal: {
			id: view.id,
			revision: view.revision,
			objective: view.objective,
			phase: view.phase,
			maxGoalRounds: view.maxGoalRounds,
			...(view.blockedReason === void 0 ? {} : { blockedReason: view.blockedReason }),
			roundsStarted: view.roundsStarted ?? 0,
		},
		activation: view.activation ?? null,
	};
}

/** 取会话的 live agent（不存在则按需创建，与 prompt 的隐式建会话一致）。 */
function agentOf(server, sessionId) {
	return server.getOrCreateSession(sessionId).then((rec) => rec.handle.agent);
}

/**
 * 官方 SDK server 的 goal 扩展：goal/* 方法直连 ctx.goals 服务动词。
 */
class DshGoalJsonRpcServer extends HarnessSdkJsonRpcServer {
	/**
	 * 创建（或替换已完成的）目标并 arm —— round-driver 会在 agent idle 时
	 * 自动续第一轮，不需要额外 prompt。
	 */
	async goalSet(params) {
		if (typeof params?.sessionId !== "string") throw new TypeError("goal/set requires sessionId");
		if (typeof params?.objective !== "string" || !params.objective.trim()) {
			throw new TypeError("goal/set requires a non-empty objective");
		}
		const agent = await agentOf(this, params.sessionId);
		const request = { objective: params.objective.trim() };
		if (Number.isSafeInteger(params.maxGoalRounds) && params.maxGoalRounds > 0) {
			request.maxGoalRounds = params.maxGoalRounds;
		}
		return viewPayload(this.ctx.goals.create(agent, request));
	}

	/** 当前目标视图（goal 或 null）。 */
	async goalGet(params) {
		if (typeof params?.sessionId !== "string") throw new TypeError("goal/get requires sessionId");
		const agent = await agentOf(this, params.sessionId);
		return viewPayload(this.ctx.goals.get(agent));
	}

	/** 清除当前目标（保留 durable 墓碑与历史）。 */
	async goalClear(params) {
		if (typeof params?.sessionId !== "string") throw new TypeError("goal/clear requires sessionId");
		const agent = await agentOf(this, params.sessionId);
		const view = this.ctx.goals.get(agent);
		if (view === void 0 || view.id === void 0) return { cleared: false };
		this.ctx.goals.clear(agent, { id: view.id, revision: view.revision });
		return { cleared: true };
	}

	/** 恢复被 disarm 的目标（abort 重启运行时后轮次驱动停止，需要 resume 续）。 */
	async goalResume(params) {
		if (typeof params?.sessionId !== "string") throw new TypeError("goal/resume requires sessionId");
		const agent = await agentOf(this, params.sessionId);
		const view = this.ctx.goals.get(agent);
		if (view === void 0 || view.id === void 0) throw new Error("no current goal to resume");
		return viewPayload(
			this.ctx.goals.resume(agent, { id: view.id, revision: view.revision }),
		);
	}

	/** 编辑目标（改客观文本或轮次上限，不改 phase）。 */
	async goalEdit(params) {
		if (typeof params?.sessionId !== "string") throw new TypeError("goal/edit requires sessionId");
		const agent = await agentOf(this, params.sessionId);
		const view = this.ctx.goals.get(agent);
		if (view === void 0 || view.id === void 0) throw new Error("no current goal to edit");
		const request = {};
		if (typeof params?.objective === "string" && params.objective.trim()) {
			request.objective = params.objective.trim();
		}
		if (Number.isSafeInteger(params?.maxGoalRounds) && params.maxGoalRounds > 0) {
			request.maxGoalRounds = params.maxGoalRounds;
		}
		if (request.objective === undefined && request.maxGoalRounds === undefined) {
			throw new TypeError("goal/edit requires objective and/or maxGoalRounds");
		}
		return viewPayload(
			this.ctx.goals.edit(agent, { id: view.id, revision: view.revision }, request),
		);
	}

	/** 方法分发：goal/* 与 attachment/* 走上面/下面，其余交官方。 */
	async handleRequest(method, params) {
		switch (method) {
			case "goal/set":
				return this.goalSet(params);
			case "goal/get":
				return this.goalGet(params);
			case "goal/clear":
				return this.goalClear(params);
			case "goal/resume":
				return this.goalResume(params);
			case "goal/edit":
				return this.goalEdit(params);
			case "attachment/save":
				return this.attachmentSave(params);
			case "attachment/read":
				return this.attachmentRead(params);
			case "question/answer":
				return this.answerQuestion(params);
			case "model/list":
				return this.listModels(params);
			default:
				return super.handleRequest(method, params);
		}
	}

	/** P2-17 模型目录动态化：查询 adapter（ctx.llm）的真实模型清单。
	 *  dsh-llm-deepseek 的 listModels 返回模型目录（含 inputModalities），
	 *  失败时返回空数组（服务端回退本地表）。 */
	async listModels(params) {
		try {
			const providerId = params?.provider ?? "deepseek-official";
			const models = await this.ctx.llm.listModels?.(providerId);
			if (!Array.isArray(models)) return { models: [] };
			return {
				models: models.map((m) => ({
					id: m.id,
					...(m.name ? { name: m.name } : {}),
					...(Array.isArray(m.inputModalities)
						? { inputModalities: m.inputModalities }
						: Array.isArray(m.input)
							? { inputModalities: m.input }
							: {}),
				})),
			};
		} catch (err) {
			return { models: [], error: err?.message ?? String(err) };
		}
	}

	// -----------------------------------------------------------------------
	// 用户提问桥（交互式调研/确认）：模型调 ask_user_question 工具 →
	// ctx.userQuestions.ask() 阻塞 → 本 provider 把问题发给浏览器 →
	// question/answer RPC 带回答案 → 工具结果恢复模型循环。
	// -----------------------------------------------------------------------

	/** 挂起的提问 + 排队（apply 注册 provider 时初始化）。一次只向浏览器展示一个。 */
	questionBridge = { pending: null, queue: [] };

	/** 把队首提问变为 pending（发通知给浏览器）。 */
	dispatchNextQuestion() {
		if (this.questionBridge.pending) return;
		const next = this.questionBridge.queue.shift();
		if (!next) return;
		this.transport.notify("question.pending", {
			id: next.qid,
			questions: next.questions,
			deadline: next.deadline,
		});
		this.questionBridge.pending = { qid: next.qid, resolve: next.resolve, reject: next.reject };
	}

	/** ctx.userQuestions provider：把问题桥到客户端并等待答案。
	 *  P2-20：并发 ask() 排队（深度 3），当前提问回答后自动发下一个。 */
	async askUser(request) {
		const questions = (request?.questions ?? []).map((q) => ({
			id: q.id,
			question: q.question,
			...(q.detail ? { detail: q.detail } : {}),
			...(q.header ? { header: q.header } : {}),
			...(q.options ? { options: q.options } : {}),
			...(q.multiSelect ? { multiSelect: q.multiSelect } : {}),
		}));
		if (questions.length === 0) throw new Error("ask_user_question requires at least one question");
		const qid = `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		const deadline = Date.now() + QUESTION_TIMEOUT_MS;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const queued = this.questionBridge.queue.findIndex((q) => q.qid === qid);
				if (queued >= 0) this.questionBridge.queue.splice(queued, 1);
				if (this.questionBridge.pending?.qid === qid) {
					this.questionBridge.pending = null;
					reject(new Error("提问超时（等待回答过久）"));
				}
			}, QUESTION_TIMEOUT_MS);
			timer.unref?.();
			const entry = {
				qid,
				questions,
				deadline,
				resolve: (answers) => {
					clearTimeout(timer);
					resolve(answers);
				},
				reject: (err) => {
					clearTimeout(timer);
					reject(err);
				},
			};
			if (this.questionBridge.pending || this.questionBridge.queue.length > 0) {
				// 已有提问在展示 → 排队；深度 3，满则拒绝（模型会收到工具报错继续）。
				if (this.questionBridge.queue.length >= 3) {
					clearTimeout(timer);
					reject(new Error("提问排队已满（最多 3 个），请先回答当前提问"));
					return;
				}
				this.questionBridge.queue.push(entry);
			} else {
				// 无 pending → 立即发通知并等待。
				this.transport.notify("question.pending", { id: qid, questions, deadline });
				this.questionBridge.pending = { qid, resolve: entry.resolve, reject: entry.reject };
			}
		});
	}

	/** question/answer RPC：前端提交答案（或取消）。回答后自动发队列里的下一个。 */
	async answerQuestion(params) {
		const pending = this.questionBridge.pending;
		if (!pending || pending.qid !== params?.id) {
			throw new Error(`question/answer 不匹配（id=${params?.id}）`);
		}
		this.questionBridge.pending = null;
		if (params?.cancelled) {
			pending.reject(new Error("用户取消了提问"));
		} else {
			const answers = Array.isArray(params?.answers) ? params.answers : [];
			pending.resolve({ answers });
		}
		this.dispatchNextQuestion();
		return { ok: true };
	}

	// -----------------------------------------------------------------------
	// 附件 RPC（视觉桥）：base64 图片 → durable ref；ref → base64 回读。
	// 模型请求侧的 image 块由 dsh-llm-deepseek adapter 自动解析 ref（file-id/inline）。
	// -----------------------------------------------------------------------

	/** 保存一张 base64 图片到附件存储（ctx.attachments，dsh-attachment-local 后端）。 */
	async attachmentSave(params) {
		const mediaType = params?.mediaType;
		if (typeof mediaType !== "string" || !/^image\/(png|jpeg|webp|gif)$/u.test(mediaType)) {
			throw new TypeError("attachment/save requires mediaType (image/png|jpeg|webp|gif)");
		}
		if (typeof params?.data !== "string" || !params.data) {
			throw new TypeError("attachment/save requires base64 data");
		}
		const bytes = new Uint8Array(Buffer.from(params.data, "base64"));
		if (bytes.length === 0) throw new TypeError("attachment/save: empty image data");
		const ref = await this.ctx.attachments.saveImage({
			data: bytes,
			mediaType,
			...(typeof params?.name === "string" && params.name ? { name: params.name } : {}),
		});
		return { ref };
	}

	/** 按 ref 回读规范化后的图片字节（base64），供前端回放显示。 */
	async attachmentRead(params) {
		const ref = params?.ref;
		if (!ref || typeof ref?.attachmentId !== "string" || typeof ref?.mediaType !== "string") {
			throw new TypeError("attachment/read requires ref (attachmentId + mediaType)");
		}
		const stored = await this.ctx.attachments.readImage(ref);
		return {
			mediaType: stored.ref?.mediaType ?? ref.mediaType,
			data: Buffer.from(stored.data).toString("base64"),
		};
	}
}

/**
 * 插件 apply：transport 接线 / shutdown 语义与官方一致，server 换成本地扩展类。
 * 保持 named exports（无 default），Loader unwrapExports 需要 name/inject/Config/apply。
 */
function apply(ctx, config) {
	const resolvedConfig = config;
	const rootFiber = ctx.root.fiber;
	/* v8 ignore next -- production stdio wiring */
	const input = config.input ?? process.stdin;
	/* v8 ignore next -- production stdio wiring */
	const output = config.output ?? process.stdout;
	/* v8 ignore next -- production exit wiring */
	const exit = config.exit ?? ((code) => {
		process.exit(code);
	});
	const transport = new JsonRpcLineTransport(input, output);
	const server = new DshGoalJsonRpcServer(ctx, transport, {
		maxTokensAsSuccess: resolvedConfig.maxTokensAsSuccess,
	});
	// 注册用户提问 provider：模型 ask_user_question → 浏览器对话框 → 答案回传。
	// 单个 context 只允许一个 provider；dispose 时随 ctx.effect 清理。
	const unregisterQuestions = ctx.userQuestions.registerProvider({
		ask: (request) => server.askUser(request),
	});
	ctx.effect(() => unregisterQuestions, "user-questions.bridge");
	let exitTask;
	const disposeAndExit = () => {
		exitTask ??= (async () => {
			await Promise.allSettled([Promise.resolve().then(() => transport.flush())]);
			await Promise.allSettled([Promise.resolve().then(() => rootFiber.dispose())]);
			exit(0);
		})();
		return exitTask;
	};
	transport.onRequest(async (method, params) => {
		if (method === "initialize") await ctx.get("loader")?.await();
		const result = await server.handleRequest(method, params);
		if (method === "shutdown") setImmediate(() => {
			disposeAndExit();
		});
		return result;
	});
	ctx.effect(() => {
		transport.start();
		return async () => {
			await server.shutdown();
			transport.close();
		};
	}, "jsonrpc.serve");
}

const name = "sdk-jsonrpc-server";
const inject = ["agents", "goals", "attachments", "userQuestions"];

export { Config, apply, inject, name };
