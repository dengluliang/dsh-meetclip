"""Bound SQL predicates for record scopes without expanding linked IDs in Python."""


def record_condition(scope, alias='s'):
    if not scope or scope.get('mode') == 'all':
        return '1', []
    record_ids = scope.get('record_ids', [])
    event_ids = scope.get('event_ids', [])
    if event_ids:
        query = 'SELECT session_id FROM calendar_links WHERE event_id IN ('+','.join('?' for identifier in event_ids)+')'
        query += ' UNION SELECT ?'*len(record_ids)
        return alias+'.id IN ('+query+')', [*event_ids, *record_ids]
    if record_ids:
        return alias+'.id IN ('+','.join('?' for identifier in record_ids)+')', list(record_ids)
    return '0', []
