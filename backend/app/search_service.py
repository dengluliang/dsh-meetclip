"""Authenticated saved-text search: literal substrings, entity deduplication and targets."""
import json
from database import db
from calendar_search import backfill
from query_scope import record_condition as scope_record_condition

KINDS = ('live','link_video','meeting','calendar')
PRIORITY = {'title':0,'notes':1,'minutes':1,'description':2,'quote':2,'transcript':3,'mark':4,'ocr':5,'speaker':6,'location':6,'source':7}
LABELS = {'title':'标题','notes':'笔记','minutes':'纪要','description':'日程说明','quote':'引用摘录','transcript':'转录原文','mark':'标记批注','ocr':'截图文字','speaker':'发言人','location':'地点','source':'来源链接'}


def matches(text, q):
    # SQLite invokes this scalar function on current persisted values, not drafts.
    return int(q.casefold() in (text or '').casefold())


with db._lock:
    db._conn.create_function('search_contains', 2, matches, deterministic=True)
backfill()


def positions(text, q):
    # Keep source offsets even for case folds such as ß -> ss.
    folded, offsets = '', []
    for i, c in enumerate(text):
        part = c.casefold(); folded += part; offsets.extend([i]*len(part))
    needle = q.casefold(); start = 0; spans = []
    while needle and (p := folded.find(needle,start)) >= 0:
        spans.append((offsets[p],offsets[p+len(needle)-1]+1)); start = p+len(needle)
    return spans


def _minutes_texts(data):
    """纪要 JSON 里所有可搜的文本；检索时按字段分别命中，片段才不会带 JSON 符号。"""
    if not isinstance(data, dict):
        return
    for key in ('title', 'summary'):
        value = data.get(key)
        if isinstance(value, str):
            yield value
    for topic in data.get('topics') or []:
        if not isinstance(topic, dict):
            continue
        for key in ('title', 'summary'):
            value = topic.get(key)
            if isinstance(value, str):
                yield value
        for point in topic.get('points') or []:
            if isinstance(point, dict) and isinstance(point.get('text'), str):
                yield point['text']
        fishbone = topic.get('fishbone') or {}
        if isinstance(fishbone, dict):
            if isinstance(fishbone.get('question'), str):
                yield fishbone['question']
            for branch in fishbone.get('branches') or []:
                if not isinstance(branch, dict):
                    continue
                for key in ('label', 'detail'):
                    value = branch.get(key)
                    if isinstance(value, str):
                        yield value
    for key in ('conclusions', 'todos'):
        for item in data.get(key) or []:
            if isinstance(item, dict) and isinstance(item.get('text'), str):
                yield item['text']
    for term in data.get('terms') or []:
        if not isinstance(term, dict):
            continue
        for key in ('name', 'note'):
            value = term.get(key)
            if isinstance(value, str):
                yield value
        for heard in term.get('heard') or []:
            if isinstance(heard, str):
                yield heard


def search(q, kind='all', offset=0, limit=50, scope=None, date_start=None, date_end=None, include_counts=True, sort='relevance'):
    # A sync commit cannot interleave resource metadata and instance notes in one result set.
    with db._lock:
        return _search(q, kind, offset, limit, scope, date_start, date_end, include_counts, sort)


def _search(q, kind='all', offset=0, limit=50, scope=None, date_start=None, date_end=None, include_counts=True, sort='relevance'):
    q = q.strip()
    if not q: return {'total':0,'counts':dict.fromkeys(KINDS,0),'results':[],'offset':offset,'has_more':False}
    entities = {}
    scoped = bool(scope and scope.get('mode') == 'selected')
    event_ids = list(scope.get('event_ids', [])) if scoped else []
    condition, record_parameters = scope_record_condition(scope)
    record_conditions = [condition]
    if not include_counts and kind != 'all':
        record_conditions.append("COALESCE(s.kind,'live')=?")
        record_parameters.append(kind)
    if date_start is not None:
        record_conditions.append('s.created_at>=?'); record_parameters.append(date_start)
    if date_end is not None:
        record_conditions.append('s.created_at<?'); record_parameters.append(date_end)
    record_condition = ' AND '.join(record_conditions) or '1'
    sessions = {s['id']:s for s in db.query('SELECT s.id,s.title,s.kind,s.source_url,s.notes,s.meta,s.created_at FROM sessions s WHERE '+record_condition, record_parameters)}
    def add(key, base, field, text, target):
        spans = positions(text or '',q)
        if not spans: return
        item = entities.setdefault(key,dict(base,id=key,match_count=0,_rank=99))
        item['match_count'] += len(spans)
        if PRIORITY[field] < item['_rank']:
            a,b = spans[0]; left=max(0,a-32); right=min(len(text),b+90)
            snippet = ('…' if left else '')+text[left:right].replace('\n',' ')+('…' if right<len(text) else '')
            utf = lambda i: len(text[:i].encode('utf-16-le'))//2
            item.update(_rank=PRIORITY[field],field=field,field_label=LABELS[field],snippet=snippet,
                        target=dict(target,text_start=utf(a),text_length=utf(b)-utf(a)))
    for sid,s in sessions.items():
        base={'kind':s['kind'] or 'live','title':s['title'],'date':s['created_at'],'offline':False,'status':''}
        for field,column in [('title','title'),('notes','notes'),('source','source_url')]:
            add('session:'+sid,base,field,s[column],{'session_id':sid,'pane':'notes' if field=='notes' else 'transcript'})
        try: speakers=json.loads(s['meta'] or '{}').get('speakers',{})
        except (ValueError,AttributeError): speakers={}
        for name in speakers.values():
            if isinstance(name,dict): name=name.get('name','')
            if isinstance(name,str): add('session:'+sid,base,'speaker',name,{'session_id':sid,'pane':'people'})
    minutes_sql = ('SELECT m.session_id AS sid,m.data AS data FROM session_minutes m JOIN sessions s ON s.id=m.session_id '
                   'WHERE search_contains(m.data,?) AND '+record_condition)
    for row in (db.query(minutes_sql, (q, *record_parameters)) if sessions else []):
        sid=row['sid']; s=sessions.get(sid)
        if not s:
            continue
        # 纪要已物化进笔记时只搜笔记，同一句话不重复计数。
        if 'meetclip:minutes:begin' in (s.get('notes') or ''):
            continue
        try:
            data=json.loads(row.get('data') or '{}')
        except (ValueError,TypeError):
            continue
        base={'kind':s['kind'] or 'live','title':s['title'],'date':s['created_at'],'offline':False,'status':''}
        for text in _minutes_texts(data):
            add('session:'+sid,base,'minutes',text,{'session_id':sid,'pane':'minutes'})
    for table,column,field,time_column in [('transcripts','text','transcript','start'),('marks','note','mark','ts'),('screenshots','ocr_text','ocr','ts')]:
        for row in db.query(f'SELECT t.id,t.session_id,t.{time_column} AS ts,t.{column} AS text FROM {table} t JOIN sessions s ON s.id=t.session_id WHERE '+
                            f'search_contains(t.{column},?) AND '+record_condition+' ORDER BY t.session_id,ts,t.id', (q, *record_parameters)) if sessions else []:
            sid=row['session_id']; s=sessions.get(sid)
            if s:
                add('session:'+sid,{'kind':s['kind'] or 'live','title':s['title'],'date':s['created_at'],'offline':False,'status':''},
                    field,row['text'],{'session_id':sid,'pane':field,'time':row['ts'],'item_id':str(row['id'])})
    calendar_enabled = include_counts or kind in ('all', 'calendar')
    resource_sql = ('SELECT t.*,r.removed,COALESCE(a.connected,0) connected'+
                    (',se.id allowed_event_id,se.start allowed_event_start,se.cancelled allowed_event_cancelled' if scoped else '')+
                    ' FROM calendar_search_text t JOIN calendar_resources r ON r.calendar_id=t.calendar_id AND r.href=t.href '
                    'JOIN calendars c ON c.id=t.calendar_id LEFT JOIN calendar_accounts a ON a.id=c.account_id ')
    resource_parameters = []
    if scoped:
        resource_sql += "JOIN calendar_events se ON se.calendar_id=t.calendar_id AND se.resource_href=t.href AND se.uid=t.uid AND (t.recurrence_id='' OR t.recurrence_id=se.recurrence_id) "
    resource_sql += 'WHERE r.removed=0'
    if scoped:
        resource_sql += ' AND se.deleted=0 AND '+('se.id IN ('+','.join('?' for identifier in event_ids)+')' if event_ids else '0')
        resource_parameters.extend(event_ids)
        if date_start is not None:
            resource_sql += ' AND se.start>=?'; resource_parameters.append(date_start)
        if date_end is not None:
            resource_sql += ' AND se.start<?'; resource_parameters.append(date_end)
    resources=db.query(resource_sql, resource_parameters) if calendar_enabled else []
    remote_keys = {}
    parsed = {}
    for r in resources:
        if not any(matches(r[field], q) for field in ('title','description','location')):
            continue
        if scoped:
            resolved = {'id':r['allowed_event_id'],'start':r['allowed_event_start'],'cancelled':bool(r['allowed_event_cancelled'])}
        elif r['event_id']:
            # Fixed occurrences are precomputed at index time; only series depend on now.
            resolved = {'id':r['event_id'],'start':r['event_start'],'cancelled':bool(r['event_cancelled'])}
        else:
            from calendar_search import resolve
            resolved = resolve(r['id'], materialize=False, cache=parsed)
        key = 'resource:'+r['id']
        if scoped:
            key = 'event:'+resolved['id']
        if date_start is not None and resolved['start'] < date_start or date_end is not None and resolved['start'] >= date_end:
            continue
        # Single events and detached exceptions are entities; recurring shared metadata is a series.
        series = 'RRULE' in r['component'] or 'RDATE' in r['component']
        if not series or scoped: remote_keys[resolved['id']] = key
        base={'kind':'calendar','title':r['title'],'date':resolved['start'],'offline':not bool(r['connected']),
              'status':'已取消' if resolved['cancelled'] else '重复日程' if series else ''}
        for field in ('title','description','location'):
            add(key,base,field,r[field],{'event_id':resolved['id'],'pane':'calendar'} if scoped else {'resource_id':r['id'],'pane':'calendar'})
    event_condition = "e.deleted=0 AND (e.remote_deleted=0 OR e.notes!='' OR EXISTS(SELECT 1 FROM calendar_links l JOIN sessions s ON s.id=l.session_id WHERE l.event_id=e.id))"
    event_parameters = []
    if scoped:
        event_condition += ' AND '+('e.id IN ('+','.join('?' for identifier in event_ids)+')' if event_ids else '0')
        event_parameters.extend(event_ids)
    if date_start is not None:
        event_condition += ' AND e.start>=?'; event_parameters.append(date_start)
    if date_end is not None:
        event_condition += ' AND e.start<?'; event_parameters.append(date_end)
    events = db.query('SELECT e.*,COALESCE(a.connected,1) connected FROM calendar_events e '
                      'LEFT JOIN calendars c ON c.id=e.calendar_id LEFT JOIN calendar_accounts a ON a.id=c.account_id '
                      'WHERE '+event_condition, event_parameters) if calendar_enabled else []
    quotes_by_event = {}
    for quote in db.query('SELECT q.* FROM calendar_quotes q JOIN calendar_events e ON e.id=q.event_id WHERE '+
                          event_condition+' AND search_contains(q.text,?)', (*event_parameters, q)) if events else []:
        quotes_by_event.setdefault(quote['event_id'], []).append(quote)
    for e in events:
        base={'kind':'calendar','title':e['title'],'date':e['start'],'offline':not bool(e['connected']),
              'status':'远端已删除 · 资料保留' if e['remote_deleted'] else '已取消' if e['cancelled'] else ''}
        # Remote common metadata belongs to the resource result, not every expanded occurrence.
        fields=('title','location','description','notes') if e['source']=='local' or e['remote_deleted'] else ('notes',)
        for field in fields:
            add(remote_keys.get(e['id'],'event:'+e['id']),base,field,e[field],{'event_id':e['id'],'pane':'notes' if field=='notes' else 'calendar'})
        for quote in quotes_by_event.get(e['id'], []):
            add(remote_keys.get(e['id'],'event:'+e['id']),base,'quote',quote['text'],{'event_id':e['id'],'pane':'notes','quote_id':quote['id']})
    counts={k:sum(e['kind']==k for e in entities.values()) for k in KINDS} if include_counts else {}
    rows=[e for e in entities.values() if kind=='all' or e['kind']==kind]
    rows.sort(key=lambda e:(-e['date'],e['_rank'],e['id']) if sort == 'date' else (e['_rank'],-e['date'],e['id']))
    for e in rows: e.pop('_rank')
    return {'total':len(rows),'counts':counts,'results':rows[offset:offset+limit],'offset':offset,'has_more':offset+limit<len(rows)}
