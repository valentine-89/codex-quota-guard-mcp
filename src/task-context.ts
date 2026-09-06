import { AsyncLocalStorage } from "node:async_hooks";
export interface TaskContext { taskId: string; clientId: string; desktop: boolean }
export const taskContext = new AsyncLocalStorage<TaskContext | undefined>();
