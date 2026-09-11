const KST_TIME_ZONE = "Asia/Seoul";

const kstDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: KST_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function getKstDate(now = new Date()): string {
  const parts = kstDateFormatter.formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (year === undefined || month === undefined || day === undefined) {
    throw new Error("KST date formatting failed");
  }

  return `${year}-${month}-${day}`;
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function getDailyCompletionDeadline(quizDate: string): Date {
  const nextDate = addDays(quizDate, 1);
  return new Date(`${nextDate}T01:00:00+09:00`);
}

export function isPastDailyCompletionDeadline(
  quizDate: string,
  now = new Date(),
): boolean {
  return now >= getDailyCompletionDeadline(quizDate);
}

/**
 * ADR-0002/0003: challenge expiry is the earlier of created+48h and
 * 00:00 KST two days after the creation date (KST).
 */
export function getChallengeExpiry(createdAt: Date): Date {
  const plus48h = new Date(createdAt.getTime() + 48 * 60 * 60 * 1000);
  const dayAfterNext = addDays(getKstDate(createdAt), 2);
  const kstBoundary = new Date(`${dayAfterNext}T00:00:00+09:00`);
  return plus48h < kstBoundary ? plus48h : kstBoundary;
}
