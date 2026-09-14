const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSupabaseClient } = require('../../lib/supabaseClient');

test('returns supabaseConfigured=false when env vars are missing', () => {
  const result = buildSupabaseClient({});
  assert.equal(result.supabaseConfigured, false);
  assert.equal(result.supabase, null);
});

test('returns supabaseConfigured=false when only one var is set', () => {
  const result = buildSupabaseClient({ SUPABASE_URL: 'https://x.supabase.co' });
  assert.equal(result.supabaseConfigured, false);
  assert.equal(result.supabase, null);
});

test('returns a configured client when both vars are set', () => {
  const result = buildSupabaseClient({
    SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role-key'
  });
  assert.equal(result.supabaseConfigured, true);
  assert.ok(result.supabase);
  assert.equal(typeof result.supabase.from, 'function');
});
