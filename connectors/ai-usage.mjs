const MAX_USD = 1e12;
const MAX_REQUESTS = 1e9;
const BUDGET_SCOPES = new Set([
  'workspace_default_member', 'workspace_default_key', 'member',
  'api_key', 'workspace', 'key_limit',
]);
const RESET_INTERVALS = new Set(['daily', 'weekly', 'monthly', null]);

function plainRecord(value) {
  if (!value || typeof value !== 'object') return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

// JSON responses have own data properties. Never invoke a payload getter or
// use inherited fields, even when this helper receives something besides JSON.
function own(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function dollars(value, remaining = false) {
  return typeof value === 'number' && Number.isFinite(value)
    && value <= MAX_USD && value >= (remaining ? -MAX_USD : 0);
}

function requests(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_REQUESTS;
}

function resetInstant(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 35) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, , zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1]
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return undefined;
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) return undefined;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
}

/**
 * Sanitize GET /api/v1/key quota metadata without IO or carrying identifiers.
 * A missing key cap is not a statement about account credit or other budgets.
 * No balances, reset times or request counters are inferred from other fields.
 */
export function normalizeOpenRouterUsage(payload, nowMillis = Date.now()) {
  if (typeof nowMillis !== 'number' || !Number.isFinite(nowMillis) || Math.abs(nowMillis) > 8.64e15) {
    throw new RangeError('Invalid usage check time.');
  }
  const output = {provider: 'openrouter', status: 'unknown', checkedAt: new Date(nowMillis).toISOString()};
  if (!plainRecord(payload)) return output;
  const data = own(payload, 'data');
  if (!plainRecord(data)) return output;

  const limit = own(data, 'limit'), remaining = own(data, 'limit_remaining');
  const resetInterval = own(data, 'limit_reset');
  if (dollars(limit) && dollars(remaining, true) && RESET_INTERVALS.has(resetInterval)) {
    output.keyBudget = {limit, remaining, resetInterval};
  } else if (limit === null && remaining === null) {
    output.keyLimitUnset = true;
  }

  const budget = own(data, 'effective_budget');
  if (plainRecord(budget)) {
    const scope = own(budget, 'scope'), limit = own(budget, 'limit_usd');
    const used = own(budget, 'spend_usd'), remaining = own(budget, 'remaining_usd');
    const resetInterval = own(budget, 'reset_interval');
    const resetsAt = resetInstant(own(budget, 'resets_at'));
    if (BUDGET_SCOPES.has(scope) && dollars(limit) && dollars(used)
      && dollars(remaining, true) && RESET_INTERVALS.has(resetInterval) && resetsAt !== undefined) {
      output.effectiveBudget = {scope, limit, used, remaining, resetInterval, resetsAt};
    }
  }

  const spend = {};
  for (const [input, target] of [
    ['usage', 'total'], ['usage_daily', 'daily'],
    ['usage_weekly', 'weekly'], ['usage_monthly', 'monthly'],
  ]) {
    const amount = own(data, input);
    if (dollars(amount)) spend[target] = amount;
  }
  if (Object.keys(spend).length) output.spend = spend;

  const free = own(data, 'free_model_daily_requests');
  if (plainRecord(free)) {
    const used = own(free, 'used'), limit = own(free, 'limit'), remaining = own(free, 'remaining');
    if (requests(used) && requests(limit) && requests(remaining) && remaining <= limit) {
      output.freeRequests = {used, limit, remaining};
    }
  }
  if (Object.keys(output).length > 3) output.status = 'available';
  return output;
}
