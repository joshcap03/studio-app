import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getConfig } from "@/lib/config";
import type { Db } from "./db";

// Supabase clients always act as the signed-in user (anon key + the user's session cookie),
// so Row Level Security applies to every query the app makes. There is deliberately no
// service-role client anywhere in the request path.

export type { Db };

export async function createSupabaseServerClient(): Promise<Db> {
  const { supabase } = getConfig();
  const store = await cookies();
  return createServerClient(supabase.url, supabase.anonKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // Server components can't set cookies; the proxy refreshes sessions instead.
        }
      },
    },
  });
}
