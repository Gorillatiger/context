import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeOpenRouterUsage} from '../connectors/ai-usage.mjs';

const NOW = Date.parse('2026-10-14T12:34:56.789Z');
const base = {provider: 'openrouter', status: 'unknown', checkedAt: '2026-10-14T12:34:56.789Z'};
const normalize = data => normalizeOpenRouterUsage({data}, NOW);
const key = () => ({limit: 10, limit_remaining: 4.25, limit_reset: 'monthly'});
const budget = () => ({
  scope: 'member', limit_usd: 50, spend_usd: 32.5, remaining_usd: 17.5,
  reset_interval: 'weekly', resets_at: '2026-10-19T00:00:00.000Z',
});
const free = () => ({used: 12, limit: 50, remaining: 38});

test('complete quota metadata is allowlisted; secret fields, BYOK totals and deprecated rate limits never escape', () => {
  const privateText = 'synthetic-private-value';
  const result = normalize({
    ...key(), effective_budget: {...budget(), guardrail_id: privateText, budget_id: privateText, include_byok: true},
    usage: 25.5, usage_daily: 1.25, usage_weekly: 3.75, usage_monthly: 6.5,
    free_model_daily_requests: {...free(), label: privateText},
    label: privateText, hash: privateText, key: privateText, creator_user_id: privateText,
    organization_id: privateText, workspace_id: privateText, byok_usage: 999,
    budgets: [{scope: privateText}], rate_limit: {requests: 1000, interval: '1h', note: privateText},
  });
  assert.deepEqual(result, {
    ...base, status: 'available', keyBudget: {limit: 10, remaining: 4.25, resetInterval: 'monthly'},
    effectiveBudget: {scope: 'member', limit: 50, used: 32.5, remaining: 17.5, resetInterval: 'weekly', resetsAt: '2026-10-19T00:00:00.000Z'},
    spend: {total: 25.5, daily: 1.25, weekly: 3.75, monthly: 6.5},
    freeRequests: {used: 12, limit: 50, remaining: 38},
  });
  assert.ok(!JSON.stringify(result).includes(privateText));
});

test('zero caps and exhausted quotas are available; null/null identifies only an unset key cap', () => {
  assert.deepEqual(normalize({limit: 0, limit_remaining: 0, limit_reset: null}), {
    ...base, status: 'available', keyBudget: {limit: 0, remaining: 0, resetInterval: null},
  });
  assert.deepEqual(normalize({limit: null, limit_remaining: null}), {...base, status: 'available', keyLimitUnset: true});
  const result = normalize({limit: null, limit_remaining: null, effective_budget: {...budget(), remaining_usd: -2.5}});
  assert.equal(result.keyLimitUnset, true);
  assert.equal(result.effectiveBudget.remaining, -2.5);
  assert.ok(!Object.hasOwn(result, 'keyBudget'));
  assert.ok(!Object.hasOwn(result, 'balance'));
  assert.ok(!Object.hasOwn(result, 'unlimited'));
  assert.deepEqual(normalize({free_model_daily_requests: {used: 0, limit: 0, remaining: 0}}).freeRequests, {used: 0, limit: 0, remaining: 0});
});

test('missing, mixed-null or incomplete key fields do not imply an unlimited key or reconstruct a balance', () => {
  for (const data of [
    {}, {limit: null}, {limit_remaining: null}, {limit: null, limit_remaining: 0},
    {limit: 0, limit_remaining: null}, {limit: 10, limit_remaining: 4},
    {limit: 10, usage: 6}, {limit_remaining: 4, limit_reset: null},
  ]) {
    const result = normalize(data);
    assert.ok(!Object.hasOwn(result, 'keyBudget'));
    assert.ok(!Object.hasOwn(result, 'keyLimitUnset'));
    assert.equal(result.status, Object.hasOwn(data, 'usage') ? 'available' : 'unknown');
  }
});

test('negative dollar remainder is retained as exhaustion; dollar limits and spend cannot be negative', () => {
  const result = normalize({...key(), limit_remaining: -0.125, effective_budget: {...budget(), spend_usd: 51, remaining_usd: -1}});
  assert.equal(result.keyBudget.remaining, -0.125);
  assert.equal(result.effectiveBudget.used, 51);
  assert.equal(result.effectiveBudget.remaining, -1);
  assert.deepEqual(normalize({...key(), limit: -1}), base);
  assert.deepEqual(normalize({effective_budget: {...budget(), spend_usd: -0.01}}), base);
  assert.deepEqual(normalize({usage: -1, usage_daily: 0}), {...base, status: 'available', spend: {daily: 0}});
});

test('dollar values require finite numbers in bounded ranges, without coercion or clamping', () => {
  for (const invalid of [NaN, Infinity, -Infinity, '10', '', true, null, undefined, 1e12 + 1, -1e12 - 1, 10n, new Number(10)]) {
    assert.deepEqual(normalize({...key(), limit_remaining: invalid}), base);
    assert.deepEqual(normalize({usage: invalid}), base);
    assert.deepEqual(normalize({effective_budget: {...budget(), remaining_usd: invalid}}), base);
  }
  assert.deepEqual(normalize({limit: 1e12, limit_remaining: -1e12, limit_reset: null}).keyBudget,
    {limit: 1e12, remaining: -1e12, resetInterval: null});
  assert.deepEqual(normalize({usage: 1e12, usage_daily: 0.000001}).spend, {total: 1e12, daily: 0.000001});
});

test('each available spend window survives invalid neighbors and is not derived from other windows', () => {
  assert.deepEqual(normalize({usage_daily: 3, usage: '3', usage_weekly: null, usage_monthly: Infinity}),
    {...base, status: 'available', spend: {daily: 3}});
  assert.deepEqual(normalize({usage: 0}), {...base, status: 'available', spend: {total: 0}});
});

test('effective budgets require every field and a known scope and reset interval', () => {
  for (const missing of Object.keys(budget())) {
    const partial = budget(); delete partial[missing];
    assert.deepEqual(normalize({effective_budget: partial}), base, missing);
  }
  for (const scope of ['workspace_default_member', 'workspace_default_key', 'member', 'api_key', 'workspace', 'key_limit']) {
    assert.equal(normalize({effective_budget: {...budget(), scope}}).effectiveBudget.scope, scope);
  }
  for (const scope of ['organization', '__proto__', 'member-secret', null, 3]) {
    assert.deepEqual(normalize({effective_budget: {...budget(), scope}}), base);
  }
  for (const reset_interval of ['hourly', 'never', '', undefined, 0]) {
    assert.deepEqual(normalize({effective_budget: {...budget(), reset_interval}}), base);
    assert.deepEqual(normalize({...key(), limit_reset: reset_interval}), base);
  }
  for (const reset_interval of ['daily', 'weekly', 'monthly', null]) {
    assert.equal(normalize({effective_budget: {...budget(), reset_interval}}).effectiveBudget.resetInterval, reset_interval);
  }
});

test('reset instants retain null, normalize explicit offsets and reject calendar rollover or unzoned dates', () => {
  assert.equal(normalize({effective_budget: {...budget(), reset_interval: null, resets_at: null}}).effectiveBudget.resetsAt, null);
  assert.equal(normalize({effective_budget: {...budget(), resets_at: '2026-10-19T02:00:00+02:00'}}).effectiveBudget.resetsAt,
    '2026-10-19T00:00:00.000Z');
  assert.equal(normalize({effective_budget: {...budget(), resets_at: '2028-02-29T00:00:00.1Z'}}).effectiveBudget.resetsAt,
    '2028-02-29T00:00:00.100Z');
  for (const resets_at of [
    '2026-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-00-01T00:00:00Z',
    '2026-10-19T24:00:00Z', '2026-10-19T00:60:00Z', '2026-10-19T00:00:60Z',
    '2026-10-19T00:00:00+24:00', '2026-10-19T00:00:00+01:60',
    '2026-10-19', '2026-10-19T00:00:00', 'Monday', '2026-10-19T00:00:00Z\nsecret', 1, new Date(NOW),
  ]) assert.deepEqual(normalize({effective_budget: {...budget(), resets_at}}), base, String(resets_at));
});

test('free request counters require a complete bounded integer group, permit exhaustion and reject remaining above limit', () => {
  assert.deepEqual(normalize({free_model_daily_requests: {used: 51, limit: 50, remaining: 0}}).freeRequests,
    {used: 51, limit: 50, remaining: 0});
  assert.deepEqual(normalize({free_model_daily_requests: {used: 1e9, limit: 1e9, remaining: 1e9}}).freeRequests,
    {used: 1e9, limit: 1e9, remaining: 1e9});
  for (const field of ['used', 'limit', 'remaining']) {
    const partial = free(); delete partial[field];
    assert.deepEqual(normalize({free_model_daily_requests: partial}), base);
    for (const value of [-1, 0.5, 1e9 + 1, Number.MAX_SAFE_INTEGER, Infinity, NaN, '12', null, undefined]) {
      assert.deepEqual(normalize({free_model_daily_requests: {...free(), [field]: value}}), base);
    }
  }
  assert.deepEqual(normalize({free_model_daily_requests: {...free(), remaining: 51}}), base);
});

test('invalid payloads, nonplain records, errors and deprecated-only rate limits have unknown availability', () => {
  for (const payload of [undefined, null, [], {}, 'response', 10, new Date(), {error: {message: 'private'}},
    {data: null}, {data: []}, {data: 'response'}, {data: new Date()},
    {data: {rate_limit: {requests: 1000, interval: '1h'}, label: 'private', budgets: [budget()]}}]) {
    assert.deepEqual(normalizeOpenRouterUsage(payload, NOW), base);
  }
  class Metadata {constructor() {this.usage = 1;}}
  assert.deepEqual(normalize(new Metadata()), base);
});

test('only own data properties are consumed; getters and inherited metadata are never invoked', () => {
  let getterCalls = 0;
  const getter = {get() {getterCalls++; throw new Error('Getter must not execute');}};
  const root = {}; Object.defineProperty(root, 'data', getter);
  assert.deepEqual(normalizeOpenRouterUsage(root, NOW), base);
  const data = {...key()}; Object.defineProperty(data, 'limit_remaining', getter);
  Object.defineProperty(data, 'label', getter);
  assert.deepEqual(normalize(data), base);
  const partialBudget = budget(); Object.defineProperty(partialBudget, 'scope', getter);
  assert.deepEqual(normalize({effective_budget: partialBudget}), base);
  assert.deepEqual(normalizeOpenRouterUsage(Object.create({data: {usage: 1}}), NOW), base);
  assert.deepEqual(normalize(Object.create({usage: 1})), base);
  const ownNullPrototype = Object.assign(Object.create(null), {usage: 0});
  assert.deepEqual(normalize(ownNullPrototype), {...base, status: 'available', spend: {total: 0}});
  assert.equal(getterCalls, 0);
  const {proxy, revoke} = Proxy.revocable({}, {}); revoke();
  assert.deepEqual(normalizeOpenRouterUsage(proxy, NOW), base);
});

test('normalization neither changes the payload nor returns aliases to its nested metadata', () => {
  const effective = Object.freeze(budget()), freeRequests = Object.freeze(free());
  const data = Object.freeze({...key(), effective_budget: effective, free_model_daily_requests: freeRequests, usage: 5});
  const payload = Object.freeze({data}), before = JSON.stringify(payload);
  const result = normalizeOpenRouterUsage(payload, NOW);
  result.effectiveBudget.remaining = -900;
  result.freeRequests.remaining = 0;
  result.spend.total = 900;
  result.keyBudget.limit = 0;
  assert.equal(JSON.stringify(payload), before);
  assert.deepEqual(normalizeOpenRouterUsage(payload, NOW).effectiveBudget.remaining, 17.5);
});

test('checkedAt uses only a valid supplied timestamp; malformed time is rejected rather than invented', () => {
  assert.equal(normalizeOpenRouterUsage({}, 0).checkedAt, '1970-01-01T00:00:00.000Z');
  for (const invalid of [NaN, Infinity, -Infinity, '0', null, new Date(NOW), 8.64e15 + 1, -8.64e15 - 1]) {
    assert.throws(() => normalizeOpenRouterUsage({data: {usage: 1}}, invalid), RangeError);
  }
});
