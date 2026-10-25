export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

type CronField = { any: boolean; values: Set<number> };

type Cron = {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
};

const FIELD_ERROR = "Cron must be five UTC fields: minute hour day month weekday.";

function parseField(raw: string, min: number, max: number, sundaySeven = false): CronField {
  const text = raw.trim();
  if (!text) throw new CronError(FIELD_ERROR);
  if (text === "*") return { any: true, values: new Set<number>() };
  const values = new Set<number>();
  const ceiling = sundaySeven ? 7 : max;
  for (const part of text.split(",")) {
    const piece = part.trim();
    const match = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(piece);
    if (!match || match[1] === undefined) throw new CronError(FIELD_ERROR);
    if (match[1] === "*" && match[2]) throw new CronError(FIELD_ERROR);
    const step = match[3] ? Number(match[3]) : 1;
    if (!Number.isInteger(step) || step <= 0) throw new CronError(FIELD_ERROR);
    const start = match[1] === "*" ? min : Number(match[1]);
    const end = match[2] ? Number(match[2]) : match[3] ? ceiling : start;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
      throw new CronError(FIELD_ERROR);
    }
    if (start < min || end > ceiling) throw new CronError(FIELD_ERROR);
    for (let value = start; value <= end; value += step) {
      const normalized = sundaySeven && value === 7 ? 0 : value;
      if (normalized < min || normalized > max) throw new CronError(FIELD_ERROR);
      values.add(normalized);
    }
  }
  if (values.size === 0) throw new CronError(FIELD_ERROR);
  return { any: false, values };
}

export function parseCron(expression: string): Cron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new CronError(FIELD_ERROR);
  const [minute, hour, dom, month, dow] = fields;
  if (!minute || !hour || !dom || !month || !dow) throw new CronError(FIELD_ERROR);
  return {
    minute: parseField(minute, 0, 59),
    hour: parseField(hour, 0, 23),
    dom: parseField(dom, 1, 31),
    month: parseField(month, 1, 12),
    dow: parseField(dow, 0, 6, true),
  };
}

function matches(field: CronField, value: number): boolean {
  return field.any || field.values.has(value);
}

function dayMatches(date: Date, cron: Cron): boolean {
  const dom = date.getUTCDate();
  const dow = date.getUTCDay();
  if (!cron.dom.any && !cron.dow.any) {
    return cron.dom.values.has(dom) || cron.dow.values.has(dow);
  }
  return matches(cron.dom, dom) && matches(cron.dow, dow);
}

/** Next UTC occurrence strictly after `after`. */
export function nextCron(expression: string, after: Date): Date {
  const cron = parseCron(expression);
  const afterMs = after.getTime();
  if (!Number.isFinite(afterMs)) throw new CronError("Cron start time is invalid.");
  let year = after.getUTCFullYear();
  let month = after.getUTCMonth() + 1;
  let day = after.getUTCDate();

  for (let offset = 0; offset < 366 * 8; offset += 1) {
    const cursor = new Date(Date.UTC(year, month - 1, day));
    if (matches(cron.month, month) && dayMatches(cursor, cron)) {
      for (let hour = 0; hour <= 23; hour += 1) {
        if (!matches(cron.hour, hour)) continue;
        for (let minute = 0; minute <= 59; minute += 1) {
          if (!matches(cron.minute, minute)) continue;
          const candidate = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
          if (candidate > afterMs) return new Date(candidate);
        }
      }
    }
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    year = next.getUTCFullYear();
    month = next.getUTCMonth() + 1;
    day = next.getUTCDate();
  }
  throw new CronError("Cron expression has no occurrence in the next 8 years.");
}
