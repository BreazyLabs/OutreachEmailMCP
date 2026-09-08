/**
 * Timezone-aware calendar helpers without a dependency: everything the
 * planner needs is "what local date/time is it in tz X" and "what instant is
 * local HH:MM on date D in tz X". Both come from Intl.
 */

const DAY_MS = 24 * 3600_000;

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday … 6 = Saturday
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function localParts(at: number, tz: string): LocalParts {
  const parts = formatter(tz).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  };
}

/** 'YYYY-MM-DD' in the given timezone. */
export function localDate(at: number, tz: string): string {
  const p = localParts(at, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Minutes since local midnight. */
export function localMinutes(at: number, tz: string): number {
  const p = localParts(at, tz);
  return p.hour * 60 + p.minute;
}

export function isWeekend(at: number, tz: string): boolean {
  const w = localParts(at, tz).weekday;
  return w === 0 || w === 6;
}

/** Offset of tz from UTC at the given instant, in minutes (east positive). */
function offsetMinutes(at: number, tz: string): number {
  const p = localParts(at, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(at / 1000) * 1000) / 60_000);
}

/**
 * The instant at which local `minutesSinceMidnight` occurs on local `date`
 * in `tz`. Resolves DST by iterating the offset; a time that does not exist
 * on a spring-forward day lands on the next valid instant.
 */
export function localToInstant(date: string, minutesSinceMidnight: number, tz: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const wallClock = Date.UTC(y, m - 1, d, 0, 0, 0) + minutesSinceMidnight * 60_000;
  let guess = wallClock - offsetMinutes(wallClock, tz) * 60_000;
  // One correction pass handles the DST boundary cases.
  guess = wallClock - offsetMinutes(guess, tz) * 60_000;
  return guess;
}

/** 'YYYY-MM-DD' of the day `delta` days from `date` (calendar arithmetic). */
export function shiftDate(date: string, delta: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d) + delta * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function parseHHMM(value: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) throw new Error(`Invalid time "${value}" — expected HH:MM`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Invalid time "${value}"`);
  return h * 60 + min;
}
