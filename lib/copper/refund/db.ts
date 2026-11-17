// The connection to the refund database (Supabase). It uses the server-only
// secret key, so only server code can read or change these tables: the tables
// have row-level security on and no policies, so the public key can do nothing.
// store.ts is the only file that calls this.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export class StoreUnavailableError extends Error {
  constructor() {
    super(
      "The order system isn't set up: add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env.local.",
    );
    this.name = "StoreUnavailableError";
  }
}

/** The database client, or null when Supabase isn't set up. */
export function getDb(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return url && key
    ? createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;
}

export function isStoreConfigured(): boolean {
  return Boolean(
    process.env.SUPABASE_URL?.trim() &&
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
  );
}
