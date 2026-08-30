/**
 * Build the chained shell command for updating one or more npm packages in a
 * visible terminal tab. Multiple packages are joined with `;` so a failing
 * install never blocks the rest. Pure — unit-tested.
 */
export function buildUpdateCommand(names: string[]): string {
	return names.map((n) => `npm i -g ${n}@latest`).join("; ");
}
