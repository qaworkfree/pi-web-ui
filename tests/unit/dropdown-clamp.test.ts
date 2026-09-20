import { describe, expect, it } from "vitest";
import { computeDropdownShift } from "../../web/src/components/Dropdown";

describe("computeDropdownShift (Issue #252)", () => {
	it("在视口内正常容纳时无需平移 (shift === 0)", () => {
		// 宽屏 1920，触发器在 (500, 600)，菜单宽 450，align=left
		const shiftLeft = computeDropdownShift({
			align: "left",
			triggerLeft: 500,
			triggerRight: 600,
			menuWidth: 450,
			viewportWidth: 1920,
		});
		expect(shiftLeft).toBe(0);

		// 宽屏 1920，触发器在 (1500, 1600)，菜单宽 450，align=right
		const shiftRight = computeDropdownShift({
			align: "right",
			triggerLeft: 1500,
			triggerRight: 1600,
			menuWidth: 450,
			viewportWidth: 1920,
		});
		expect(shiftRight).toBe(0);
	});

	it("向左溢出时（Issue #252 经典复现场景：中窄屏/靠左触发器 + align=right），向右平移钳制在 margin 内", () => {
		// 视口 900px，触发器在输入框左下角 (100, 220)，菜单宽 550px，align=right
		// 自然位置：naturalLeft = 220 - 550 = -330px（超出左边界 330px！）
		// 期望：向右平移到 margin(8px)，shift = 8 - (-330) = +338px
		const shift = computeDropdownShift({
			align: "right",
			triggerLeft: 100,
			triggerRight: 220,
			menuWidth: 550,
			viewportWidth: 900,
			margin: 8,
		});
		expect(shift).toBe(338);
		// 平移后的最终位置：-330 + 338 = 8px
		expect(220 - 550 + shift).toBe(8);
	});

	it("align=left 且触发器靠左但依然溢出左边界时，向右平移到 margin", () => {
		// 触发器由于极窄或负偏移在 (-50, 50)，菜单宽 400，align=left
		const shift = computeDropdownShift({
			align: "left",
			triggerLeft: -50,
			triggerRight: 50,
			menuWidth: 400,
			viewportWidth: 800,
			margin: 8,
		});
		expect(shift).toBe(58);
		expect(-50 + shift).toBe(8);
	});

	it("向右溢出时，向左平移钳制在视口右边缘内", () => {
		// 视口 800px，触发器在 (500, 600)，菜单宽 400px，align=left
		// 自然位置：naturalLeft = 500px，naturalRight = 900px（超出右侧 100px）
		// maxLeft = 800 - 8 - 400 = 392px
		// 期望：shift = 392 - 500 = -108px
		const shift = computeDropdownShift({
			align: "left",
			triggerLeft: 500,
			triggerRight: 600,
			menuWidth: 400,
			viewportWidth: 800,
			margin: 8,
		});
		expect(shift).toBe(-108);
		// 平移后的最终位置：500 - 108 = 392px，右边缘 = 392 + 400 = 792px (800 - 8)
		expect(500 + shift + 400).toBe(800 - 8);
	});

	it("菜单宽度大于视口可用宽度时，优先保证左侧在视野内 (left === margin)", () => {
		// 视口 500px，菜单宽 600px，margin 8
		const shift = computeDropdownShift({
			align: "left",
			triggerLeft: 100,
			triggerRight: 200,
			menuWidth: 600,
			viewportWidth: 500,
			margin: 8,
		});
		// naturalLeft = 100，期望移到 margin(8)，shift = -92
		expect(shift).toBe(-92);
		expect(100 + shift).toBe(8);
	});

	it("非正常尺寸（menuWidth <= 0 或 viewportWidth <= 0）时不产生平移", () => {
		expect(
			computeDropdownShift({
				align: "left",
				triggerLeft: 100,
				triggerRight: 200,
				menuWidth: 0,
				viewportWidth: 800,
			}),
		).toBe(0);

		expect(
			computeDropdownShift({
				align: "left",
				triggerLeft: 100,
				triggerRight: 200,
				menuWidth: 400,
				viewportWidth: 0,
			}),
		).toBe(0);
	});
});
