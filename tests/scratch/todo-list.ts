/**
 * 纯逻辑的 Todo List 模块 —— 不依赖 React/DOM，便于单元测试。
 *
 * 设计原则：
 * - 所有操作都是纯函数：返回新数组/新对象，不修改入参。
 * - 状态统一用 `Todo[]`，过滤通过 `Filter` 联合类型表达。
 */

export type Todo = {
  id: string;
  title: string;
  completed: boolean;
  createdAt: number;
};

export type Filter = 'all' | 'active' | 'completed';

/** 生成简单唯一 id（测试友好，可读）。 */
export function createId(prefix = 'todo'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 新增一条 todo，追加到列表末尾。 */
export function addTodo(todos: Todo[], title: string, now = Date.now()): Todo[] {
  const trimmed = title.trim();
  if (!trimmed) {
    throw new Error('Todo title must not be empty');
  }
  const todo: Todo = {
    id: createId(),
    title: trimmed,
    completed: false,
    createdAt: now,
  };
  return [...todos, todo];
}

/** 切换指定 todo 的完成状态；id 不存在时返回原列表。 */
export function toggleTodo(todos: Todo[], id: string): Todo[] {
  return todos.map((todo) =>
    todo.id === id ? { ...todo, completed: !todo.completed } : todo,
  );
}

/** 删除指定 todo；id 不存在时返回原列表。 */
export function removeTodo(todos: Todo[], id: string): Todo[] {
  return todos.filter((todo) => todo.id !== id);
}

/** 按过滤器筛选。 */
export function filterTodos(todos: Todo[], filter: Filter): Todo[] {
  switch (filter) {
    case 'active':
      return todos.filter((todo) => !todo.completed);
    case 'completed':
      return todos.filter((todo) => todo.completed);
    case 'all':
      return todos;
  }
}

/** 清空所有已完成项。 */
export function clearCompleted(todos: Todo[]): Todo[] {
  return todos.filter((todo) => !todo.completed);
}

/** 剩余未完成数量。 */
export function remainingCount(todos: Todo[]): number {
  return todos.filter((todo) => !todo.completed).length;
}
