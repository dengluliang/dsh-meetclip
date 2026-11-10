"""Calendar API and CalDAV cache tests, isolated from personal data and network."""
import os
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

DATA = tempfile.TemporaryDirectory(prefix='meetclip-calendar-tests-')
os.environ['ZHIBO_DATA_DIR'] = DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
import calendar_service as service
from database import db, DB
import main
import auth
from fastapi.testclient import TestClient


def ical(title='Weekly', exception=False, cancel=False):
    extra = ('BEGIN:VEVENT\nUID:weekly\nRECURRENCE-ID;TZID=Asia/Shanghai:20261020T100000\n'
             'DTSTART;TZID=Asia/Shanghai:20261021T140000\nDTEND;TZID=Asia/Shanghai:20261021T150000\n'
             'SUMMARY:Moved\nEND:VEVENT\n') if exception else ''
    return ('BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:weekly\n'
            'DTSTART;TZID=Asia/Shanghai:20261020T100000\nDTEND;TZID=Asia/Shanghai:20261020T110000\n'
            f'RRULE:FREQ=WEEKLY;COUNT=3\nSUMMARY:{title}\n'+('STATUS:CANCELLED\n' if cancel else '')+
            'END:VEVENT\n'+extra+'END:VCALENDAR\n').replace('\n', '\r\n')


class CalendarTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(main.app, base_url='http://127.0.0.1', headers={'X-MeetClip-Token': auth.API_TOKEN})

    def setUp(self):
        for table in ['calendar_quotes','calendar_links','calendar_events','calendar_resources','calendars','calendar_accounts','sessions']:
            db.execute(f'DELETE FROM {table}')
        db.execute("INSERT INTO calendar_accounts(id,url,username) VALUES('a','https://example.test/','u')")
        db.execute("INSERT INTO calendars(id,account_id,url,title) VALUES('c','a','https://example.test/c/','Work')")
        self.start = datetime(2026, 10, 1, tzinfo=service.TZ).timestamp()
        self.end = datetime(2026, 11, 15, tzinfo=service.TZ).timestamp()

    def local(self, title='Local'):
        r = self.client.post('/api/calendar/events', json={'title':title,'start':self.start+3600,'end':self.start+7200,
                                                           'start_date':'2026-10-01','end_date':'2026-10-01'})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_server_url_accepts_domain_and_keeps_secure_connection(self):
        cases = {
            'calendar.example.test': 'https://calendar.example.test/',
            '  calendar.example.test/dav/  ': 'https://calendar.example.test/dav/',
            '//calendar.example.test/dav': 'https://calendar.example.test/dav/',
            'https://CALENDAR.example.test:443/dav': 'https://calendar.example.test/dav/',
            'http://calendar.example.test': 'https://calendar.example.test/',
            'caldav://calendar.example.test/dav': 'https://calendar.example.test/dav/',
            'calendar.example.test:8443/dav': 'https://calendar.example.test:8443/dav/',
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(service.normalize_server_url(raw), expected)

    def test_server_url_errors_are_specific_and_do_not_expose_secrets(self):
        from fastapi import HTTPException
        cases = [('', '请填写'), ('https://user:private-password@example.test/', '用户名或密码'),
                 ('https://example.test/?token=private-password', '查询参数'),
                 ('https://example.test/#private-password', '片段'),
                 ('example.test:bad/dav', '端口'), ('example.test:99999', '端口'),
                 ('https://example.test/dav name', '空格'), ('ftp://example.test', 'HTTPS')]
        for raw, expected in cases:
            with self.subTest(raw=raw):
                with self.assertRaises(HTTPException) as raised:
                    service.normalize_server_url(raw)
                self.assertIn(expected, raised.exception.detail)
                self.assertNotIn('private-password', raised.exception.detail)

    def test_connection_uses_normalized_server_without_persisting_test_credentials(self):
        class Client:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def principal(self): return self
            def get_calendars(self): return []
        with patch('caldav.DAVClient', return_value=Client()) as client, patch.object(service, 'credential') as vault:
            response = self.client.post('/api/calendar/account/test', json={
                'url': 'calendar.example.test/dav', 'username': 'test-user', 'password': 'test-password'})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(client.call_args.kwargs['url'], 'https://calendar.example.test/dav/')
            self.assertTrue(client.call_args.kwargs['require_tls'])
            vault.assert_not_called()

    def remote(self, raw=None):
        service.apply_resources('c', [{'href':'h','etag':'v1','ical':raw or ical()}], full=True)
        return service.range_data(self.start,self.end)['events']

    def test_legacy_migration_is_repeatable(self):
        path = Path(DATA.name)/'migration.sqlite'
        import sqlite3
        con = sqlite3.connect(path); con.execute('CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,created_at REAL,status TEXT,meta TEXT,error TEXT)'); con.execute("INSERT INTO sessions VALUES('old','Old',1,'done','{}',NULL)");con.commit();con.close()
        for _ in range(2):
            migrated = DB(path);self.assertEqual(migrated.get_session('old')['title'],'Old');self.assertIsNone(migrated.get_session('old')['calendar_date']);migrated._conn.close()

    def test_notes_conflict_clear_and_isolation(self):
        e = self.local(); other = self.local('Other')
        r = self.client.patch(f"/api/calendar/events/{e['id']}/notes",json={'notes':'## Notes\n\n- [ ] todo','version':0});self.assertEqual(r.status_code,200)
        self.assertEqual(self.client.patch(f"/api/calendar/events/{e['id']}/notes",json={'notes':'stale','version':0}).status_code,409)
        self.assertEqual(service.event_detail(other['id'])['notes'],'')
        self.assertEqual(self.client.patch(f"/api/calendar/events/{e['id']}/notes",json={'notes':'','version':1}).json()['notes'],'')

    def test_attendee_response_matches_only_current_account(self):
        from icalendar import Event, vCalAddress
        event = Event()
        person = vCalAddress('mailto:self@example.test')
        person.params['PARTSTAT'] = 'NEEDS-ACTION'
        other = vCalAddress('mailto:other@example.test')
        other.params['PARTSTAT'] = 'ACCEPTED'
        event.add('attendee', person)
        event.add('attendee', other)
        self.assertEqual(service.attendee_response(event, ['mailto:self@example.test']), 'NEEDS-ACTION')
        self.assertIsNone(service.attendee_response(event, ['mailto:missing@example.test']))
        self.assertIsNone(service.attendee_response(event, []))
        person.params['PARTSTAT'] = 'ACCEPTED'
        self.assertEqual(service.attendee_response(event, ['MAILTO:SELF@EXAMPLE.TEST']), 'ACCEPTED')

    def feishu_identity_fixture(self):
        db.execute("UPDATE calendar_accounts SET url='https://caldav.feishu.cn/',user_addresses=? WHERE id='a'", ('["mailto:self@example.test"]',))
        db.execute("UPDATE calendars SET title='本人' WHERE id='c'")
        primary = ical('Identity').replace('SUMMARY:Identity', 'SUMMARY:Identity\r\nATTENDEE;CN=本人;PARTSTAT=ACCEPTED:mailto:self@example.test')
        alias = ical('Work').replace('UID:weekly','UID:work').replace('SUMMARY:Work', 'SUMMARY:Work\r\nATTENDEE;CN=本人;PARTSTAT=NEEDS-ACTION:mailto:noreply_internal@calendar.feishu.cn\r\nATTENDEE;CN=别人;PARTSTAT=ACCEPTED:mailto:other@calendar.feishu.cn')
        service.apply_resources('c',[dict(href='identity',ical=primary),dict(href='work',ical=alias),dict(href='corroboration',ical=alias.replace('UID:work','UID:corroboration'))])
        return primary,alias

    def test_feishu_email_and_unique_internal_address_match(self):
        self.feishu_identity_fixture()
        resolved=service.calendar_user_addresses('c',['mailto:self@example.test'])
        self.assertEqual(set(resolved),{'mailto:self@example.test','mailto:noreply_internal@calendar.feishu.cn'})
        events=service.range_data(self.start,self.end)['events']
        work=[e for e in events if e['uid']=='work']
        self.assertTrue(work)
        self.assertTrue(all(e['response_status']=='NEEDS-ACTION' for e in work),'Another participant accepting must not affect me')
        db.execute("UPDATE calendar_events SET response_status=NULL")
        service.refresh_response_statuses('c')
        self.assertTrue(all(e['response_status']=='NEEDS-ACTION' for e in db.query("SELECT * FROM calendar_events WHERE uid='work'")))

    def test_feishu_alias_ambiguity_and_identity_failure_remain_unknown(self):
        primary,alias=self.feishu_identity_fixture()
        extra=alias.replace('UID:work','UID:imposter').replace('noreply_internal@','noreply_other@')
        service.apply_resources('c',[dict(href='imposter',ical=extra)])
        self.assertEqual(service.calendar_user_addresses('c',['mailto:self@example.test']),['mailto:self@example.test'])
        service.apply_resources('c',[],deleted=['imposter'])
        db.execute("UPDATE calendars SET title='另一个日历'")
        self.assertEqual(service.calendar_user_addresses('c',['mailto:self@example.test']),['mailto:self@example.test'])
        db.execute("UPDATE calendars SET title='本人'")
        db.execute("UPDATE calendar_accounts SET url='https://unrelated.example.test/'")
        self.assertEqual(service.calendar_user_addresses('c',['mailto:self@example.test']),['mailto:self@example.test'])
        self.assertEqual(service.calendar_user_addresses('c',[]),[])

    def test_empty_incremental_sync_refreshes_identity_and_cached_states(self):
        self.feishu_identity_fixture()
        db.execute("UPDATE calendar_accounts SET user_addresses='[\"mailto:old@example.test\"]'")
        db.execute("UPDATE calendar_events SET response_status=NULL")
        class Client:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def principal(self):return self
            def calendar_user_address_set(self):return ['mailto:self@example.test']
        manager=service.SyncManager()
        with patch.object(service,'client_for',return_value=Client()),patch.object(service,'bound_requests'),patch('caldav.Calendar'),patch.object(service,'read_calendar',return_value=([],set(),'next',False)):
            manager.run()
        self.assertFalse(manager.status['error'])
        self.assertTrue(all(e['response_status']=='NEEDS-ACTION' for e in db.query("SELECT * FROM calendar_events WHERE uid='work'")))
        self.assertEqual(db.one("SELECT sync_token FROM calendars WHERE id='c'")['sync_token'],'next')

    def test_response_status_survives_expansion_and_updates(self):
        raw = ical().replace('SUMMARY:Weekly', 'SUMMARY:Weekly\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:self@example.test')
        db.execute('UPDATE calendar_accounts SET user_addresses=? WHERE id=?', ('["mailto:self@example.test"]','a'))
        events = self.remote(raw)
        self.assertEqual(events[0]['response_status'], 'NEEDS-ACTION')
        changed = self.remote(raw.replace('PARTSTAT=NEEDS-ACTION','PARTSTAT=ACCEPTED'))
        self.assertEqual(changed[0]['response_status'],'ACCEPTED')
        self.assertEqual(events[0]['id'],changed[0]['id'])

    def test_many_to_many_quotes_deletion_and_restore(self):
        e=self.local();other=self.local('Other');db.create_session('r','Recording','',kind='meeting')
        service.link(e['id'],'r');service.link(e['id'],'r');service.link(other['id'],'r')
        self.assertEqual(len(service.record_events('r')),2)
        q=service.quote(e['id'],'r',128,'Quoted snapshot',0)
        self.assertIn('Quoted snapshot',q['notes']);self.assertEqual(q['quotes'][0]['available'],1)
        self.client.delete(f"/api/calendar/events/{e['id']}");self.assertEqual(len(service.record_events('r')),1)
        self.client.post(f"/api/calendar/events/{e['id']}/restore");self.assertEqual(len(service.record_events('r')),2)
        db.delete_session('r');self.assertEqual(service.event_detail(e['id'])['quotes'][0]['available'],0)
        self.assertIn('Quoted snapshot',service.export(e['id']))

    def test_recurrence_reschedule_keeps_identity_and_notes(self):
        first=self.remote();self.assertEqual(len(first),3);eid=first[0]['id'];service.save_notes(eid,'Preserve',0)
        second=self.remote(ical(exception=True));moved=next(e for e in second if e['id']==eid)
        self.assertEqual(moved['start_date'],'2026-10-21');self.assertEqual(moved['notes'],'Preserve')
        self.assertEqual(len(self.remote(ical(exception=True))),3)

    def test_nonrecurring_event_does_not_get_recurrence_style(self):
        raw = ical().replace('RRULE:FREQ=WEEKLY;COUNT=3\r\n', '')
        events = self.remote(raw)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['is_recurring'], 0)

    def test_repeated_range_reuses_parsed_calendar_and_sees_updates(self):
        self.assertEqual(len(self.remote()),3)
        service._PARSED.clear()
        with patch('calendar_service.validate_ical',wraps=service.validate_ical) as parse:
            service.range_data(self.start,self.end);service.range_data(self.start,self.end)
        self.assertEqual(parse.call_count,1)
        changed=ical().replace('RRULE:FREQ=WEEKLY;COUNT=3','RRULE:FREQ=WEEKLY;COUNT=2')
        events=self.remote(changed)
        self.assertEqual([e['remote_deleted'] for e in events],[0,0,1])

    def test_excluded_recurrence_and_all_day_cross_month(self):
        raw=ical().replace('RRULE:FREQ=WEEKLY;COUNT=3','RRULE:FREQ=WEEKLY;COUNT=3\r\nEXDATE;TZID=Asia/Shanghai:20261027T100000')
        self.assertEqual(len(self.remote(raw)),2)
        all_day='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:all\r\nDTSTART;VALUE=DATE:20261031\r\nDTEND;VALUE=DATE:20261102\r\nSUMMARY:Across\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'
        e=self.remote(all_day)[0];self.assertEqual(e['all_day'],1);self.assertEqual(e['end_date'],'2026-11-01')

    def test_invalid_response_preserves_previous_calendar(self):
        old=self.remote();service.save_notes(old[0]['id'],'Keep',0)
        with self.assertRaises(Exception):service.apply_resources('c',[{'href':'broken','ical':'not-calendar'}],full=True)
        self.assertEqual(db.one("SELECT removed FROM calendar_resources WHERE href='h'")['removed'],0)
        self.assertEqual(service.event_detail(old[0]['id'])['notes'],'Keep')

    def test_confirmed_delete_cancel_disconnect_and_readonly(self):
        e=self.remote()[0];service.save_notes(e['id'],'Keep',0)
        self.assertEqual(self.client.delete('/api/calendar/events/'+e['id']).status_code,409)
        service.apply_resources('c',[],deleted=['h'],token='next');self.assertEqual(service.event_detail(e['id'])['remote_deleted'],1)
        self.assertEqual(service.event_detail(e['id'])['notes'],'Keep')
        self.remote(ical(cancel=True));self.assertEqual(service.event_detail(e['id'])['cancelled'],1)
        self.client.delete('/api/calendar/account');self.assertEqual(service.range_data(self.start,self.end)['events'],[])

    def test_sync_manager_incremental_and_partial_response(self):
        self.remote();before=db.one("SELECT ical FROM calendar_resources WHERE href='h'")['ical']
        class Resource:
            class ResourceURL:
                def canonical(self): return 'h'
            url = ResourceURL()
            props = {}
            _data = ical('Changed')
            @property
            def data(self): raise AssertionError('Must never trigger per-resource GET')
        class Client:
            def request(self, *args, **kwargs): raise AssertionError('Fixture request')
            def __enter__(self):return self
            def __exit__(self,*args):pass
        class Calendar:
            def __init__(self,**kwargs):pass
            def get_objects_by_sync_token(self,*args,**kwargs):
                assert kwargs['load_objects'] is False
                return Result([Resource()])
            def multiget(self, urls, raise_notfound=False):
                assert not raise_notfound
                return [Resource()]
        class Result(list):
            sync_token='next'
            deleted_urls=set()
            truncated=False
        db.execute("UPDATE calendars SET sync_token='old'")
        manager=service.SyncManager()
        with patch.object(service,'client_for',return_value=Client()),patch('caldav.Calendar',Calendar),patch.object(service,'read_multiget',return_value=([Resource()],set())):manager.run()
        self.assertEqual(db.one("SELECT sync_token FROM calendars WHERE id='c'")['sync_token'],'next')
        self.assertIn('Changed',db.one("SELECT ical FROM calendar_resources WHERE href='h'")['ical'])
        Result.truncated=True
        with patch.object(service,'client_for',return_value=Client()),patch('caldav.Calendar',Calendar),patch.object(service,'read_multiget',return_value=([Resource()],set())):manager.run()
        self.assertTrue(manager.status['error'])
        self.assertEqual(db.one("SELECT removed FROM calendar_resources WHERE href='h'")['removed'],0)

    def test_feishu_multiget_property_404_and_resource_tombstone(self):
        from caldav.lib.url import URL
        from lxml import etree
        from xml.sax.saxutils import escape
        body = ('<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
                '<d:response><d:href>/calendar/live.ics</d:href>'
                '<d:propstat><d:prop><c:calendar-data>'+escape(ical())+'</c:calendar-data><d:getetag>v1</d:getetag></d:prop>'
                '<d:status>HTTP/1.1 200 OK</d:status></d:propstat>'
                '<d:propstat><d:prop><c:schedule-tag/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>'
                '<d:response><d:href>/calendar/deleted.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response></d:multistatus>')
        class Client:
            def request(self,url,method,body,headers):
                self.asserted = method == 'REPORT' and 'schedule-tag' not in body
                return SimpleNamespace(status=207,tree=etree.fromstring(body_response.encode()))
        body_response = body
        client=Client();calendar=SimpleNamespace(client=client,url=URL('https://example.test/calendar/'))
        objects=[SimpleNamespace(url=URL('https://example.test/calendar/'+name)) for name in ['live.ics','deleted.ics']]
        loaded,deleted=service.read_multiget(calendar,objects)
        self.assertTrue(client.asserted);self.assertEqual(len(loaded),1)
        service.validate_ical(loaded[0]._data)
        self.assertEqual(deleted,{str(objects[1].url.canonical())})

    def test_multiget_missing_body_is_not_treated_as_optional_property(self):
        from lxml import etree
        from caldav.lib.url import URL
        body='<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/h</d:href><d:propstat><d:prop><c:calendar-data/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response></d:multistatus>'
        client=SimpleNamespace(request=lambda *args,**kwargs:SimpleNamespace(status=207,tree=etree.fromstring(body.encode())))
        calendar=SimpleNamespace(client=client,url=URL('https://example.test/'))
        with self.assertRaises(service.CalendarReadError):service.read_multiget(calendar,[SimpleNamespace(url=URL('https://example.test/h'))])

    def test_requests_are_bounded_before_retry(self):
        from unittest.mock import Mock
        client=SimpleNamespace(request=Mock(return_value=None))
        service.bound_requests(client,seconds=0)
        with self.assertRaises(service.CalendarReadError):client.request('https://example.test/',method='REPORT')
        self.assertFalse(client.rate_limit_handle)

    def test_batch_and_meeting_create_links_to_event(self):
        e=self.local()
        with patch('scheduler.start'),patch('asr_engines.ready',return_value=True),patch.dict('capture.DEPS',{'ffmpeg':True}):
            path=Path(DATA.name)/'record.wav';path.write_bytes(b'WAVE' + b'0'*40)
            r=self.client.post('/api/meetings/import',json={'path':str(path),'calendar_event_id':e['id']})
            self.assertEqual(r.status_code,200,r.text);self.assertEqual(len(service.record_events(r.json()['id'])),1)
            batch=self.client.post('/api/link-videos/batch',json={'calendar_event_id':e['id'],'items':[{'url':'https://www.youtube.com/watch?v=abc12345678'},{'url':'https://www.youtube.com/watch?v=def12345678'}]})
            self.assertEqual(batch.status_code,200,batch.text)
            created=[x['id'] for x in batch.json()['results'] if x.get('id')]
            self.assertEqual(len(created),2)
            for sid in created:self.assertEqual(len(service.record_events(sid)),1)

    def test_wire_caldav_full_history_read(self):
        """Exercise the installed CalDAV client against a local HTTP protocol fixture."""
        import caldav
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        import threading
        from xml.sax.saxutils import escape
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_REPORT(self):
                self.rfile.read(int(self.headers.get('content-length',0)))
                body = ('<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
                        '<D:response><D:href>/calendar/history.ics</D:href><D:propstat><D:prop>'
                        '<D:getetag>"history-v1"</D:getetag><C:calendar-data>'+escape(ical())+'</C:calendar-data>'
                        '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>').encode()
                self.send_response(207);self.send_header('Content-Type','application/xml');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with caldav.DAVClient(url=f'http://127.0.0.1:{server.server_port}/calendar/',require_tls=False,enable_rfc6764=False) as client:
                calendar=caldav.Calendar(client=client,url=f'http://127.0.0.1:{server.server_port}/calendar/')
                objects=calendar.get_events()
                self.assertEqual(len(objects),1);service.validate_ical(objects[0].data)
        finally:server.shutdown();server.server_close();thread.join()

    def test_creation_links_date_and_duplicate_rules(self):
        e=self.local();r=self.client.post('/api/sessions',json={'title':'Recording','calendar_event_id':e['id']});self.assertEqual(r.status_code,200)
        sid=r.json()['id'];self.assertEqual(len(service.record_events(sid)),1)
        db.update_session(sid,status='done');db.update_session(sid,calendar_date='2026-09-01')
        with patch.object(main.sessions,'is_running',return_value=False): copied=self.client.post(f'/api/sessions/{sid}/duplicate').json()['id']
        self.assertEqual(service.record_events(copied),[]);self.assertIsNone(db.get_session(copied)['calendar_date'])
        self.assertEqual(self.client.patch(f'/api/calendar/sessions/{sid}/date',json={'date':'bad'}).status_code,400)


if __name__=='__main__':unittest.main()
