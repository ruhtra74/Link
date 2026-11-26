import { describe, expect, it } from 'vitest';

import { createTestClock } from '../testing/context';
import { previousPeriod, resolvePeriod, type PeriodInput } from './periods';

const clockAt = (iso: string, offset = 0) => {
  const c = createTestClock(iso);
  c.setUtcOffset(offset);
  return c;
};

describe('resolvePeriod', () => {
  it("aujourd'hui, en heure locale (Douala, UTC+1)", () => {
    const clock = clockAt('2026-01-05T23:30:00.000Z', 60); // déjà le 6 à Douala
    expect(resolvePeriod(clock, { preset: 'TODAY' })).toEqual({
      fromDate: '2026-01-06',
      toDate: '2026-01-06',
      fromUtc: '2026-01-05T23:00:00.000Z',
      toUtc: '2026-01-06T23:00:00.000Z',
    });
  });

  it('la semaine va du lundi au dimanche', () => {
    const clock = clockAt('2026-01-08T10:00:00.000Z'); // jeudi
    expect(resolvePeriod(clock, { preset: 'WEEK' })).toMatchObject({ fromDate: '2026-01-05', toDate: '2026-01-11' });
    const sunday = clockAt('2026-01-11T10:00:00.000Z');
    expect(resolvePeriod(sunday, { preset: 'WEEK' })).toMatchObject({ fromDate: '2026-01-05', toDate: '2026-01-11' });
  });

  it('le mois civil, y compris février', () => {
    expect(resolvePeriod(clockAt('2026-02-14T10:00:00.000Z'), { preset: 'MONTH' })).toMatchObject({ fromDate: '2026-02-01', toDate: '2026-02-28' });
    expect(resolvePeriod(clockAt('2026-12-31T10:00:00.000Z'), { preset: 'MONTH' })).toMatchObject({
      fromDate: '2026-12-01',
      toDate: '2026-12-31',
      toUtc: '2027-01-01T00:00:00.000Z',
    });
  });

  it('dates choisies, bornes incluses', () => {
    expect(resolvePeriod(clockAt('2026-03-01T00:00:00Z'), { from: '2026-01-10', to: '2026-01-20' })).toMatchObject({
      fromUtc: '2026-01-10T00:00:00.000Z',
      toUtc: '2026-01-21T00:00:00.000Z',
    });
  });

  it('refuse des dates invalides ou inversées', () => {
    const clock = clockAt('2026-03-01T00:00:00Z');
    expect(() => resolvePeriod(clock, { from: '2026-02-30', to: '2026-03-01' })).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
    expect(() => resolvePeriod(clock, { from: '2026-03-02', to: '2026-03-01' })).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
  });
});

describe('previousPeriod', () => {
  const prev = (iso: string, input: PeriodInput) => {
    const clock = clockAt(iso);
    return previousPeriod(clock, input, resolvePeriod(clock, input));
  };

  it('hier, la semaine dernière, le mois civil précédent', () => {
    expect(prev('2026-03-01T10:00:00Z', { preset: 'TODAY' })).toMatchObject({ fromDate: '2026-02-28', toDate: '2026-02-28' });
    expect(prev('2026-01-08T10:00:00Z', { preset: 'WEEK' })).toMatchObject({ fromDate: '2025-12-29', toDate: '2026-01-04' });
    expect(prev('2026-03-15T10:00:00Z', { preset: 'MONTH' })).toMatchObject({ fromDate: '2026-02-01', toDate: '2026-02-28' });
  });

  it('pour des dates choisies : le même nombre de jours, juste avant', () => {
    expect(prev('2026-03-01T00:00:00Z', { from: '2026-01-10', to: '2026-01-20' })).toMatchObject({ fromDate: '2025-12-30', toDate: '2026-01-09' });
  });
});
