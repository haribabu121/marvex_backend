function dateKeyInIndia(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
  return `${values.year}-${values.month}-${values.day}`
}

function localMidnight(key) {
  return new Date(`${key}T00:00:00.000+05:30`)
}

function nextMonthStart(key) {
  const [year, month] = key.slice(0, 7).split('-').map(Number)
  const next = new Date(Date.UTC(year, month, 1))
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01`
}

export function getSuryaGharReportingPeriod(now = new Date()) {
  const today = dateKeyInIndia(now)
  const monthStart = `${today.slice(0, 7)}-01`
  const nextMonth = nextMonthStart(today)
  return {
    timezone: 'Asia/Kolkata',
    today,
    todayStart: localMidnight(today),
    todayEnd: new Date(localMidnight(today).getTime() + 24 * 60 * 60 * 1000),
    monthStart,
    monthStartDate: localMidnight(monthStart),
    nextMonthStart: nextMonth,
    nextMonthStartDate: localMidnight(nextMonth),
  }
}
