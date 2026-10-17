// Shared by the task and record modules: turns database errors into user-safe ones.

interface DbError {
  message: string;
  code?: string;
  hint?: string;
}

export function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

/**
 * Unwraps a query result. A foreign-key failure means an id named something the member
 * can't reach (another member's conversation, another workspace's skill): it reads as missing.
 */
export function check<T>(result: { data: T; error: DbError | null }, missing = "That item doesn't exist."): T {
  const { error } = result;
  if (!error) return result.data;
  if (error.code === "23503") fail(400, missing);
  if (error.code === "23514") fail(400, "That doesn't fit the allowed limits.");
  throw Object.assign(new Error(error.message), { code: error.code });
}

export const time = (value: string | null): number | null => (value ? Date.parse(value) : null);
