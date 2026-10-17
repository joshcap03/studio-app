import { createStore, type Store } from "@/lib/db/store";
import type { Tenant } from "@/lib/tenant-core";

/** The conversation store for the caller's active workspace. */
export function storeFor(tenant: Tenant): Store {
  return createStore(tenant.db, { workspaceId: tenant.workspace.id, userId: tenant.userId });
}
