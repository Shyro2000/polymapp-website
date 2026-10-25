export interface ServicePeriod {
  id: string;
  startMs: number;
  endMs: number;
  annualCents: number;
  seatLimit: number;
}
export const DAY_MS = 86400000;

/**
 * Uses UTC calendar days; the change day belongs to the new tariff.
 * @param {number} ms Timestamp in milliseconds.
 * @return {*} Calculated result or verified server context.
 */
export function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/**
 * Prices remaining prepaid service, rounding each complete period once.
 * @param {ServicePeriod[]} periods Prepaid service periods and their
 * locked prices.
 * @param {number} targetAnnualCents Annual tariff price in integer rappen.
 * @param {number} atMs Effective change time in milliseconds.
 * @return {*} Calculated result or verified server context.
 */
export function proratedDelta(
  periods: ServicePeriod[],
  targetAnnualCents: number,
  atMs: number,
): number {
  const changeDay = utcDay(atMs);
  return periods.reduce((total, period) => {
    const start = utcDay(period.startMs);
    const end = utcDay(period.endMs) + DAY_MS;
    if (end <= start || changeDay >= end) return total;
    const remaining = end - Math.max(start, changeDay);
    const difference = targetAnnualCents - period.annualCents;
    const rounded =
      Math.sign(difference) *
      Math.round((Math.abs(difference) * remaining) / (end - start));
    return total + rounded;
  }, 0);
}

/**
 * Applies non-cash tariff credit without ever producing a negative invoice.
 * @param {number} grossCents Charge before credits in integer rappen.
 * @param {number} balanceCents Available non-cash credit in integer rappen.
 * @return {*} Calculated result or verified server context.
 */
export function applyCredit(
  grossCents: number,
  balanceCents: number,
): {
  creditUsedCents: number;
  amountDueCents: number;
} {
  if (
    !Number.isSafeInteger(grossCents) ||
    grossCents < 0 ||
    !Number.isSafeInteger(balanceCents) ||
    balanceCents < 0
  ) {
    throw new Error("Invalid monetary amount");
  }
  const creditUsedCents = Math.min(grossCents, balanceCents);
  return {creditUsedCents, amountDueCents: grossCents - creditUsedCents};
}
