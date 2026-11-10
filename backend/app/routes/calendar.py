"""Authenticated loopback calendar API; no remote write operations."""
from datetime import date
import math
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
import calendar_service as service
from database import db

router = APIRouter(prefix='/api/calendar')


class EventRequest(BaseModel):
    title: str
    start: float
    end: float
    all_day: bool = False
    start_date: str
    end_date: str
    timezone: str = 'Asia/Shanghai'
    location: str = ''
    description: str = ''
    cancelled: bool = False
    session_id: str | None = None


class NotesRequest(BaseModel):
    notes: str
    version: int


class LinkRequest(BaseModel):
    session_ids: list[str]


class QuoteRequest(BaseModel):
    session_id: str
    start: float = Field(ge=0)
    text: str = Field(min_length=1)
    version: int


class AccountRequest(BaseModel):
    url: str
    username: str
    password: str


class SelectionRequest(BaseModel):
    ids: list[str]


class DateRequest(BaseModel):
    date: str | None = None


def validate_event(req):
    if not math.isfinite(req.start) or not math.isfinite(req.end):
        raise HTTPException(400, '日程时间无效')
    try:
        date.fromisoformat(req.start_date)
        date.fromisoformat(req.end_date)
    except ValueError:
        raise HTTPException(400, '日期格式需为 YYYY-MM-DD') from None


@router.get('/range')
def range_data(start: float, end: float):
    return service.range_data(start, end)


@router.get('/configuration')
def configuration():
    return service.configuration()


@router.post('/account/test')
def test_account(req: AccountRequest):
    return service.connect(req.url, req.username, req.password, store=False)


@router.post('/account')
def connect(req: AccountRequest):
    return service.connect(req.url, req.username, req.password)


@router.delete('/account')
def disconnect():
    db.execute('UPDATE calendar_accounts SET connected=0')
    return {'ok': True}


@router.patch('/calendars')
def select_calendars(req: SelectionRequest):
    with db.transaction():
        db.execute('UPDATE calendars SET selected=0')
        for cid in req.ids:
            db.execute('UPDATE calendars SET selected=1 WHERE id=?', (cid,))
    return {'ok': True}


@router.post('/sync')
def sync():
    return service.sync.start()


@router.post('/events')
def create_event(req: EventRequest):
    validate_event(req)
    if req.session_id:
        service.require_record(req.session_id)
    with db.transaction():
        e = service.local_event(req.model_dump(exclude={'session_id'}))
        if req.session_id:
            service.link(e['id'], req.session_id)
    return service.event_detail(e['id'])


@router.get('/events/{eid}')
def get_event(eid: str):
    return service.event_detail(eid)


@router.patch('/events/{eid}')
def update_event(eid: str, req: EventRequest):
    validate_event(req)
    return service.local_event(req.model_dump(exclude={'session_id'}), eid)


@router.delete('/events/{eid}')
def delete_event(eid: str):
    if service.require_event(eid)['source'] != 'local':
        raise HTTPException(409, '飞书日程只读')
    db.execute('UPDATE calendar_events SET deleted=1 WHERE id=?', (eid,))
    return {'ok': True}


@router.post('/events/{eid}/restore')
def restore_event(eid: str):
    if service.require_event(eid, deleted=True)['source'] != 'local':
        raise HTTPException(409, '只有本地日程可以恢复')
    db.execute('UPDATE calendar_events SET deleted=0 WHERE id=?', (eid,))
    return service.event_detail(eid)


@router.patch('/events/{eid}/notes')
def notes(eid: str, req: NotesRequest):
    return service.save_notes(eid, req.notes, req.version)


@router.post('/events/{eid}/links')
def links(eid: str, req: LinkRequest):
    with db.transaction():
        for sid in req.session_ids:
            service.link(eid, sid)
    return service.event_detail(eid)


@router.delete('/events/{eid}/links/{sid}')
def unlink(eid: str, sid: str):
    service.require_event(eid)
    db.execute('DELETE FROM calendar_links WHERE event_id=? AND session_id=?', (eid, sid))
    return {'ok': True}


@router.post('/events/{eid}/quotes')
def quotes(eid: str, req: QuoteRequest):
    return service.quote(eid, req.session_id, req.start, req.text, req.version)


@router.get('/quotes/{qid}')
def get_quote(qid: str):
    q = db.one('SELECT * FROM calendar_quotes WHERE id=?', (qid,))
    if not q:
        raise HTTPException(404, '引用不存在')
    q['available'] = int(bool(db.get_session(q['session_id'])))
    return q


@router.get('/sessions/{sid}/events')
def record_events(sid: str):
    service.require_record(sid)
    return service.record_events(sid)


@router.patch('/sessions/{sid}/date')
def record_date(sid: str, req: DateRequest):
    service.require_record(sid)
    if req.date is not None:
        try:
            date.fromisoformat(req.date)
        except ValueError:
            raise HTTPException(400, '日期格式需为 YYYY-MM-DD') from None
    db.update_session(sid, calendar_date=req.date)
    return {'ok': True}


@router.get('/events/{eid}/export')
def export(eid: str):
    return {'markdown': service.export(eid)}
