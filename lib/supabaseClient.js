const { createClient } = require('@supabase/supabase-js');

function buildSupabaseClient(env = process.env) {
  const url = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    return { supabase: null, supabaseConfigured: false };
  }

  const supabase = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  return { supabase, supabaseConfigured: true };
}

module.exports = { buildSupabaseClient };
