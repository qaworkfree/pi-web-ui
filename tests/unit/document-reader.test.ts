import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, loadImage, PDFDocument, type SKRSContext2D } from "@napi-rs/canvas";
import { zipSync, strToU8 } from "fflate";
import { readDocument, documentPageRange, formatDocument } from "../../server/document-reader.js";
import { makeReadDirTool, withReadDirSupport } from "../../server/read-tool.js";
import { buildAttachmentMessages, type AttachmentContext } from "../../server/attachments.js";

const dirs: string[] = [];
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "document-test-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function textPdf(texts: string[]): Buffer {
	const pdf = new PDFDocument();
	for (const text of texts) {
		const page = pdf.beginPage(600, 800);
		page.font = "22px Arial";
		page.fillText(text, 35, 100);
		pdf.endPage();
	}
	return pdf.close();
}
async function scannedPdf(): Promise<Buffer> {
	const image = createCanvas(1200, 700);
	const ctx = image.getContext("2d");
	ctx.fillStyle = "white";
	ctx.fillRect(0, 0, 1200, 700);
	ctx.fillStyle = "black";
	ctx.font = "42px Arial";
	ctx.fillText("Invoice total: 742 dollars", 60, 130);
	ctx.fillText("Relatorio de vendas: outubro", 60, 220);
	const pdf = new PDFDocument();
	const page = pdf.beginPage(600, 350) as SKRSContext2D;
	page.drawImage(await loadImage(image.toBuffer("image/png")), 0, 0, 600, 350);
	pdf.endPage();
	return pdf.close();
}
function attachmentContext(cwd: string): AttachmentContext {
	return {
		cwd,
		clientId: "document-reader-test",
		emit: () => {},
		settings: {} as AttachmentContext["settings"],
		session: { model: { input: ["text"], contextWindow: 4096 } } as AttachmentContext["session"],
	};
}
async function toolRead(tool: ReturnType<typeof makeReadDirTool>, params: Record<string, unknown>, cwd: string) {
	return tool.execute("read-doc", params as never, undefined, undefined, { cwd } as never);
}

describe("local document tools", () => {
	it("recognizes legacy extensionless uploads on previews and every continued read", async () => {
		const cwd = temp();
		const path = join(cwd, "legacy-upload-without-suffix");
		writeFileSync(path, textPdf(["Legacy first page 742", "Legacy second page 915"]));
		const tool = makeReadDirTool(cwd);
		const result = await toolRead(tool, { path, pages: "2", text_offset: 0 }, cwd);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("915") });
		expect(result.content[0]).toMatchObject({ text: expect.not.stringContaining("%PDF-") });
		const aside = await buildAttachmentMessages(attachmentContext(cwd), [{ path }]);
		expect(aside[0].message.content).toEqual([{ type: "text", text: expect.stringContaining("742") }]);
		const office = join(cwd, "legacy-office");
		writeFileSync(office, zipSync({ "word/document.xml": strToU8("<w:document><w:t>Office 812</w:t></w:document>") }));
		expect((await toolRead(tool, { path: office }, cwd)).content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("812"),
		});
	}, 20000);
	it("reads real digital PDFs with page numbers and arbitrary later pages", async () => {
		const path = join(temp(), "digital.pdf");
		writeFileSync(path, textPdf(["First page: 742", "Second page: 915", "Third page: 381"]));
		const result = await readDocument(path, { pages: "2-3" });
		expect(result.totalPages).toBe(3);
		expect(result.pages.map((p) => p.page)).toEqual([2, 3]);
		expect(result.pages[0].text).toContain("915");
		expect(result.pages[0].method).toBe("text");
		expect(formatDocument(result)).toContain("Page 3");
	}, 20000);
	it("rejects invalid ranges and nonexistent pages", async () => {
		for (const range of ["0", "2-1", "1-11", "1,3", "1-999999999999999999999"])
			expect(() => documentPageRange(range)).toThrow();
		expect(documentPageRange("4-6")).toEqual([4, 6]);
		const path = join(temp(), "small.pdf");
		writeFileSync(path, textPdf(["One page"]));
		await expect(readDocument(path, { pages: "2" })).rejects.toThrow(/does not exist/);
	});
	it("reports corrupt PDFs without sending binary garbage to the model", async () => {
		const path = join(temp(), "bad.pdf");
		writeFileSync(path, "%PDF-1.7 broken");
		await expect(readDocument(path)).rejects.toThrow();
	});
	it("cancels before starting extraction", async () => {
		const path = join(temp(), "cancel.pdf");
		writeFileSync(path, textPdf(["cancel"]));
		const controller = new AbortController();
		controller.abort();
		await expect(readDocument(path, { signal: controller.signal })).rejects.toThrow(/cancelled/);
	});
	it("read exposes PDF extraction and lossless continuation for small model contexts", async () => {
		const cwd = temp();
		writeFileSync(
			join(cwd, "long.docx"),
			zipSync({
				"word/document.xml": strToU8(
					`<w:document><w:p><w:r><w:t>UniquePrefix ${"token ".repeat(500)} UniqueSuffix</w:t></w:r></w:p></w:document>`,
				),
			}),
		);
		const tool = makeReadDirTool(cwd, { documentMaxChars: () => 1000 });
		const first = await toolRead(tool, { path: "long.docx", pages: "1" }, cwd);
		const details = first.details as { nextTextOffset: number };
		expect(details.nextTextOffset).toBe(1000);
		let combined = first.content.map((c) => (c.type === "text" ? c.text.split("\n[More text")[0] : "")).join("");
		let next: number | undefined = details.nextTextOffset;
		while (next !== undefined) {
			const response = await toolRead(tool, { path: "long.docx", pages: "1", text_offset: next }, cwd);
			combined += response.content.map((c) => (c.type === "text" ? c.text.split("\n[More text")[0] : "")).join("");
			next = (response.details as { nextTextOffset?: number }).nextTextOffset;
		}
		const full = formatDocument(await readDocument(join(cwd, "long.docx"), { pages: "1" }), 1_500_000);
		expect(combined).toContain("UniqueSuffix");
		expect(combined).toBe(full);
	}, 30000);
	it("preserves third-party read fields while adding document paging", async () => {
		const cwd = temp();
		writeFileSync(join(cwd, "doc.pdf"), textPdf(["Extension PDF 427"]));
		const base = makeReadDirTool(cwd);
		const wrapped = withReadDirSupport(base, cwd);
		expect(wrapped.parameters.properties).toHaveProperty("pages");
		const result = await toolRead(wrapped as ReturnType<typeof makeReadDirTool>, { path: "doc.pdf", pages: "1" }, cwd);
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("427") });
	});
	it("uploaded and restored PDFs deliver readable previews to a text-only 80B model", async () => {
		const data = temp();
		vi.stubEnv("PI_WEB_DATA_DIR", data);
		const ctx = attachmentContext(temp());
		const original = await buildAttachmentMessages(ctx, [
			{
				path: "",
				name: "statement-" + "x".repeat(180) + ".pdf",
				fileData: textPdf(["Invoice total: 742 dollars"]).toString("base64"),
			},
		]);
		expect(original[0].message.content).toEqual([{ type: "text", text: expect.stringContaining("742") }]);
		const details = original[0].message.details as { path: string; upload: boolean };
		expect(details.upload).toBe(true);
		expect(details.path.endsWith(".pdf")).toBe(true);
		const restored = await buildAttachmentMessages(ctx, [{ path: "", name: "invoice.pdf", uploadPath: details.path }]);
		expect(restored[0].message.content).toEqual(original[0].message.content);
	}, 20000);
	it("Office documents yield text/cells rather than ZIP bytes", async () => {
		const cwd = temp();
		const cases = [
			{
				name: "doc.docx",
				entries: {
					"word/document.xml": "<w:document><w:p><w:r><w:t>Body &amp; notes 812</w:t></w:r></w:p></w:document>",
				},
				value: "Body & notes 812",
			},
			{
				name: "slides.pptx",
				entries: {
					"ppt/presentation.xml": "<presentation/>",
					"ppt/slides/slide1.xml": "<p:sld><a:t>Slide 729</a:t></p:sld>",
				},
				value: "Slide 729",
			},
			{
				name: "book.xlsx",
				entries: {
					"xl/sharedStrings.xml": "<sst><si><t>Revenue</t></si></sst>",
					"xl/worksheets/sheet1.xml": '<worksheet><c r="A1" t="s"><v>0</v></c><c r="B1"><v>452</v></c></worksheet>',
				},
				value: "B1: 452",
			},
		];
		for (const example of cases) {
			const entries: Record<string, Uint8Array> = {};
			for (const [name, xml] of Object.entries(example.entries)) entries[name] = strToU8(xml!);
			const path = join(cwd, example.name);
			writeFileSync(path, zipSync(entries));
			expect(formatDocument(await readDocument(path))).toContain(example.value);
		}
	}, 20000);
	// The launcher primes language files; CI can opt into real, offline OCR with this env.
	it.skipIf(!process.env.PI_WEB_TEST_OCR_CACHE)(
		"OCR reads scanned PDFs and screenshots offline",
		async () => {
			vi.stubEnv("PI_WEB_OCR_CACHE", process.env.PI_WEB_TEST_OCR_CACHE!);
			const cwd = temp();
			const path = join(cwd, "scan.pdf");
			writeFileSync(path, await scannedPdf());
			const result = await readDocument(path, { pages: "1" });
			expect(result.pages[0].method).toBe("ocr");
			expect(result.pages[0].text).toContain("742");
			expect(result.pages[0].text.toLowerCase()).toContain("outubro");
			const forced = await readDocument(path, { pages: "1", ocr: "force" });
			const continued = await readDocument(path, { pages: "1", continuation: true });
			expect(continued).toEqual(forced);
			const digital = join(cwd, "digital-without-extension");
			writeFileSync(digital, textPdf(["Digital invoice total 742 dollars"]));
			expect((await readDocument(digital, { pages: "1" })).pages[0].method).toBe("text");
			const digitalForced = await readDocument(digital, { pages: "1", ocr: "force" });
			expect(digitalForced.pages[0].method).toBe("ocr");
			expect(await readDocument(digital, { pages: "1", continuation: true })).toEqual(digitalForced);
			const firstReader = makeReadDirTool(cwd);
			const otherReader = makeReadDirTool(cwd);
			await toolRead(firstReader, { path: digital, pages: "1", ocr: "force" }, cwd);
			await toolRead(otherReader, { path: digital, pages: "1", ocr: "auto" }, cwd);
			expect(
				(await toolRead(firstReader, { path: digital, pages: "1", text_offset: 0 }, cwd)).content[0],
			).toMatchObject({ text: expect.stringContaining("; OCR") });
			const ctx = attachmentContext(cwd);
			const attachment = await buildAttachmentMessages(ctx, [{ path: "scan.pdf" }]);
			expect(attachment[0].message.content).toEqual([{ type: "text", text: expect.stringContaining("742") }]);
			const image = createCanvas(1000, 300);
			const c = image.getContext("2d");
			c.fillStyle = "white";
			c.fillRect(0, 0, 1000, 300);
			c.fillStyle = "black";
			c.font = "48px Arial";
			c.fillText("Receipt total 193 dollars", 40, 130);
			const imagePath = join(cwd, "receipt.png");
			writeFileSync(imagePath, image.toBuffer("image/png"));
			const tool = makeReadDirTool(cwd, { textOnly: () => true });
			expect((await toolRead(tool, { path: "receipt.png" }, cwd)).content[0]).toMatchObject({
				type: "text",
				text: expect.stringContaining("193"),
			});
		},
		60000,
	);
});
