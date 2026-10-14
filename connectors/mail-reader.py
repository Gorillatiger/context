"""Read unread envelope headers over TLS; never fetch bodies or mutate flags."""
import os
import sys
import json
import ssl
import imaplib
import re
import email
from email.header import decode_header, make_header
from email.utils import parsedate_to_datetime

def decoded(value):
    try:
        return str(make_header(decode_header(value or '')))[:300]
    except Exception:
        return str(value or '')[:300]

def main():
    client = None
    try:
        client = imaplib.IMAP4_SSL('imap.intranet.th-koeln.de', 993,
                                  ssl_context=ssl.create_default_context(), timeout=12)
        client.login(os.environ['TH_MAIL_USER'], os.environ['TH_MAIL_PASSWORD'])
        status, _ = client.select('INBOX', readonly=True)
        if status != 'OK':
            raise ValueError('Mailbox unavailable')
        validity = (client.response('UIDVALIDITY')[1] or [b''])[0].decode('ascii', 'ignore')
        status, result = client.uid('search', None, 'UNSEEN')
        if status != 'OK':
            raise ValueError('Search failed')
        items = []
        for uid in result[0].split()[-50:]:
            if not re.fullmatch(rb'[0-9]+', uid):
                continue
            status, rows = client.uid('fetch', uid,
                '(BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE)])')
            if status != 'OK':
                continue
            headers = next((row[1] for row in rows if isinstance(row, tuple)), b'')
            message = email.message_from_bytes(headers)
            try:
                date = parsedate_to_datetime(message.get('Date', '')).isoformat()
            except Exception:
                date = ''
            items.append({'uid': uid.decode('ascii'), 'subject': decoded(message.get('Subject')),
                          'sender': decoded(message.get('From')), 'date': date})
        print(json.dumps({'uidValidity': validity, 'items': items}, ensure_ascii=False))
    except Exception:
        print(json.dumps({'error': 'connection_failed'}))
        sys.exit(1)
    finally:
        if client is not None:
            try:
                client.logout()
            except Exception:
                pass

if __name__ == '__main__':
    main()
