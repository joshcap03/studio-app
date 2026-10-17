import type { SupabaseClient } from "@supabase/supabase-js";

/** A Supabase client acting as one signed-in user, so Row Level Security applies. */
export type Db = SupabaseClient;
