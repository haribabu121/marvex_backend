import assert from 'node:assert/strict'
import test from 'node:test'
import { getSuryaGharReportingPeriod } from '../src/utils/suryaGharReporting.js'

test('uses Asia/Kolkata midnight for daily and monthly dashboard boundaries', () => {
  const period = getSuryaGharReportingPeriod(new Date('2026-11-19T18:30:00.000Z'))
  assert.equal(period.today, '2026-11-20')
  assert.equal(period.todayStart.toISOString(), '2026-11-19T18:30:00.000Z')
  assert.equal(period.todayEnd.toISOString(), '2026-11-20T18:30:00.000Z')
  assert.equal(period.monthStartDate.toISOString(), '2026-10-31T18:30:00.000Z')
  assert.equal(period.nextMonthStart, '2026-12-01')
  assert.equal(period.nextMonthStartDate.toISOString(), '2026-11-30T18:30:00.000Z')
})
