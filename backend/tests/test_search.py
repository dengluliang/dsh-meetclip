"""Global search tests use a disposable database; no personal calendar or network."""
import os
import sys
import tempfile
import unittest
import json
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

DATA = tempfile.TemporaryDirectory(prefix='meetclip-search-')
os.environ['ZHIBO_DATA_DIR'] = DATA.name
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'app'))
from database import db, DB
import main
import auth
import calendar_service as calendar
import calendar_search
from fastapi.testclient import TestClient

class SearchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client=TestClient(main.app,base_url='http://127.0.0.1',headers={'X-MeetClip-Token':auth.API_TOKEN})
    def setUp(self):
        for table in ['calendar_quotes','calendar_links','calendar_events','calendar_search_text','calendar_resources','calendars','calendar_accounts','transcripts','screenshots','marks','session_minutes','sessions']:
            db.execute(f'DELETE FROM {table}')
        db.execute("INSERT INTO calendar_accounts(id,url,username) VALUES('a','https://example.test','hidden')")
        db.execute("INSERT INTO calendars(id,account_id,url,title) VALUES('c','a','https://example.test/c','Work')")
    def record(self,id,kind='live',title='普通记录',notes='',created=1):
        db.execute('INSERT INTO sessions(id,title,kind,created_at,notes,source_url,meta) VALUES(?,?,?,?,?,?,?)',
                   (id,title,kind,created,notes,'https://source.example/test',json.dumps({'speakers':{'S1':'自定义张三'}})))
    def event(self,title='普通日程',notes=''):
        return calendar.local_event(dict(title=title,start=100,end=200,all_day=False,start_date='1970-01-01',end_date='1970-01-01',timezone='Asia/Shanghai',location='研发中心',description='日程详细说明',cancelled=False))
    def search(self,q,**args):
        r=self.client.get('/api/search',params=dict(q=q,**args));self.assertEqual(r.status_code,200,r.text);return r.json()
    def raw(self,title='跨月公共标题',rule='RRULE:FREQ=WEEKLY;COUNT=3\n',exception=''):
        return ('BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:weekly\nDTSTART;TZID=Asia/Shanghai:20250101T100000\nDTEND;TZID=Asia/Shanghai:20250101T110000\n'+rule+'SUMMARY:'+title+'\nDESCRIPTION:未展开的历史说明\nEND:VEVENT\n'+exception+'END:VCALENDAR\n').replace('\n','\r\n')
    def test_four_types_dedup_counts_ranking_and_saved_text(self):
        self.record('a','live','机器人标题',created=1)
        self.record('b','meeting',notes='会议笔记机器人',created=20)
        self.record('c','link_video',created=30)
        db.execute("INSERT INTO transcripts(session_id,start,end,text,created_at) VALUES('c',12,15,'机器人 Robot ROBOT',0)")
        db.execute("INSERT INTO marks(session_id,ts,note,created_at) VALUES('c',14,'机器人标记',0)")
        db.execute("INSERT INTO screenshots(session_id,ts,path,ocr_text,created_at) VALUES('a',3,'a.png','机器人截图',0)")
        self.event('机器人日程')
        r=self.search('机器人');self.assertEqual(r['total'],4)
        self.assertEqual(r['counts'],dict(live=1,meeting=1,link_video=1,calendar=1))
        self.assertEqual(r['results'][0]['kind'],'calendar')
        self.assertEqual(r['results'][1]['id'],'session:a')
        self.assertEqual(r['results'][2]['field'],'notes')
        c=r['results'][3];self.assertEqual(c['match_count'],2);self.assertEqual(c['target']['time'],12)
        self.assertIn('机器人',c['snippet'])
        self.assertEqual(self.search('robot')['results'][0]['match_count'],2)
        self.assertEqual(self.search('机器人',type='meeting')['total'],1)
        self.assertEqual(self.search('自定义张三')['total'],3)
        self.assertEqual(self.search('source.example')['results'][0]['field'],'source')
    def test_minutes_json_is_searchable_until_materialized(self):
        self.record('m','meeting','预算评审',created=5)
        db.execute("INSERT INTO session_minutes(session_id,data,covered,kind,lang,state,updated_at,version) "
                   "VALUES('m',?,0,'final','Simplified Chinese','idle',0,1)",
                   (json.dumps({'summary':'预算缺口二十万','topics':[{'title':'预算','summary':'讨论缺口',
                                'points':[{'text':'人力多招了两人'}]}],
                                'todos':[{'text':'补一份预算表'}]},ensure_ascii=False),))
        r=self.search('预算缺口')
        hit=[x for x in r['results'] if x['id']=='session:m'][0]
        self.assertEqual(hit['field'],'minutes')
        self.assertEqual(hit['field_label'],'纪要')
        self.assertIn('预算缺口',hit['snippet'])
        # 纪要写进笔记后只算一处，不重复计数。
        db.execute("UPDATE sessions SET notes=? WHERE id='m'",
                   ('<!-- meetclip:minutes:begin -->\n预算缺口二十万\n<!-- meetclip:minutes:end -->\n',))
        r=self.search('预算缺口')
        hit=[x for x in r['results'] if x['id']=='session:m'][0]
        self.assertEqual(hit['field'],'notes')
        self.assertEqual(hit['match_count'],1)

    def test_literal_special_characters_and_utf16_ranges(self):
        self.record('a',notes='😀 100%_Case 保留')
        for word in ['%','_','100%_case']:
            self.assertEqual(self.search(word)['total'],1)
        target=self.search('100%')['results'][0]['target'];self.assertEqual(target['text_start'],3);self.assertEqual(target['text_length'],4)
        self.assertEqual(self.search('hidden')['total'],0)
    def test_pagination_complete_counts_and_auth(self):
        for n in range(61):self.record(str(n),title='分页',created=n)
        a=self.search('分页');b=self.search('分页',offset=50)
        self.assertEqual((len(a['results']),len(b['results'])),(50,11));self.assertEqual(a['counts']['live'],61)
        self.assertFalse(set(x['id'] for x in a['results'])&set(x['id'] for x in b['results']))
        self.assertEqual(self.client.get('/api/search',params={'q':'分页'},headers={'X-MeetClip-Token':'bad'}).status_code,401)
        self.assertEqual(self.client.get('/api/search',params={'q':'分页','limit':51}).status_code,422)
    def test_ocr_and_mark_navigation(self):
        self.record('a');db.execute("INSERT INTO marks(session_id,ts,note,created_at) VALUES('a',40,'唯独标记',0)")
        self.assertEqual(self.search('唯独')['results'][0]['target']['pane'],'mark')
        db.execute("INSERT INTO screenshots(session_id,ts,path,ocr_text,created_at) VALUES('a',55,'a.png','截图文字',0)")
        self.assertEqual(self.search('截图')['results'][0]['target']['pane'],'ocr')
    def test_history_resources_recurrence_and_offline_without_sync(self):
        calendar.apply_resources('c',[dict(href='h',etag='1',ical=self.raw())])
        self.assertEqual(len(db.query('SELECT * FROM calendar_events')),0)
        with patch.object(calendar,'client_for',side_effect=AssertionError('No network')):
            r=self.search('跨月');self.assertEqual(r['total'],1)
            self.assertEqual(len(db.query('SELECT * FROM calendar_events')),0,'Search must not materialize')
            target=calendar_search.resolve(r['results'][0]['target']['resource_id'],now=datetime(2025,1,5,tzinfo=calendar.TZ))
            self.assertEqual(target['start_date'],'2025-01-08')
            calendar.expand_resources(datetime(2025,1,1,tzinfo=calendar.TZ).timestamp(),datetime(2025,2,1,tzinfo=calendar.TZ).timestamp())
            self.assertEqual(self.search('跨月')['total'],1)
            db.execute('UPDATE calendar_events SET notes=? WHERE id=?',('实例独立笔记',target['id']))
            notes=self.search('实例独立');self.assertEqual(notes['total'],1);self.assertEqual(notes['results'][0]['target']['event_id'],target['id'])
            db.execute('UPDATE calendar_accounts SET connected=0')
            self.assertTrue(self.search('跨月')['results'][0]['offline'])
            self.assertTrue(self.search('实例独立')['results'][0]['offline'])
    def test_exception_and_all_day_target(self):
        extra='BEGIN:VEVENT\nUID:weekly\nRECURRENCE-ID;TZID=Asia/Shanghai:20250108T100000\nDTSTART;TZID=Asia/Shanghai:20250109T140000\nDTEND;TZID=Asia/Shanghai:20250109T150000\nSUMMARY:例外改期\nEND:VEVENT\n'
        calendar.apply_resources('c',[dict(href='h',ical=self.raw(exception=extra))])
        r=self.search('例外');target=calendar_search.resolve(r['results'][0]['target']['resource_id'])
        self.assertEqual(target['start_date'],'2025-01-09')
        self.assertIn('2025-01-08',target['recurrence_id'])
        a=self.raw(title='全天历史',rule='').replace('DTSTART;TZID=Asia/Shanghai:20250101T100000','DTSTART;VALUE=DATE:20250101').replace('DTEND;TZID=Asia/Shanghai:20250101T110000','DTEND;VALUE=DATE:20250102')
        calendar.apply_resources('c',[dict(href='d',ical=a)])
        target=calendar_search.resolve(self.search('全天')['results'][0]['target']['resource_id'])
        self.assertEqual(target['all_day'],1);self.assertEqual(target['end_date'],'2025-01-01')
    def test_deletion_quotes_and_index_updates(self):
        e=self.event('可删除',notes='保留摘录');self.record('a')
        db.execute('INSERT INTO calendar_quotes VALUES(?,?,?,?,?,?)',('q',e['id'],'a','title',25,'引用快照'))
        self.assertEqual(self.search('引用')['results'][0]['target']['quote_id'],'q')
        db.execute('UPDATE calendar_events SET deleted=1 WHERE id=?',(e['id'],));self.assertEqual(self.search('可删除')['total'],0)
        calendar.apply_resources('c',[dict(href='h',ical=self.raw(title='旧标题',rule=''))])
        r=self.search('旧标题');key=r['results'][0]['target']['resource_id'];remote=calendar_search.resolve(key)
        db.execute('UPDATE calendar_events SET notes=? WHERE id=?',('保留远端笔记',remote['id']))
        calendar.apply_resources('c',[dict(href='h',ical=self.raw(title='新标题',rule=''))]);self.assertEqual(self.search('旧标题')['total'],0)
        calendar.apply_resources('c',[],deleted=['h'])
        self.assertEqual(self.search('新标题')['results'][0]['status'],'远端已删除 · 资料保留')
        self.assertEqual(self.client.get('/api/search/calendar/'+key).status_code,404)
        self.assertEqual(self.search('保留远端')['total'],1)
    def test_single_remote_event_metadata_and_notes_merge(self):
        calendar.apply_resources('c',[dict(href='h',ical=self.raw(title='共同命中',rule=''))])
        key=self.search('共同')['results'][0]['target']['resource_id']
        e=calendar_search.resolve(key)
        db.execute('UPDATE calendar_events SET notes=? WHERE id=?',('共同笔记',e['id']))
        result=self.search('共同')
        self.assertEqual(result['total'],1)
        self.assertEqual(result['results'][0]['match_count'],2)
        self.assertEqual(result['results'][0]['field'],'title')
        db.execute('INSERT INTO calendar_links VALUES(?,?)',(e['id'],'missing'))
        self.assertEqual(self.search('共同')['total'],1)

    def test_infinite_repeat_selects_future_and_respects_exdate(self):
        raw=self.raw(rule='RRULE:FREQ=WEEKLY\nEXDATE;TZID=Asia/Shanghai:20250108T100000\n')
        calendar.apply_resources('c',[dict(href='h',ical=raw)])
        key=self.search('跨月')['results'][0]['target']['resource_id']
        e=calendar_search.resolve(key,now=datetime(2025,1,5,tzinfo=calendar.TZ))
        self.assertEqual(e['start_date'],'2025-01-15')
        self.assertEqual(len(db.query('SELECT * FROM calendar_events')),1)

    def test_precomputed_targets_match_live_resolution(self):
        extra=('BEGIN:VEVENT\nUID:weekly\nRECURRENCE-ID;TZID=Asia/Shanghai:20250108T100000\nDTSTART;TZID=Asia/Shanghai:20250109T140000\n'
               'DTEND;TZID=Asia/Shanghai:20250109T150000\nSUMMARY:同源例外\nEND:VEVENT\n'
               'BEGIN:VEVENT\nUID:weekly\nRECURRENCE-ID;TZID=Asia/Shanghai:20250115T100000\nDTSTART;TZID=Asia/Shanghai:20250115T100000\n'
               'DTEND;TZID=Asia/Shanghai:20250115T110000\nSTATUS:CANCELLED\nSUMMARY:同源取消\nEND:VEVENT\n'
               'BEGIN:VEVENT\nUID:single\nDTSTART;TZID=Asia/Shanghai:20250120T100000\nDTEND;TZID=Asia/Shanghai:20250120T110000\n'
               'SUMMARY:同源单次\nEND:VEVENT\n')
        calendar.apply_resources('c',[dict(href='h',ical=self.raw(title='同源系列',exception=extra))])
        rows=db.query('SELECT * FROM calendar_search_text');self.assertEqual(len(rows),4)
        for row in rows:
            live=calendar_search.resolve(row['id'],materialize=False)
            if row['uid']=='weekly' and not row['recurrence_id']:
                self.assertIsNone(row['event_id'])
            else:
                self.assertEqual((row['event_id'],row['event_start'],bool(row['event_cancelled'])),(live['id'],live['start'],live['cancelled']))
        r=self.search('同源');self.assertEqual(r['total'],4)
        self.assertEqual({x['status'] for x in r['results']},{'重复日程','已取消',''})
        calendar._PARSED.clear()
        with patch('calendar_service.validate_ical',wraps=calendar.validate_ical) as parse:
            self.search('同源');self.search('同源')
        self.assertEqual(parse.call_count,1)

    def test_backfill_upgrades_old_index(self):
        calendar.apply_resources('c',[dict(href='h',ical=self.raw(title='升级',rule=''))])
        db.execute('UPDATE calendar_search_text SET event_id=NULL,event_start=NULL,event_cancelled=NULL')
        db.execute("UPDATE schema_meta SET value='1' WHERE key='calendar_search_version'")
        self.assertEqual(self.search('升级')['total'],1)
        calendar_search.backfill()
        self.assertIsNotNone(db.one('SELECT event_id FROM calendar_search_text')['event_id'])
        self.assertEqual(db.one("SELECT value FROM schema_meta WHERE key='calendar_search_version'")['value'],calendar_search.SEARCH_VERSION)

    def test_backfill_idempotent(self):
        db.execute('INSERT INTO calendar_resources VALUES(?,?,?,?,?)',('c','old','1',self.raw(),0))
        db.execute("DELETE FROM schema_meta WHERE key='calendar_search_version'")
        calendar_search.backfill();calendar_search.backfill()
        self.assertEqual(len(db.query('SELECT * FROM calendar_search_text')),1)
        other=DB(Path(DATA.name)/'old.db');other._migrate();self.assertIsNotNone(other.one("SELECT name FROM sqlite_master WHERE name='calendar_search_text'"))

if __name__=='__main__':unittest.main()
