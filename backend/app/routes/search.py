from typing import Literal
from fastapi import APIRouter, Query
import search_service
import calendar_search

router = APIRouter(prefix='/api/search')

@router.get('')
def search(q: str = Query('',max_length=500), type: Literal['all','live','link_video','meeting','calendar']='all',
           offset: int = Query(0,ge=0), limit: int = Query(50,ge=1,le=50)):
    return search_service.search(q,type,offset,limit)

@router.get('/calendar/{key}')
def resolve_calendar(key: str):
    return calendar_search.resolve(key)
