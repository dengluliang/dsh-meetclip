"""Local calendar identity, notes, associations and CalDAV resource cache."""
import hashlib
import json
import threading
import time
import uuid
from collections import OrderedDict
from datetime import date, datetime, time as day_time, timedelta
from urllib.parse import urlsplit, urlunsplit, urljoin
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from database import db

TZ = ZoneInfo('Asia/Shanghai')
SERVICE = 'cn.meetclip.calendar'
FIELDS = ('title', 'start', 'end', 'all_day', 'start_date', 'end_date', 'timezone', 'location', 'description', 'cancelled')
BATCH_SIZE = 50
SYNC_DEADLINE_SECONDS = 120


class CalendarReadError(RuntimeError):
    pass


def bound_requests(client, seconds=SYNC_DEADLINE_SECONDS):
    """Bound library retries as well as sockets; never log request headers or bodies."""
    original = client.request
    deadline = time.monotonic() + seconds
    calls = 0

    def request(*args, **kwargs):
        nonlocal calls
        calls += 1
        remaining = deadline - time.monotonic()
        if remaining <= 0 or calls > 200:
            raise CalendarReadError('读取日历超时或重试过多，请稍后重试；已有日程已保留')
        client.timeout = max(1, min(25, remaining))
        return original(*args, **kwargs)

    client.rate_limit_handle = False
    client.request = request


def read_calendar(calendar, token, progress):
    """Read content with calendar-multiget: some servers reject per-resource GET."""
    import caldav
    from caldav.elements import dav
    full = False
    progress('正在读取日程列表', 0, 0)
    try:
        result = calendar.get_objects_by_sync_token(token, load_objects=False, disable_fallback=True)
    except (caldav.error.ReportError, caldav.error.DAVError) as exc:
        expired = any('valid-sync-token' in str(p) for p in (getattr(exc, 'preconditions', ()) or ()))
        if 'author' in type(exc).__name__.lower() and not expired:
            raise
        result = calendar.get_events()
        full = True
    if getattr(result, 'truncated', False):
        raise CalendarReadError('服务器返回的日程列表不完整，请重试；已有日程已保留')
    deleted = {str(u.canonical() if hasattr(u, 'canonical') else u) for u in getattr(result, 'deleted_urls', ())}
    objects = [o for o in result if str(o.url.canonical() if hasattr(o.url, 'canonical') else o.url) not in deleted]
    resources = []
    for offset in range(0, len(objects), BATCH_SIZE):
        batch = objects[offset:offset+BATCH_SIZE]
        # Sync reports intentionally contain only URLs and ETags. Read by REPORT,
        # never by the .data getter, which can transparently issue GET and retry.
        if not full:
            loaded, tombstones = read_multiget(calendar, batch)
            deleted.update(tombstones)
            # Feishu returns 404 for optional schedule-tag even when calendar-data
            # is 200. Verify resource identity and actual content below instead.
            expected = {str(o.url.canonical()) for o in batch}
            received = {str(o.url.canonical()) for o in loaded}
            if received | tombstones != expected:
                raise CalendarReadError('部分日程未读取成功，请重试；已有日程已保留')
        else:
            loaded = batch
        etags = {str(o.url.canonical()): getattr(o, 'props', {}).get(dav.GetEtag.tag) for o in batch}
        for obj in loaded:
            data = getattr(obj, '_data', None)
            if not data:
                raise CalendarReadError('日程内容为空，请重试；已有日程已保留')
            raw = data.decode() if isinstance(data, bytes) else data
            parsed_ical(raw)
            href = str(obj.url.canonical())
            resources.append({'href': href, 'etag': getattr(obj, 'props', {}).get(dav.GetEtag.tag) or etags.get(href), 'ical': raw})
        progress('正在读取日程内容', min(offset+BATCH_SIZE, len(objects)), len(objects))
    return resources, deleted, getattr(result, 'sync_token', None), full or not token


def read_multiget(calendar, objects):
    """Respect per-property status instead of flattening optional-property 404s."""
    from lxml import etree
    from caldav.lib.url import URL
    from caldav.elements import dav
    from types import SimpleNamespace
    ns = {'d': 'DAV:', 'c': 'urn:ietf:params:xml:ns:caldav'}
    root = etree.Element('{'+ns['c']+'}calendar-multiget', nsmap=ns)
    prop = etree.SubElement(root, '{DAV:}prop')
    etree.SubElement(prop, '{DAV:}getetag')
    etree.SubElement(prop, '{'+ns['c']+'}calendar-data')
    for obj in objects:
        etree.SubElement(root, '{DAV:}href').text = urlsplit(str(obj.url)).path
    response = calendar.client.request(calendar.url, method='REPORT', body=etree.tostring(root, encoding='unicode'),
                                       headers={'Content-Type': 'application/xml; charset=utf-8'})
    if response.status != 207 or response.tree is None:
        raise CalendarReadError('服务器未返回完整日程内容，请重试；已有日程已保留')
    expected = {str(o.url.canonical()) for o in objects}
    loaded, tombstones = [], set()
    for item in response.tree.findall('d:response', ns):
        href = item.findtext('d:href', namespaces=ns)
        if not href:
            raise CalendarReadError('服务器日程缺少资源标识，请重试')
        canonical = URL(urljoin(str(calendar.url), href)).canonical()
        if str(canonical) not in expected:
            raise CalendarReadError('服务器返回了无法匹配的日程，请重试')
        resource_status = (item.findtext('d:status', namespaces=ns) or '').split()[1:2]
        if resource_status in (['404'], ['410']):
            tombstones.add(str(canonical))
            continue
        data, etag = None, None
        for propstat in item.findall('d:propstat', ns):
            status = propstat.findtext('d:status', namespaces=ns) or ''
            if status.split()[1:2] != ['200']:
                continue
            properties = propstat.find('d:prop', ns)
            if properties is not None:
                content = properties.findtext('c:calendar-data', namespaces=ns)
                if content:
                    data = content
                etag = properties.findtext('d:getetag', namespaces=ns) or etag
        if not data:
            raise CalendarReadError('部分日程未读取成功，请重试；已有日程已保留')
        loaded.append(SimpleNamespace(url=canonical, _data=data, props={dav.GetEtag.tag: etag}))
    return loaded, tombstones


def identity(*parts):
    return hashlib.sha256('\0'.join(map(str, parts)).encode()).hexdigest()[:32]


def require_event(eid, deleted=False):
    e = db.one('SELECT * FROM calendar_events WHERE id=?', (eid,))
    if not e or (e['deleted'] and not deleted):
        raise HTTPException(404, '日程不存在')
    return e


def require_record(sid):
    if not db.get_session(sid):
        raise HTTPException(404, '转录记录不存在')


def event_detail(eid):
    e = require_event(eid)
    e['records'] = db.query('SELECT s.id,s.title,s.kind,s.status,s.duration,s.created_at,s.calendar_date FROM sessions s '
                            'JOIN calendar_links l ON l.session_id=s.id WHERE l.event_id=? ORDER BY s.created_at', (eid,))
    e['quotes'] = db.query('SELECT q.*,CASE WHEN s.id IS NULL THEN 0 ELSE 1 END AS available '
                           'FROM calendar_quotes q LEFT JOIN sessions s ON s.id=q.session_id WHERE q.event_id=?', (eid,))
    return e


def record_events(sid):
    return db.query('SELECT e.* FROM calendar_events e JOIN calendar_links l ON e.id=l.event_id '
                    'WHERE l.session_id=? AND e.deleted=0 ORDER BY e.start', (sid,))


def link(eid, sid):
    require_event(eid)
    require_record(sid)
    db.execute('INSERT OR IGNORE INTO calendar_links(event_id,session_id) VALUES(?,?)', (eid, sid))


def local_event(values, eid=None):
    values = dict(values)
    if not values['title'].strip() or values['end'] <= values['start']:
        raise HTTPException(400, '请输入标题，并确保结束时间晚于开始时间')
    values['title'] = values['title'].strip()
    if eid:
        if require_event(eid)['source'] != 'local':
            raise HTTPException(409, '飞书日程只读，请在飞书修改')
        db.execute('UPDATE calendar_events SET '+','.join(f'{k}=?' for k in FIELDS)+' WHERE id=?',
                   tuple(values.get(k, False if k == 'cancelled' else '') for k in FIELDS)+(eid,))
    else:
        eid = uuid.uuid4().hex
        keys = ','.join(FIELDS)
        db.execute(f'INSERT INTO calendar_events(id,source,{keys}) VALUES(?,?,'+','.join('?' for _ in FIELDS)+')',
                   (eid, 'local')+tuple(values.get(k, False if k == 'cancelled' else '') for k in FIELDS))
    return event_detail(eid)


def save_notes(eid, notes, version):
    with db.transaction():
        e = require_event(eid)
        if version != e['notes_version']:
            raise HTTPException(409, '笔记已在其他窗口更新，当前草稿已保留，请重新载入后合并')
        db.execute('UPDATE calendar_events SET notes=?,notes_version=notes_version+1,notes_updated=? WHERE id=?',
                   (notes, time.time(), eid))
    return event_detail(eid)


def quote(eid, sid, start, text, version):
    require_record(sid)
    with db.transaction():
        e = require_event(eid)
        title = db.get_session(sid)['title']
        qid = uuid.uuid4().hex
        addition = f'\n\n> {text}\n> — [{title} · {int(start)//60:02d}:{int(start)%60:02d}](meetclip://quote/{qid})'
        result = save_notes(eid, e['notes']+addition, version)
        db.execute('INSERT INTO calendar_quotes VALUES(?,?,?,?,?,?)', (qid, eid, sid, title, start, text))
        link(eid, sid)
    return event_detail(eid)


def _dt(value):
    if isinstance(value, datetime):
        return value.replace(tzinfo=TZ) if value.tzinfo is None else value
    return datetime.combine(value, day_time.min, TZ)


def validate_ical(raw):
    from icalendar import Calendar
    c = Calendar.from_ical(raw)
    if not c or c.name != 'VCALENDAR':
        raise ValueError('Invalid calendar data')
    for e in c.walk('VEVENT'):
        if not e.get('UID') or not e.get('DTSTART'):
            raise ValueError('日程缺少 UID 或 DTSTART')
    return c


_PARSED = OrderedDict()
_PARSED_LOCK = threading.Lock()
PARSED_CACHE_SIZE = 256


def parsed_ical(raw):
    """Read-only parsed calendar shared by callers; keyed by content so edits never see stale data."""
    key = hashlib.sha256(raw.encode()).digest()
    with _PARSED_LOCK:
        cached = _PARSED.get(key)
        if cached is not None:
            _PARSED.move_to_end(key)
            return cached
    parsed = validate_ical(raw)
    with _PARSED_LOCK:
        _PARSED[key] = parsed
        _PARSED.move_to_end(key)
        while len(_PARSED) > PARSED_CACHE_SIZE:
            _PARSED.popitem(last=False)
    return parsed


def attendee_response(event, addresses):
    """Resolve the current account only; never use another attendee's response."""
    known = {str(value).strip().lower() for value in addresses}
    if not known:
        return None
    attendees = event.get('ATTENDEE', [])
    if not isinstance(attendees, list):
        attendees = [attendees]
    states = {str(a.params.get('PARTSTAT', 'NEEDS-ACTION')).upper() for a in attendees if str(a).strip().lower() in known}
    if len(states) == 1:
        response = states.pop()
        return response if response in ('ACCEPTED', 'NEEDS-ACTION', 'TENTATIVE', 'DECLINED') else None
    if not states and str(event.get('ORGANIZER', '')).strip().lower() in known:
        return 'ORGANIZER'
    return None


def calendar_user_addresses(cid, primary):
    """Resolve Feishu's internal address only from a verified personal-calendar identity.

    Feishu can advertise a work email on the principal but use an internal mailto
    address on events. CN alone is not sufficient: require the personal calendar
    title, an exact principal-address participant, and one consistent internal ID.
    Ambiguous aliases deliberately remain unknown.
    """
    known = {str(value).strip().lower() for value in primary}
    calendar = db.one('SELECT c.title,a.url FROM calendars c JOIN calendar_accounts a ON a.id=c.account_id WHERE c.id=?', (cid,))
    if not known or not calendar or urlsplit(calendar['url']).hostname != 'caldav.feishu.cn':
        return list(known)
    name = calendar['title'].strip()
    people = []
    for resource in db.query('SELECT ical FROM calendar_resources WHERE calendar_id=? AND removed=0', (cid,)):
        for event in parsed_ical(resource['ical']).walk('VEVENT'):
            attendees = event.get('ATTENDEE', [])
            people.extend(attendees if isinstance(attendees, list) else [attendees])
    if not name or not any(str(p).strip().lower() in known and str(p.params.get('CN', '')).strip() == name for p in people):
        return list(known)
    candidates = {str(p).strip().lower() for p in people
                  if str(p.params.get('CN', '')).strip() == name and str(p).strip().lower() not in known}
    if len(candidates) == 1:
        candidate = next(iter(candidates))
        if candidate.startswith('mailto:') and candidate.endswith('@calendar.feishu.cn'):
            occurrences = [p for p in people if str(p).strip().lower() == candidate]
            if len(occurrences) >= 2 and all(str(p.params.get('CN', '')).strip() == name for p in occurrences):
                known.add(candidate)
    return sorted(known)


def refresh_response_statuses(cid):
    """Re-evaluate cached instances even when an incremental sync has no resources."""
    import recurring_ical_events
    account = db.one('SELECT a.user_addresses FROM calendars c JOIN calendar_accounts a ON a.id=c.account_id WHERE c.id=?', (cid,))
    if not account:
        return
    addresses = calendar_user_addresses(cid, json.loads(account['user_addresses'] or '[]'))
    with db.transaction():
        for resource in db.query('SELECT * FROM calendar_resources WHERE calendar_id=? AND removed=0', (cid,)):
            calendar = parsed_ical(resource['ical'])
            for cached in db.query('SELECT id,start,uid FROM calendar_events WHERE calendar_id=? AND resource_href=? AND deleted=0 AND remote_deleted=0', (cid, resource['href'])):
                begin = datetime.fromtimestamp(cached['start'], TZ)
                for event in recurring_ical_events.of(calendar).between(begin, begin+timedelta(seconds=1)):
                    if str(event['UID']) != cached['uid']:
                        continue
                    original = event.get('RECURRENCE-ID')
                    original = original.dt if original is not None else event['DTSTART'].dt
                    rid = _dt(original).astimezone(ZoneInfo('UTC')).isoformat() if isinstance(original, datetime) else original.isoformat()
                    if cached['id'] in (identity(cid, cached['uid'], rid), identity(cid, cached['uid'], '')):
                        db.execute('UPDATE calendar_events SET response_status=? WHERE id=?', (attendee_response(event, addresses), cached['id']))
                        break


def expand_resources(start, end):
    """Expand recurrence per requested range; original recurrence ID survives rescheduling."""
    import recurring_ical_events
    address_cache = {}
    for r in db.query('SELECT r.*,a.user_addresses FROM calendar_resources r JOIN calendars c ON c.id=r.calendar_id '
                      'JOIN calendar_accounts a ON a.id=c.account_id WHERE c.selected=1 AND a.connected=1 AND r.removed=0'):
        c = parsed_ical(r['ical'])
        if r['calendar_id'] not in address_cache:
            address_cache[r['calendar_id']] = calendar_user_addresses(r['calendar_id'], json.loads(r['user_addresses'] or '[]'))
        addresses = address_cache[r['calendar_id']]
        instances = recurring_ical_events.of(c).between(datetime.fromtimestamp(start, TZ), datetime.fromtimestamp(end, TZ))
        # Include explicitly cancelled detached instances even if the recurrence library omits them.
        present = {(str(x.get('UID')), str(x.get('RECURRENCE-ID'))) for x in instances}
        for component in c.walk('VEVENT'):
            if str(component.get('STATUS', '')) == 'CANCELLED' and component.get('RECURRENCE-ID') and _dt(component['DTSTART'].dt).timestamp() < end:
                key = (str(component.get('UID')), str(component.get('RECURRENCE-ID')))
                if key not in present:
                    instances.append(component)
        recurring_uids = {str(x.get('UID')) for x in c.walk('VEVENT') if x.get('RRULE') or x.get('RDATE') or x.get('RECURRENCE-ID')}
        seen = set()
        with db.transaction():
            for e in instances:
                original = e.get('RECURRENCE-ID')
                is_recurring = str(e['UID']) in recurring_uids
                # Keep the existing identity format; recurrence presentation is a separate field.
                recurring = original is not None or is_recurring
                original = original.dt if original is not None else e['DTSTART'].dt
                rid = (_dt(original).astimezone(ZoneInfo('UTC')).isoformat() if isinstance(original, datetime) else original.isoformat()) if recurring else ''
                eid = identity(r['calendar_id'], str(e['UID']), rid)
                seen.add(eid)
                begin = e['DTSTART'].dt
                finish = e.get('DTEND')
                finish = finish.dt if finish is not None else begin+(e.get('DURATION').dt if e.get('DURATION') else timedelta(days=1) if not isinstance(begin, datetime) else timedelta(hours=1))
                a, b = _dt(begin), _dt(finish)
                all_day = not isinstance(begin, datetime)
                vals = {'title': str(e.get('SUMMARY', '未命名日程')), 'start': a.timestamp(), 'end': b.timestamp(),
                        'all_day': all_day, 'start_date': a.astimezone(TZ).date().isoformat(),
                        'end_date': (b-timedelta(microseconds=1)).astimezone(TZ).date().isoformat(),
                        'timezone': str(a.tzinfo), 'location': str(e.get('LOCATION', '')),
                        'description': str(e.get('DESCRIPTION', '')), 'cancelled': str(e.get('STATUS', '')) == 'CANCELLED'}
                db.execute('INSERT OR IGNORE INTO calendar_events(id,source,calendar_id,resource_href,uid,recurrence_id,title,start,end,start_date,end_date) '
                           'VALUES(?,?,?,?,?,?,?,?,?,?,?)', (eid, 'feishu', r['calendar_id'], r['href'], str(e['UID']), rid, vals['title'], vals['start'], vals['end'], vals['start_date'], vals['end_date']))
                db.execute('UPDATE calendar_events SET '+','.join(f'{k}=?' for k in FIELDS)+',remote_deleted=0,response_status=?,is_recurring=? WHERE id=?',
                           tuple(vals[k] for k in FIELDS)+(attendee_response(e, addresses), is_recurring, eid))
            # Only the fully expanded queried span can establish removed instances.
            for old in db.query('SELECT id FROM calendar_events WHERE calendar_id=? AND resource_href=? AND start<? AND end>?',
                                (r['calendar_id'], r['href'], end, start)):
                if old['id'] not in seen:
                    db.execute('UPDATE calendar_events SET remote_deleted=1 WHERE id=?', (old['id'],))


def range_data(start, end):
    if end <= start or end-start > 370*86400:
        raise HTTPException(400, '查询范围需为有效的一年以内时间段')
    expand_resources(start, end)
    events = db.query('SELECT e.*,(SELECT COUNT(*) FROM calendar_links l JOIN sessions s ON s.id=l.session_id WHERE l.event_id=e.id) AS record_count '
                     'FROM calendar_events e WHERE e.deleted=0 AND e.start<? AND e.end>? AND '
                     "(e.source='local' OR EXISTS(SELECT 1 FROM calendars c JOIN calendar_accounts a ON a.id=c.account_id WHERE c.id=e.calendar_id AND c.selected=1 AND a.connected=1)) ORDER BY e.all_day DESC,e.start", (end, start))
    records = db.query('SELECT s.id,s.title,s.kind,s.status,s.duration,s.created_at,s.calendar_date FROM sessions s WHERE NOT EXISTS('
                       'SELECT 1 FROM calendar_links l JOIN calendar_events e ON e.id=l.event_id WHERE l.session_id=s.id AND e.deleted=0) ORDER BY s.created_at DESC')
    return {'events': events, 'records': records}


def credential(aid, password=None, delete=False):
    from asr_engines import keychain
    vault = keychain()
    if delete:
        if vault.get_password(SERVICE, aid):
            vault.delete_password(SERVICE, aid)
        return None
    if password is not None:
        vault.set_password(SERVICE, aid, password)
    return vault.get_password(SERVICE, aid)


def client_for(account):
    import caldav
    password = credential(account['id'])
    if not password:
        raise HTTPException(409, '请在日历设置中填写 CalDAV 专用密码')
    return caldav.DAVClient(url=account['url'], username=account['username'], password=password, timeout=25,
                            ssl_verify_cert=True, require_tls=True, enable_rfc6764=False)


def normalize_server_url(value):
    """Accept the server host copied from calendar settings; always connect over TLS."""
    value = value.strip()
    if not value:
        raise HTTPException(400, '请填写 CalDAV 服务器地址，可直接填写服务器域名')
    if any(char.isspace() for char in value):
        raise HTTPException(400, '服务器地址中不能包含空格或换行，请只复制地址本身')
    if value.startswith('//'):
        value = 'https:' + value
    elif '://' not in value:
        value = 'https://' + value
    try:
        parsed = urlsplit(value)
        host, port = parsed.hostname, parsed.port
    except ValueError:
        raise HTTPException(400, '服务器地址或端口格式无效，请检查后重试') from None
    if parsed.username is not None or parsed.password is not None:
        raise HTTPException(400, '服务器地址不能包含用户名或密码，请分别填入下面的用户名和专用密码字段')
    if parsed.scheme not in ('https', 'http', 'caldav') or not host:
        raise HTTPException(400, '请填写 CalDAV 服务器域名或 HTTPS 地址')
    if parsed.query or parsed.fragment:
        raise HTTPException(400, '请填写 CalDAV 服务器地址，不要粘贴带有 ? 查询参数或 # 片段的日程分享链接')
    if host.endswith('.'):
        host = host[:-1]
    try:
        host = host.encode('idna').decode('ascii').lower()
    except UnicodeError:
        raise HTTPException(400, '服务器域名格式无效') from None
    if any(c in host for c in '\\%') or not host:
        raise HTTPException(400, '服务器域名格式无效')
    authority = f'[{host}]' if ':' in host else host
    if port is not None and port != 443:
        authority += f':{port}'
    return urlunsplit(('https', authority, parsed.path.rstrip('/')+'/', '', ''))


def connect(url, username, password, store=True):
    import caldav
    url = normalize_server_url(url)
    if not username.strip() or not password:
        raise HTTPException(400, '请填写用户名和 CalDAV 专用密码')
    aid = identity(url, username.strip())
    try:
        with caldav.DAVClient(url=url, username=username.strip(), password=password, timeout=25,
                              ssl_verify_cert=True, require_tls=True, enable_rfc6764=False) as client:
            principal = client.principal()
            found = [{'id': identity(aid, str(c.url)), 'url': str(c.url), 'title': str(c.get_display_name() or '飞书日历')} for c in principal.get_calendars() if str(c.url).startswith('https://')]
            try:
                addresses = [str(value) for value in principal.calendar_user_address_set() if value]
            except Exception:
                addresses = []
        if store:
            credential(aid, password)
            with db.transaction():
                db.execute('UPDATE calendar_accounts SET connected=0')
                db.execute('INSERT INTO calendar_accounts(id,url,username) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET connected=1,error=\'\'', (aid, url, username.strip()))
                if addresses:
                    db.execute('UPDATE calendar_accounts SET user_addresses=? WHERE id=?', (json.dumps(addresses), aid))
                previous = {c['id']: c['selected'] for c in db.query('SELECT id,selected FROM calendars WHERE account_id=?', (aid,))}
                db.execute('UPDATE calendars SET selected=0 WHERE account_id=?', (aid,))
                for c in found:
                    db.execute('INSERT INTO calendars(id,account_id,url,title) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,url=excluded.url', (c['id'], aid, c['url'], c['title']))
                    db.execute('UPDATE calendars SET selected=? WHERE id=?', (previous.get(c['id'], 1), c['id']))
        return {'calendars': found, 'ok': True}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, safe_error(exc)) from None


def safe_error(exc):
    if isinstance(exc, CalendarReadError):
        return str(exc)
    if isinstance(exc, HTTPException):
        return exc.detail
    name = type(exc).__name__.lower()
    if 'author' in name or 'auth' in name:
        return 'CalDAV 授权失败，请检查用户名和专用密码'
    if 'timeout' in name:
        return '连接超时，请检查网络后重试'
    return 'CalDAV 连接或读取失败，请检查服务器地址、网络和账号权限'


def apply_resources(cid, resources, deleted=(), token=None, full=False):
    """Validate the entire calendar response before committing or inferring removals."""
    for r in resources:
        parsed_ical(r['ical'])
    with db.transaction():
        seen = {r['href'] for r in resources}
        removed = set(deleted)
        if full:
            removed.update(r['href'] for r in db.query('SELECT href FROM calendar_resources WHERE calendar_id=?', (cid,)) if r['href'] not in seen)
        for r in resources:
            old = db.one('SELECT ical FROM calendar_resources WHERE calendar_id=? AND href=?', (cid, r['href']))
            db.execute('INSERT INTO calendar_resources(calendar_id,href,etag,ical) VALUES(?,?,?,?) '
                       'ON CONFLICT(calendar_id,href) DO UPDATE SET etag=excluded.etag,ical=excluded.ical,removed=0', (cid, r['href'], r.get('etag'), r['ical']))
            from calendar_search import index_resource
            index_resource(cid, r['href'], r['ical'])
            if old and old['ical'] != r['ical']:
                # Refresh already materialized months, including a moved exception's old span.
                spans = db.query('SELECT MIN(start) a,MAX(end) b FROM calendar_events WHERE calendar_id=? AND resource_href=?', (cid, r['href']))
                if spans[0]['a'] is not None:
                    expand_resources(spans[0]['a']-86400, spans[0]['b']+86400)
        for href in removed:
            db.execute('UPDATE calendar_resources SET removed=1 WHERE calendar_id=? AND href=?', (cid, href))
            db.execute('UPDATE calendar_events SET remote_deleted=1 WHERE calendar_id=? AND resource_href=?', (cid, href))
        db.execute('UPDATE calendars SET sync_token=?,last_sync=?,error=\'\' WHERE id=?', (token, time.time(), cid))


class SyncManager:
    def __init__(self):
        self.lock = threading.Lock()
        self.status = {'running': False, 'progress': 0, 'message': '', 'error': ''}

    def start(self):
        with self.lock:
            if self.status['running']:
                return self.snapshot()
            self.status = {'running': True, 'progress': 0, 'message': '正在读取日历', 'error': ''}
            threading.Thread(target=self.run, daemon=True).start()
        return self.snapshot()

    def snapshot(self):
        return dict(self.status)

    def run(self):
        import caldav
        from caldav.elements import dav
        try:
            calendars = db.query('SELECT c.*,a.url account_url,a.username FROM calendars c JOIN calendar_accounts a ON a.id=c.account_id WHERE c.selected=1 AND a.connected=1')
            for index, c in enumerate(calendars):
                try:
                    account = db.one('SELECT * FROM calendar_accounts WHERE id=?', (c['account_id'],))
                    with client_for(account) as client:
                        bound_requests(client)
                        try:
                            addresses = [str(value) for value in client.principal().calendar_user_address_set() if value]
                            if addresses:
                                db.execute('UPDATE calendar_accounts SET user_addresses=? WHERE id=?', (json.dumps(addresses), account['id']))
                        except Exception:
                            pass  # Keep the previously verified identity on a property-read failure.
                        calendar = caldav.Calendar(client=client, url=c['url'])

                        def progress(message, done, total):
                            fraction = done/total if total else 0
                            self.status.update(progress=(index+fraction)/max(1, len(calendars)),
                                               message=message+(f' · {done} / {total} 项' if total else ''))

                        resources, deleted, token, full = read_calendar(calendar, c['sync_token'], progress)
                        # Configuration may change while the request is in flight.
                        latest = db.one('SELECT c.selected,a.connected FROM calendars c JOIN calendar_accounts a ON a.id=c.account_id WHERE c.id=?', (c['id'],))
                        if not latest or not latest['selected'] or not latest['connected']:
                            continue
                        self.status['message'] = f'正在保存 {len(resources)} 项日程'
                        apply_resources(c['id'], resources, deleted, token, full)
                        refresh_response_statuses(c['id'])
                    db.execute('UPDATE calendar_accounts SET last_sync=?,error=\'\' WHERE id=?', (time.time(), c['account_id']))
                except Exception as exc:
                    message = safe_error(exc)
                    db.execute('UPDATE calendars SET error=? WHERE id=?', (message, c['id']))
                    self.status['error'] = message
                self.status.update(progress=(index+1)/max(1, len(calendars)), message=f'已读取 {index+1} / {len(calendars)} 个日历')
        finally:
            self.status['running'] = False


sync = SyncManager()


def configuration():
    account = db.one('SELECT * FROM calendar_accounts WHERE connected=1 LIMIT 1')
    if not account:
        account = db.one('SELECT * FROM calendar_accounts ORDER BY last_sync DESC LIMIT 1')
    result = sync.snapshot()
    if not result['error'] and account:
        failure = db.one('SELECT error FROM calendars WHERE account_id=? AND error != \'\' LIMIT 1', (account['id'],))
        if failure: result['error'] = failure['error']
    return {'account': account, 'calendars': db.query('SELECT * FROM calendars WHERE account_id=?', (account['id'],)) if account else [], 'sync': result}


def export(eid):
    e = event_detail(eid)
    lines = [f"# {e['title']}", '', '## 日程信息', '', f"- 日期：{e['start_date']} — {e['end_date']}", f"- 时间：{'全天' if e['all_day'] else datetime.fromtimestamp(e['start'],TZ).strftime('%H:%M')+'–'+datetime.fromtimestamp(e['end'],TZ).strftime('%H:%M')}",
             f"- 地点：{e['location'] or '—'}", f"- 来源：{'飞书' if e['source']=='feishu' else '本地'}", '', '## 日程笔记', '', e['notes'], '', '## 关联转录', '']
    lines += [f"- {r['title']}（{r.get('kind') or 'live'}） · meetclip://session/{r['id']}" for r in e['records']]
    if e['quotes']:
        lines += ['', '## 片段摘录', '']
        for q in e['quotes']:
            lines += [f"> {q['text']}", f"— {q['title']} · {int(q['start'])//60:02d}:{int(q['start'])%60:02d}"+(' · 来源不可用' if not q['available'] else ''), '']
    return '\n'.join(lines)
