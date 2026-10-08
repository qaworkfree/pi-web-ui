/** Isolated PDF renderer/OCR/Office reader. Only local file bytes are processed. */
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { createRequire } from "node:module";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createWorker, PSM, type Worker } from "tesseract.js";
import { unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";
import type { DocumentPage, DocumentResult } from "./document-reader.js";

// PDF.js diagnostics must not corrupt the JSON protocol on stdout.
console.log = (...args: unknown[]): void => {
	console.error(...args);
};
const [path, startRaw, endRaw, mode, cache] = process.argv.slice(2);
let ocrWorker: Worker | undefined;
async function getOcr(prepare = false): Promise<Worker> {
	await mkdir(cache, { recursive: true });
	if (!prepare && (!existsSync(join(cache, "eng.traineddata")) || !existsSync(join(cache, "por.traineddata"))))
		throw new Error("OCR language files are missing. Run the launcher to prepare English and Portuguese OCR.");
	ocrWorker ??= await createWorker(["eng", "por"], 1, {
		cachePath: cache,
		...(prepare ? {} : { langPath: cache, gzip: false, cacheMethod: "readOnly" as const }),
	});
	await ocrWorker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: "1" });
	return ocrWorker;
}
async function recognize(image: Buffer): Promise<{ text: string; confidence: number }> {
	const { data } = await (await getOcr()).recognize(image);
	return { text: data.text.trim(), confidence: data.confidence };
}

async function pdf(bytes: Buffer, start: number, end: number): Promise<DocumentResult> {
	const pdfRoot = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
	const loading = getDocument({
		data: new Uint8Array(bytes),
		useSystemFonts: true,
		cMapUrl: join(pdfRoot, "cmaps") + "/",
		cMapPacked: true,
		standardFontDataUrl: join(pdfRoot, "standard_fonts") + "/",
	});
	const document = await loading.promise;
	try {
		if (start > document.numPages) throw new Error(`Page ${start} does not exist; PDF has ${document.numPages} pages.`);
		const pages: DocumentPage[] = [];
		for (let number = start; number <= Math.min(end, document.numPages); number++) {
			const page = await document.getPage(number);
			const content = await page.getTextContent();
			const text = content.items
				.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
				.join("")
				.trim();
			// A scanned page can have a selectable footer/header; inspect image operators too.
			const operators = await page.getOperatorList();
			const hasImages = operators.fnArray.some((op) =>
				[
					OPS.paintImageXObject,
					OPS.paintInlineImageXObject,
					OPS.paintImageMaskXObject,
					OPS.paintImageXObjectRepeat,
				].includes(op),
			);
			if (mode === "force" || !text || (hasImages && text.replace(/\s/g, "").length < 300)) {
				const natural = page.getViewport({ scale: 1 });
				const scale = Math.min(2.5, Math.sqrt(12_000_000 / (natural.width * natural.height)));
				const viewport = page.getViewport({ scale });
				const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
				{
					await page.render({
						canvas: null,
						canvasContext: canvas.getContext("2d") as unknown as Parameters<typeof page.render>[0]["canvasContext"],
						viewport,
					}).promise;
					const recognized = await recognize(canvas.toBuffer("image/png"));
					pages.push({ page: number, method: "ocr", text: recognized.text || text, confidence: recognized.confidence });
				}
			} else pages.push({ page: number, method: "text", text });
			page.cleanup();
		}
		return { format: "PDF", totalPages: document.numPages, pages };
	} finally {
		await loading.destroy();
	}
}

/** Office XML is data: do not run macros, formulas, external links or embedded scripts. */
function office(bytes: Buffer, start: number, end: number): DocumentResult {
	let expanded = 0;
	const entries = unzipSync(bytes, {
		filter: (entry) => {
			if (!entry.name.endsWith(".xml")) return false;
			expanded += entry.originalSize;
			if (entry.originalSize > 16_000_000 || expanded > 64_000_000)
				throw new Error("Office document expansion limit exceeded.");
			return true;
		},
	});
	const decode = (name: string): string => {
		const xml = new TextDecoder().decode(entries[name] ?? new Uint8Array());
		if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Office XML entities are unsupported.");
		return xml;
	};
	const textNodes = (xml: string, tag: string): string => {
		// Preserve source order even when tables and paragraphs are interleaved.
		const parsed: unknown = new XMLParser({ preserveOrder: true, ignoreAttributes: false, parseTagValue: false }).parse(
			xml,
		);
		const collected: string[] = [];
		const walk = (value: unknown): void => {
			if (Array.isArray(value)) {
				value.forEach(walk);
				return;
			}
			if (!value || typeof value !== "object") return;
			for (const [key, item] of Object.entries(value)) {
				if (key === tag) {
					for (const part of Array.isArray(item) ? item : [item])
						collected.push(
							String(
								typeof part === "object" && part !== null ? ((part as Record<string, unknown>)["#text"] ?? "") : part,
							),
						);
				} else walk(item);
			}
		};
		walk(parsed);
		return collected.join("\n");
	};
	let texts: string[];
	let format: string;
	if (entries["word/document.xml"]) {
		format = "DOCX (text chunks)";
		const text = textNodes(decode("word/document.xml"), "w:t");
		texts = text.match(/[\s\S]{1,12000}/g) ?? [""];
	} else if (entries["ppt/presentation.xml"]) {
		format = "PPTX (slides)";
		texts = Object.keys(entries)
			.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
			.sort((a, b) => Number(a.match(/(\d+)\.xml$/)?.[1]) - Number(b.match(/(\d+)\.xml$/)?.[1]))
			.map((name) => textNodes(decode(name), "a:t"));
	} else if (Object.keys(entries).some((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))) {
		format = "XLSX (sheets; cached formula values only)";
		const shared = [...decode("xl/sharedStrings.xml").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((item) =>
			textNodes(item[1], "t").replace(/\n/g, ""),
		);
		texts = Object.keys(entries)
			.filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
			.sort((a, b) => Number(a.match(/(\d+)\.xml$/)?.[1]) - Number(b.match(/(\d+)\.xml$/)?.[1]))
			.map((name) => {
				const xml = decode(name);
				return [...xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)]
					.map((match) => {
						const address = /\br="([^"]+)"/.exec(match[1])?.[1] ?? "cell";
						const value = /<v>([^<]*)<\/v>/.exec(match[2])?.[1] ?? textNodes(match[2], "t");
						return `${address}: ${/\bt="s"/.test(match[1]) ? (shared[Number(value)] ?? value) : value}`;
					})
					.join("\n");
			});
	} else throw new Error("ZIP file is not a supported DOCX, PPTX or XLSX document.");
	if (!texts.length || start > texts.length) throw new Error("No readable content in the requested document range.");
	return {
		format,
		totalPages: texts.length,
		pages: texts.slice(start - 1, end).map((text, i) => ({ page: start + i, text, method: "text" })),
	};
}
try {
	if (path === "--prepare") {
		await getOcr(true);
		process.stdout.write(JSON.stringify({ ready: true, languages: ["eng", "por"] }));
	} else {
		const bytes = await readFile(path);
		const extension = extname(path).toLowerCase();
		let result: DocumentResult;
		if (bytes.subarray(0, 5).toString() === "%PDF-") result = await pdf(bytes, Number(startRaw), Number(endRaw));
		else if (
			[".docx", ".xlsx", ".pptx"].includes(extension) ||
			bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4]))
		)
			result = office(bytes, Number(startRaw), Number(endRaw));
		else {
			const image = await loadImage(bytes);
			const scale = Math.min(2, Math.sqrt(12_000_000 / (image.width * image.height)));
			const canvas = createCanvas(
				Math.max(1, Math.floor(image.width * scale)),
				Math.max(1, Math.floor(image.height * scale)),
			);
			canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
			result = {
				format: "Image OCR",
				totalPages: 1,
				pages: [{ page: 1, method: "ocr", ...(await recognize(canvas.toBuffer("image/png"))) }],
			};
		}
		process.stdout.write(JSON.stringify(result));
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
} finally {
	await ocrWorker?.terminate();
}
