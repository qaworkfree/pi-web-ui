/** Date-only Takkle values remain date-only: no UTC conversion shifts a day. */
export const dayKey = (day) =>
	`${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
export function monthDays(year, month) {
	const first = new Date(year, month, 1, 12);
	const offset = (first.getDay() + 6) % 7;
	return Array.from({ length: 42 }, (_, i) => new Date(year, month, 1 - offset + i, 12));
}
export function tasksOnDay(tasks, day) {
	return tasks.filter(
		(task) =>
			!task.archivedAt &&
			(task.startDate || task.dueDate) &&
			(task.startDate || task.dueDate) <= day &&
			(task.dueDate || task.startDate) >= day,
	);
}
