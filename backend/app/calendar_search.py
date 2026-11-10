"""Derived calendar text only. Never index protocol attributes or account credentials."""
import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from fastapi import HTTPException
from database import db

SEARCH_VERSION = '2'


def index_resource(cid, href, raw):
    from calendar_service import parsed_ical, identity, _dt
    calendar = parsed_ical(raw)
    db.execute('DELETE FROM calendar_search_text WHERE calendar_id=? AND href=?', (cid, href))
    for e in calendar.walk('VEVENT'):
        rid = e.get('RECURRENCE-ID')
        original = rid.dt if rid is not None else None
        rid_text = (_dt(original).astimezone(ZoneInfo('UTC')).isoformat() if isinstance(original, datetime) else original.isoformat()) if original is not None else ''
        key = identity('search', cid, str(e['UID']), rid_text)
        # Only open-ended series depend on the current time; everything else is fixed at index time.
        series = not rid_text and bool(e.get('RRULE') or e.get('RDATE'))
        _, vals, eid, _ = (None, {}, None, None) if series else _occurrence(calendar, e, cid, str(e['UID']), rid_text)
        db.execute('INSERT OR REPLACE INTO calendar_search_text(id,calendar_id,href,uid,recurrence_id,title,location,description,start,component,'
                   'event_id,event_start,event_cancelled) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                   (key, cid, href, str(e['UID']), rid_text, str(e.get('SUMMARY','未命名日程')),
                    str(e.get('LOCATION','')), str(e.get('DESCRIPTION','')), _dt(e['DTSTART'].dt).timestamp(),
                    e.to_ical().decode(), eid, vals.get('start'), None if series else int(vals['cancelled'])))


def backfill():
    # A revision marker avoids reparsing cached iCalendar on every keystroke.
    if (db.one("SELECT value FROM schema_meta WHERE key='calendar_search_version'") or {}).get('value') == SEARCH_VERSION:
        return
    with db.transaction():
        for r in db.query('SELECT * FROM calendar_resources'):
            index_resource(r['calendar_id'], r['href'], r['ical'])
        db.execute("INSERT OR REPLACE INTO schema_meta VALUES('calendar_search_version',?)", (SEARCH_VERSION,))


def _component(cal, uid, recurrence_id, raw):
    from calendar_service import _dt
    def rid_of(e):
        rid = e.get('RECURRENCE-ID')
        if rid is None:
            return ''
        original = rid.dt
        return _dt(original).astimezone(ZoneInfo('UTC')).isoformat() if isinstance(original, datetime) else original.isoformat()
    # Serialising every component is expensive; compare identity fields before the exact text.
    return next(e for e in cal.walk('VEVENT') if str(e['UID']) == uid and rid_of(e) == recurrence_id and e.to_ical().decode() == raw)


def _occurrence(cal, component, calendar_id, uid, recurrence_id, now=None):
    import recurring_ical_events
    from dateutil.rrule import rruleset, rrulestr
    from calendar_service import identity, _dt, TZ
    r = {'uid': uid, 'recurrence_id': recurrence_id, 'calendar_id': calendar_id}
    now = now or datetime.now(TZ)
    e = component
    if not r['recurrence_id'] and (component.get('RRULE') or component.get('RDATE')):
        rules = rruleset()
        begin = _dt(component['DTSTART'].dt)
        for rule in component.get('RRULE', []) if isinstance(component.get('RRULE'), list) else [component.get('RRULE')]:
            if rule:
                rules.rrule(rrulestr(rule.to_ical().decode(), dtstart=begin))
        rules.rdate(begin)
        for prop, method in [('RDATE', rules.rdate), ('EXDATE', rules.exdate)]:
            values = component.get(prop, [])
            for value in values if isinstance(values, list) else [values]:
                if value:
                    for d in value.dts:
                        method(_dt(d.dt))
        for x in cal.walk('VEVENT'):
            if str(x['UID']) == r['uid'] and x.get('RECURRENCE-ID'):
                rules.exdate(_dt(x['RECURRENCE-ID'].dt))
        candidates = [rules.after(now, inc=True), rules.before(now, inc=True)]
        # Detached exceptions can move beyond the rule's last occurrence.
        candidates += [_dt(x['DTSTART'].dt) for x in cal.walk('VEVENT') if str(x['UID']) == r['uid'] and x.get('RECURRENCE-ID') and str(x.get('STATUS','')) != 'CANCELLED']
        future = sorted(t for t in candidates if t is not None and t >= now)
        past = sorted((t for t in candidates if t is not None and t < now), reverse=True)
        for candidate in future+past:
            occurrences = recurring_ical_events.of(cal).between(candidate, candidate+timedelta(seconds=1))
            found = [x for x in occurrences if str(x['UID']) == r['uid'] and str(x.get('STATUS','')) != 'CANCELLED']
            if found:
                e = found[0]
                break
    elif not r['recurrence_id']:
        # Match the recurrence library's original-instance identity for single events.
        begin = _dt(component['DTSTART'].dt)
        found = recurring_ical_events.of(cal).between(begin, begin+timedelta(seconds=1))
        e = next((x for x in found if str(x['UID']) == r['uid']), component)
    begin = e['DTSTART'].dt
    finish = e.get('DTEND')
    finish = finish.dt if finish else begin+(e.get('DURATION').dt if e.get('DURATION') else timedelta(days=1) if not isinstance(begin, datetime) else timedelta(hours=1))
    a, b = _dt(begin), _dt(finish)
    original = e.get('RECURRENCE-ID')
    original = original.dt if original is not None else begin
    recurring = e.get('RECURRENCE-ID') is not None or component.get('RRULE') or component.get('RDATE')
    rid = (_dt(original).astimezone(ZoneInfo('UTC')).isoformat() if isinstance(original, datetime) else original.isoformat()) if recurring else ''
    eid = identity(r['calendar_id'], str(e['UID']), rid)
    vals = {'title':str(e.get('SUMMARY','未命名日程')), 'start':a.timestamp(),'end':b.timestamp(),
            'all_day':not isinstance(begin,datetime),'start_date':a.astimezone(TZ).date().isoformat(),
            'end_date':(b-timedelta(microseconds=1)).astimezone(TZ).date().isoformat(),'timezone':str(a.tzinfo),
            'location':str(e.get('LOCATION','')),'description':str(e.get('DESCRIPTION','')),
            'cancelled':str(e.get('STATUS','')) == 'CANCELLED'}
    return e, vals, eid, rid


def resolve(key, now=None, materialize=True, cache=None):
    """Expand one search target from the local cache, including disconnected accounts."""
    from calendar_service import parsed_ical, event_detail, attendee_response, calendar_user_addresses
    r = db.one('SELECT t.*,r.ical,r.removed,a.user_addresses FROM calendar_search_text t '
               'JOIN calendar_resources r ON r.calendar_id=t.calendar_id AND r.href=t.href '
               'JOIN calendars c ON c.id=t.calendar_id JOIN calendar_accounts a ON a.id=c.account_id WHERE t.id=?', (key,))
    if not r or r['removed']:
        raise HTTPException(404, '该日程已删除，请刷新搜索结果')
    # One search may hit many components of the same large resource; parse it once.
    resource = (r['calendar_id'], r['href'])
    cal = cache.get(resource) if cache is not None else None
    if cal is None:
        cal = parsed_ical(r['ical'])
        if cache is not None:
            cache[resource] = cal
    component = _component(cal, r['uid'], r['recurrence_id'], r['component'])
    e, vals, eid, rid = _occurrence(cal, component, r['calendar_id'], r['uid'], r['recurrence_id'], now)
    if not materialize:
        return dict(vals, id=eid)
    with db.transaction():
        db.execute('INSERT OR IGNORE INTO calendar_events(id,source,calendar_id,resource_href,uid,recurrence_id,title,start,end,start_date,end_date) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                   (eid,'feishu',r['calendar_id'],r['href'],r['uid'],rid,vals['title'],vals['start'],vals['end'],vals['start_date'],vals['end_date']))
        db.execute('UPDATE calendar_events SET '+','.join(f'{k}=?' for k in vals)+',response_status=?,is_recurring=?,remote_deleted=0 WHERE id=?',
                   tuple(vals.values())+(attendee_response(e,calendar_user_addresses(r['calendar_id'],json.loads(r['user_addresses'] or '[]'))),bool(component.get('RRULE') or component.get('RDATE') or r['recurrence_id']),eid))
    return event_detail(eid)
