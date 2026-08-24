export interface DeliverableRecord {
  readonly path?: unknown;
  readonly savedAt?: unknown;
}

const SECRET_PATTERNS = [
  /https:\/\/discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/gu,
  /\b(?:api[_-]?key|secret|passphrase|token|authorization)\s*[:=]\s*[^\s,}]+/giu,
];

export function redactDeliveryDiagnostic(value: unknown, maximum = 500): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[REDACTED]');
  return text.slice(0, maximum);
}

export function describeDeliveryCommandFailure(input: {
  readonly command: string;
  readonly status: number | null;
  readonly payload?: unknown;
  readonly stderr?: string;
}): string {
  const payload = input.payload as { readonly error?: unknown } | undefined;
  const reason = payload?.error ?? input.stderr ?? 'no diagnostic';
  return redactDeliveryDiagnostic(
    `${input.command} exited ${String(input.status)}: ${redactDeliveryDiagnostic(reason)}`,
  );
}

function nestedNumbers(value: unknown, output: number[] = []): number[] {
  if (typeof value === 'number' && Number.isFinite(value)) output.push(value);
  else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) nestedNumbers(item, output);
  }
  return output;
}

export function isRetryableDeliveryFailure(input: {
  readonly status: number | null;
  readonly payload?: unknown;
  readonly stderr?: string;
}): boolean {
  // The current CLI can occasionally exit successfully without emitting its
  // required JSON acknowledgement. This is retryable only by callers that
  // first prove the exact deliverable is absent via the remote postcondition.
  if (input.status === 0 && input.payload === undefined && (input.stderr ?? '').trim() === '') {
    return true;
  }
  const codes = nestedNumbers(input.payload);
  if (codes.some((code) => code === 429 || code >= 500)) return true;
  const text = redactDeliveryDiagnostic([input.payload, input.stderr].filter(Boolean), 2_000).toLowerCase();
  return /(?:network|temporar|timed?\s*out|timeout|connection reset|connection refused|service unavailable|too many requests|http\s*5\d\d)/u.test(text);
}

export function exactDeliverableMatches(
  records: readonly DeliverableRecord[],
  expectedText: string,
  readText: (path: string) => string | undefined,
  minimumSavedAt = 0,
): boolean {
  for (const record of records) {
    if (typeof record.path !== 'string') continue;
    const savedAt = typeof record.savedAt === 'string' ? Date.parse(record.savedAt) : Number.NaN;
    if (!Number.isFinite(savedAt) || savedAt < minimumSavedAt) continue;
    const content = readText(record.path);
    if (content?.trim() === expectedText.trim()) return true;
  }
  return false;
}
