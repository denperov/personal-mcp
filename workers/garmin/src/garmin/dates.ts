const MS_DAY = 86_400_000;
const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** YYYY-MM-DD in the given time zone */
export function localDate(timeZone: string, at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export function addDays(day: string, n: number): string {
  return new Date(ms(day) + n * MS_DAY).toISOString().slice(0, 10);
}

/** to - from, in days */
export function daysBetween(from: string, to: string): number {
  return Math.round((ms(to) - ms(from)) / MS_DAY);
}
