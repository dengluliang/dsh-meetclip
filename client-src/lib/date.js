export function pad(value) {
  return String(value).padStart(2, '0')
}

export function ymd(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function parseYmd(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

export function addDays(date, days) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  next.setDate(next.getDate() + days)
  return next
}

export function addMonths(date, months) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1)
}

export function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

export function monthGrid(date) {
  const first = startOfMonth(date)
  const offset = (first.getDay() + 6) % 7 // Monday-first
  const start = addDays(first, -offset)
  const days = Array.from({ length: 42 }, (_, index) => addDays(start, index))
  return { start, end: addDays(start, 42), days }
}

export function monthLabel(date, locale = 'zh-CN') {
  try {
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' }).format(date)
  } catch {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`
  }
}

export function weekdayLabels(locale = 'zh-CN') {
  const base = new Date(2024, 0, 1) // Monday
  try {
    return Array.from({ length: 7 }, (_, index) =>
      new Intl.DateTimeFormat(locale, { weekday: 'narrow' }).format(addDays(base, index)))
  } catch {
    return ['一', '二', '三', '四', '五', '六', '日']
  }
}

export function clockTime(epochSeconds) {
  if (!epochSeconds) return ''
  const date = new Date(epochSeconds * 1000)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function dateTimeLocal(epochSeconds) {
  const date = new Date((epochSeconds || Date.now() / 1000) * 1000)
  return `${ymd(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function fromDateTimeLocal(value) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.getTime() / 1000 : null
}

export function eventDates(event) {
  if (!event) return []
  if (event.all_day && event.start_date) {
    const start = parseYmd(event.start_date)
    const end = parseYmd(event.end_date) || start
    if (!start) return []
    const days = []
    let cursor = start
    for (let i = 0; i < 62 && cursor <= end; i += 1) {
      days.push(ymd(cursor))
      cursor = addDays(cursor, 1)
    }
    return days
  }
  const date = new Date((event.start || 0) * 1000)
  return [ymd(date)]
}

export function sameDay(value, date) {
  return value === ymd(date)
}
