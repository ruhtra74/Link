/**
 * Périodes du tableau de bord, en heure locale de l'appareil (« aujourd'hui » à Douala n'est pas
 * « aujourd'hui » en UTC), converties en bornes UTC pour interroger les ventes.
 * La semaine va du lundi au dimanche ; le mois est le mois civil.
 */
import { localDate, type Clock } from '../context';
import { DomainError } from '../errors';

export type PeriodPreset = 'TODAY' | 'WEEK' | 'MONTH';

/** Une période prédéfinie, ou des dates locales choisies (AAAA-MM-JJ, bornes incluses). */
export type PeriodInput = { preset: PeriodPreset } | { from: string; to: string };

export interface ResolvedPeriod {
  /** Premier jour (local, inclus). */
  fromDate: string;
  /** Dernier jour (local, inclus). */
  toDate: string;
  /** Bornes UTC pour l'heure des ventes : `fromUtc` inclus, `toUtc` exclu. */
  fromUtc: string;
  toUtc: string;
}

const DAY = 86_400_000;
const parseDay = (d: string) => Date.parse(`${d}T00:00:00.000Z`);
const formatDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => formatDay(parseDay(d) + n * DAY);

function assertDate(field: string, d: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || formatDay(parseDay(d)) !== d) {
    throw new DomainError('VALIDATION', 'Date invalide (format AAAA-MM-JJ).', { field });
  }
  return d;
}

/** Instant UTC correspondant à minuit local du jour `d`. */
function localMidnightUtc(clock: Clock, d: string): string {
  const naive = parseDay(d);
  return new Date(naive - clock.utcOffsetMinutes(naive) * 60_000).toISOString();
}

export function periodFromDates(clock: Clock, fromDate: string, toDate: string): ResolvedPeriod {
  assertDate('from', fromDate);
  assertDate('to', toDate);
  if (toDate < fromDate) throw new DomainError('VALIDATION', 'La date de fin précède la date de début.', { field: 'to' });
  return { fromDate, toDate, fromUtc: localMidnightUtc(clock, fromDate), toUtc: localMidnightUtc(clock, addDays(toDate, 1)) };
}

export function resolvePeriod(clock: Clock, input: PeriodInput): ResolvedPeriod {
  if ('from' in input) return periodFromDates(clock, input.from, input.to);
  const today = localDate(clock, clock.now());
  switch (input.preset) {
    case 'TODAY':
      return periodFromDates(clock, today, today);
    case 'WEEK': {
      const weekday = (new Date(parseDay(today)).getUTCDay() + 6) % 7; // lundi = 0
      const monday = addDays(today, -weekday);
      return periodFromDates(clock, monday, addDays(monday, 6));
    }
    case 'MONTH': {
      const first = `${today.slice(0, 7)}-01`;
      const nextMonth = new Date(parseDay(first));
      nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
      return periodFromDates(clock, first, addDays(formatDay(nextMonth.getTime()), -1));
    }
  }
}

/**
 * Période précédente, pour la comparaison : le jour d'avant, la semaine d'avant, le mois civil
 * d'avant, ou le même nombre de jours juste avant une période choisie.
 */
export function previousPeriod(clock: Clock, input: PeriodInput, current: ResolvedPeriod): ResolvedPeriod {
  if (!('from' in input) && input.preset === 'MONTH') {
    const prevLast = addDays(current.fromDate, -1);
    return periodFromDates(clock, `${prevLast.slice(0, 7)}-01`, prevLast);
  }
  const days = Math.round((parseDay(current.toDate) - parseDay(current.fromDate)) / DAY) + 1;
  return periodFromDates(clock, addDays(current.fromDate, -days), addDays(current.fromDate, -1));
}
