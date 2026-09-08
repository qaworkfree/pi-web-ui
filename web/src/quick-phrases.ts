/**
 * 快捷短语内置默认值（按界面语言，与 i18n Locale 对齐；ja/ko/fr/de/es/ru/pt 为机器翻译占位）。
 *
 * 服务端对新客户端只给空列表（不知道浏览器语言），由 App 在首次看到空列表时
 * 按当前 locale seed 一次（见 App 的 seeding effect + isQuickSeeded）；seed 后
 * 即为普通用户数据，可在设置里增删改、恢复默认、关闭。约束与服务端归一化对齐：
 * 单条 ≤200 字、最多 30 条、无空项无重名。
 */
import type { Locale } from "./i18n";

export const QUICK_PHRASE_DEFAULTS: Record<Locale, string[]> = {
	zh: ["继续", "总结一下", "详细解释一下", "检查并修复问题", "补充测试覆盖", "发布上传"],
	en: ["Continue", "Summarize", "Explain in detail", "Check and fix issues", "Add test coverage", "Publish release"],
	it: [
		"Continua",
		"Riassumi",
		"Spiega in dettaglio",
		"Verifica e correggi i problemi",
		"Aggiungi copertura dei test",
		"Pubblica la release",
	],
	ja: ["続ける", "要約して", "詳しく説明して", "問題を確認して修正", "テストカバレッジを追加", "公開・リリース"],
	ko: ["계속", "요약해줘", "자세히 설명해줘", "문제를 확인하고 수정", "테스트 커버리지 추가", "게시/릴리스"],
	fr: [
		"Continuer",
		"Résumer",
		"Expliquer en détail",
		"Vérifier et corriger les problèmes",
		"Ajouter des tests",
		"Publier",
	],
	de: [
		"Weiter",
		"Zusammenfassen",
		"Ausführlich erklären",
		"Probleme prüfen und beheben",
		"Testabdeckung ergänzen",
		"Veröffentlichen",
	],
	es: [
		"Continuar",
		"Resumir",
		"Explicar en detalle",
		"Revisar y corregir problemas",
		"Añadir cobertura de pruebas",
		"Publicar",
	],
	ru: [
		"Продолжить",
		"Подведи итог",
		"Объясни подробно",
		"Проверь и исправь проблемы",
		"Добавь покрытие тестами",
		"Опубликовать",
	],
	pt: [
		"Continuar",
		"Resumir",
		"Explicar em detalhes",
		"Verificar e corrigir problemas",
		"Adicionar cobertura de testes",
		"Publicar",
	],
};

const SEED_KEY = "pi-web-ui:quick-seeded";
const SEED_CAP = 20;

/** localStorage 里记的已 seed 客户端 id（JSON 数组；坏数据 → []）。 */
export function parseSeeded(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const v: unknown = JSON.parse(raw);
		return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

/** 记录一个已 seed 的客户端（去重 + 截尾封顶，防长期膨胀）。纯函数，可单测。 */
export function addSeeded(list: string[], clientId: string, cap = SEED_CAP): string[] {
	return [...list.filter((id) => id !== clientId), clientId].slice(-cap);
}

export function isQuickSeeded(clientId: string): boolean {
	try {
		return parseSeeded(localStorage.getItem(SEED_KEY)).includes(clientId);
	} catch {
		// 隐私模式等 storage 不可用：本次会话内靠调用方的 ref 去重。
		return false;
	}
}

export function markQuickSeeded(clientId: string): void {
	try {
		localStorage.setItem(SEED_KEY, JSON.stringify(addSeeded(parseSeeded(localStorage.getItem(SEED_KEY)), clientId)));
	} catch {
		// best effort
	}
}
