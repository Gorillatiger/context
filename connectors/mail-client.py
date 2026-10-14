"""Bounded TH student-mail IMAP/SMTP adapter. One JSON request via stdin.

Credentials and messages stay in this process. Normal reads use read-only
selection and BODY.PEEK. TLS always verifies the certificate and hostname.
"""
import base64
import email
import imaplib
import json
import re
import smtplib
import ssl
import sys
import uuid
from email import policy
from email.message import EmailMessage
from email.utils import getaddresses, parsedate_to_datetime, format_datetime
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import urlsplit

MAX_MESSAGE = 12 * 1024 * 1024
MAX_ATTACHMENTS = 8 * 1024 * 1024
ADDRESS = re.compile(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}\Z")


class MailError(Exception):
    def __init__(self, code):
        self.code = code


def clean(value, maximum=300):
    return re.sub(r'[\x00-\x1f\x7f]', ' ', str(value or ''))[:maximum]


def address(value):
    if not isinstance(value, str) or len(value) > 254 or not ADDRESS.fullmatch(value):
        raise MailError('invalid_request')
    return value


def mailbox_id(raw):
    return base64.urlsafe_b64encode(raw.encode('ascii')).decode('ascii').rstrip('=')


def mailbox_raw(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,1024}', value):
        raise MailError('invalid_request')
    try:
        raw = base64.urlsafe_b64decode(value + '=' * (-len(value) % 4)).decode('ascii')
    except Exception:
        raise MailError('invalid_request')
    if not raw or len(raw) > 512 or re.search(r'[\x00-\x1f\x7f]', raw):
        raise MailError('invalid_request')
    return raw


def quoted(raw):
    return '"' + raw.replace('\\', '\\\\').replace('"', '\\"') + '"'


def folder_label(raw):
    def decode(match):
        if not match.group(1):
            return '&'
        try:
            encoded = match.group(1).replace(',', '/')
            return base64.b64decode(encoded + '=' * (-len(encoded) % 4)).decode('utf-16-be')
        except Exception:
            return match.group(0)
    return clean(re.sub(r'&([^-]*)-', decode, raw), 200)


def folders(client):
    status, rows = client.list()
    if status != 'OK':
        raise MailError('connection_failed')
    result = []
    for row in (rows or [])[:200]:
        # Literal mailbox names are not supported; they are never guessed.
        if not isinstance(row, bytes):
            continue
        match = re.fullmatch(rb'\(([^)]*)\)\s+(?:"(?:[^"\\]|\\.)*"|NIL)\s+(.*)', row)
        if not match:
            continue
        flags = match[1].lower().split()
        if b'\\noselect' in flags:
            continue
        name = match[2]
        if name.startswith(b'"') and name.endswith(b'"'):
            name = re.sub(rb'\\(.)', rb'\1', name[1:-1])
        try:
            raw = name.decode('ascii')
            if not raw or len(raw) > 512 or re.search(r'[\x00-\x1f\x7f]', raw):
                continue
        except UnicodeDecodeError:
            continue
        label = folder_label(raw)
        kind = ('inbox' if raw.upper() == 'INBOX' else
                'sent' if b'\\sent' in flags or label.lower().split('/')[-1] in ('sent', 'sent items', 'gesendet', 'sent-mail') else
                'drafts' if b'\\drafts' in flags or label.lower().split('/')[-1] in ('drafts', 'entwürfe') else
                'trash' if b'\\trash' in flags or label.lower().split('/')[-1] in ('trash', 'papierkorb') else
                'junk' if b'\\junk' in flags or label.lower().split('/')[-1] in ('junk', 'spam') else 'folder')
        result.append({'id': mailbox_id(raw), 'label': {'inbox':'Posteingang','sent':'Gesendet','drafts':'Entwürfe','trash':'Papierkorb','junk':'Spam'}.get(kind,label), 'kind': kind})
    return sorted(result, key=lambda f: (f['kind'] != 'inbox', f['kind'] != 'sent', f['label'].casefold()))


def select(client, folder, expected=None, readonly=True):
    status, total = client.select(quoted(mailbox_raw(folder)), readonly=readonly)
    if status != 'OK':
        raise MailError('folder_unavailable')
    data = client.response('UIDVALIDITY')[1] or []
    validity = data[0].decode('ascii') if data and isinstance(data[0], bytes) else ''
    if not re.fullmatch(r'\d{1,20}', validity):
        raise MailError('connection_failed')
    if expected is not None and expected != validity:
        raise MailError('mailbox_changed')
    return validity, int(total[0] or b'0')


def uid_value(value):
    if not isinstance(value, str) or not re.fullmatch(r'[1-9][0-9]{0,19}', value):
        raise MailError('invalid_request')
    return value


def literal(rows):
    return next((row[1] for row in rows or [] if isinstance(row, tuple) and isinstance(row[1], bytes)), None)


def envelope(message):
    try:
        date = parsedate_to_datetime(str(message.get('Date', ''))).isoformat()
    except Exception:
        date = ''
    people = lambda field: [{'name': clean(n, 200), 'address': clean(a, 254)} for n, a in getaddresses([str(message.get(field, ''))]) if a][:50]
    return {'subject': clean(message.get('Subject')) or '(Kein Betreff)',
            'sender': clean(message.get('From')), 'from': people('From'),
            'to': people('To'), 'cc': people('Cc'), 'replyTo': people('Reply-To'),
            'date': date, 'messageId': clean(message.get('Message-ID'), 500)}


class PlainHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocked = []
        self.parts = []
        self.links = []

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'head', 'iframe', 'object', 'svg', 'template'):
            self.blocked.append(tag)
        if not self.blocked and tag in ('p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'blockquote'):
            self.parts.append('\n')
        if not self.blocked and tag == 'a':
            link = dict(attrs).get('href') or ''
            try:
                parsed = urlsplit(link)
                self.links.append(link if len(link) <= 2048 and parsed.scheme == 'https' and parsed.hostname and not parsed.username and not parsed.password and not re.search(r'[\x00-\x1f\x7f]', link) else '')
            except Exception:
                self.links.append('')
        if not self.blocked and tag == 'img' and dict(attrs).get('alt'):
            self.parts.append('[' + dict(attrs)['alt'][:500] + ']')

    def handle_endtag(self, tag):
        if self.blocked and self.blocked[-1] == tag:
            self.blocked.pop()
        elif not self.blocked and tag in ('p', 'div', 'li', 'tr', 'blockquote'):
            self.parts.append('\n')
        if not self.blocked and tag == 'a' and self.links:
            link = self.links.pop()
            if link:
                self.parts.append(' <' + link + '>')

    def handle_data(self, data):
        if not self.blocked:
            self.parts.append(data)


def body_text(part):
    data = part.get_payload(decode=True) or b''
    charset = part.get_content_charset() or 'utf-8'
    try:
        text = data.decode(charset, errors='replace')
    except LookupError:
        text = data.decode('utf-8', errors='replace')
    if part.get_content_type() == 'text/html':
        parser = PlainHTML()
        parser.feed(text)
        text = ''.join(parser.parts)
        text = re.sub(r'\n[ \t]*\n(?:[ \t]*\n)+', '\n\n', text)
    return text.replace('\x00', '')


def attachment_name(part):
    name = str(part.get_filename() or 'Anhang')
    return clean(name.replace('\\', '/').split('/')[-1], 180) or 'Anhang'


def is_attachment(part):
    return bool(part.get_content_disposition() == 'attachment' or part.get_filename() or
                not part.is_multipart() and part.get_content_type() not in ('text/plain', 'text/html') or
                part.get_content_type() == 'message/rfc822')


def attachment_data(part):
    if part.get_content_type() == 'message/rfc822' and isinstance(part.get_payload(), list):
        return b'\r\n'.join(p.as_bytes(policy=policy.SMTP) for p in part.get_payload())
    return part.as_bytes(policy=policy.SMTP) if part.is_multipart() else part.get_payload(decode=True) or b''


def parse_message(raw):
    if len(raw) > MAX_MESSAGE:
        raise MailError('message_too_large')
    message = email.message_from_bytes(raw, policy=policy.default)
    all_parts = list(message.walk())
    parts = all_parts[:200]
    attachments = []
    bodies = {}
    blocked = set()
    for index, part in enumerate(parts):
        if id(part) in blocked:
            continue
        if is_attachment(part):
            attachments.append({'part': str(index), 'name': attachment_name(part),
                                'size': len(attachment_data(part)), 'type': clean(part.get_content_type(), 100)})
            if part.is_multipart():
                blocked.update(id(child) for child in list(part.walk())[1:])
        elif part.is_multipart():
            continue
        elif part.get_content_type() in ('text/plain', 'text/html'):
            text = body_text(part)
            if text.strip():
                bodies[id(part)] = (text, part.get_content_type() == 'text/html')

    allowed = {id(part) for part in parts}
    def readable(part):
        if id(part) not in allowed or id(part) in blocked or is_attachment(part):
            return '', False
        if not part.is_multipart():
            return bodies.get(id(part), ('', False))
        candidates = [(child, readable(child)) for child in part.get_payload()]
        candidates = [(child, result) for child, result in candidates if result[0].strip()]
        if part.get_content_subtype() == 'alternative':
            # These are representations of the same body, not additional sections.
            # A blank plain alternative must not suppress useful converted HTML.
            for child, result in candidates:
                if child.get_content_type() == 'text/plain' or not result[1]:
                    return result
            return candidates[0][1] if candidates else ('', False)
        # In mixed/related messages, distinct readable sections all matter.
        return '\n\n'.join(result[0] for _, result in candidates), any(result[1] for _, result in candidates)

    text, converted_html = readable(message)
    return {**envelope(message), 'text': text[:200000], 'truncated': len(text) > 200000, 'partsLimited': len(all_parts) > 200,
            'convertedHTML': converted_html, 'attachments': attachments}


def raw_message(client, uid):
    status, rows = client.uid('fetch', uid, '(RFC822.SIZE)')
    info = b' '.join(row for row in rows or [] if isinstance(row, bytes))
    match = re.search(rb'RFC822.SIZE\s+(\d+)', info)
    if status != 'OK' or not match:
        raise MailError('message_unavailable')
    if int(match[1]) > MAX_MESSAGE:
        raise MailError('message_too_large')
    status, rows = client.uid('fetch', uid, '(BODY.PEEK[])')
    raw = literal(rows)
    if status != 'OK' or raw is None:
        raise MailError('message_unavailable')
    if len(raw) > MAX_MESSAGE:
        raise MailError('message_too_large')
    return raw


def message_list(client, request):
    validity, total = select(client, request['folder'])
    query = request.get('query', '')
    if not isinstance(query, str) or len(query) > 200 or re.search(r'[\x00-\x1f\x7f]', query):
        raise MailError('invalid_request')
    criteria = ['UNSEEN' if request.get('unread') else 'ALL']
    if query:
        # IMAP literals keep UTF-8 searches separate from the command syntax.
        client.literal = query.encode('utf-8')
        # imaplib emits literals at the end; use one TEXT criterion, optionally UNSEEN.
        criteria = (['UNSEEN'] if request.get('unread') else []) + ['TEXT']
    try:
        status, rows = client.uid('search', *(['CHARSET', 'UTF-8'] if query else []), *criteria)
    except imaplib.IMAP4.error:
        raise MailError('search_failed')
    if status != 'OK':
        raise MailError('search_failed')
    uids = [uid for uid in (rows[0] or b'').split() if re.fullmatch(rb'[1-9][0-9]{0,19}', uid)]
    uids.reverse()
    offset = request.get('offset', 0)
    if not isinstance(offset, int) or isinstance(offset, bool) or not 0 <= offset <= 10000000:
        raise MailError('invalid_request')
    items = []
    batch = uids[offset:offset + 40]
    if batch:
        status, rows = client.uid('fetch', b','.join(batch), '(UID FLAGS RFC822.SIZE BODY.PEEK[HEADER.FIELDS (SUBJECT FROM TO CC REPLY-TO DATE MESSAGE-ID)])')
        if status != 'OK':
            raise MailError('connection_failed')
        for row in rows or []:
            if not isinstance(row, tuple) or not isinstance(row[0], bytes) or not isinstance(row[1], bytes):
                continue
            match = re.search(rb'UID\s+(\d+)', row[0])
            if not match or match[1] not in batch or len(row[1]) > 65536:
                continue
            flags = re.search(rb'FLAGS\s+\(([^)]*)\)', row[0])
            size = re.search(rb'RFC822.SIZE\s+(\d+)', row[0])
            items.append({'uid': match[1].decode('ascii'), 'unread': not flags or b'\\Seen' not in flags[1].split(),
                          'size': int(size[1]) if size else 0,
                          **envelope(email.message_from_bytes(row[1], policy=policy.default))})
    order = {uid.decode('ascii'): i for i, uid in enumerate(batch)}
    items.sort(key=lambda item: order[item['uid']])
    return {'folder': request['folder'], 'uidValidity': validity, 'items': items,
            'total': total, 'matched': len(uids), 'offset': offset,
            'nextOffset': offset + 40 if offset + 40 < len(uids) else None}


def draft_message(request, sender):
    draft = request.get('draft', {})
    if not isinstance(draft, dict):
        raise MailError('invalid_request')
    recipients = {}
    for field in ('to', 'cc', 'bcc'):
        values = draft.get(field, [])
        if not isinstance(values, list) or len(values) > 50:
            raise MailError('invalid_request')
        recipients[field] = [address(v) for v in values]
    all_recipients = list(dict.fromkeys(recipients['to'] + recipients['cc'] + recipients['bcc']))
    subject, text = draft.get('subject'), draft.get('text')
    if not recipients['to'] or len(all_recipients) > 50 or not isinstance(subject, str) or not subject.strip() or len(subject) > 300 or re.search(r'[\x00-\x1f\x7f]', subject) or not isinstance(text, str) or not text.strip() or len(text) > 100000 or '\x00' in text:
        raise MailError('invalid_request')
    message = EmailMessage(policy=policy.SMTP)
    message['From'] = address(sender)
    message['To'] = ', '.join(recipients['to'])
    if recipients['cc']:
        message['Cc'] = ', '.join(recipients['cc'])
    message['Subject'] = subject
    message['Date'] = format_datetime(datetime.now(timezone.utc))
    message['Message-ID'] = '<' + uuid.uuid4().hex + '@smail.th-koeln.de>'
    reply = draft.get('inReplyTo', '')
    if reply:
        if not isinstance(reply, str) or not re.fullmatch(r'<[^<>\s\x00-\x1f]{1,480}>', reply):
            raise MailError('invalid_request')
        message['In-Reply-To'] = reply
        message['References'] = reply
    message.set_content(text)
    files = draft.get('attachments', [])
    if not isinstance(files, list) or len(files) > 10:
        raise MailError('invalid_request')
    total = 0
    for item in files:
        if not isinstance(item, dict) or not isinstance(item.get('name'), str) or not 1 <= len(item['name']) <= 180 or re.search(r'[\x00-\x1f\x7f/\\]', item['name']) or not isinstance(item.get('data'), str):
            raise MailError('invalid_request')
        try:
            data = base64.b64decode(item['data'], validate=True)
        except Exception:
            raise MailError('invalid_request')
        total += len(data)
        if total > MAX_ATTACHMENTS:
            raise MailError('attachment_too_large')
        message.add_attachment(data, maintype='application', subtype='octet-stream', filename=item['name'])
    return message, all_recipients


def smtp_login(request):
    client = smtplib.SMTP('smtp.intranet.th-koeln.de', 587, timeout=15)
    try:
        client.ehlo()
        client.starttls(context=ssl.create_default_context())
        client.ehlo()
        try:
            client.login(request['user'], request['password'])
        except imaplib.IMAP4.error:
            raise MailError('auth_failed')
        return client
    except Exception:
        client.close()
        raise


def send(client, request):
    message, recipients = draft_message(request, request['address'])
    smtp = smtp_login(request)
    try:
        refused = smtp.send_message(message, from_addr=request['address'], to_addrs=recipients)
    except (smtplib.SMTPRecipientsRefused, smtplib.SMTPDataError, smtplib.SMTPSenderRefused):
        raise MailError('send_failed')
    except Exception:
        # The server may have accepted DATA before the connection was interrupted.
        raise MailError('delivery_unknown')
    finally:
        smtp.close()
    saved = False
    try:
        target = next((f for f in folders(client) if f['kind'] == 'sent'), None)
        if target:
            status, _ = client.append(quoted(mailbox_raw(target['id'])), '(\\Seen)', imaplib.Time2Internaldate(datetime.now(timezone.utc)), message.as_bytes())
            saved = status == 'OK'
    except Exception:
        pass
    return {'accepted': len(recipients) - len(refused), 'refused': list(refused.keys()),
            'sentCopySaved': saved, 'messageId': str(message['Message-ID'])}


def execute(request):
    client = None
    try:
        if not isinstance(request, dict) or not isinstance(request.get('user'), str) or not re.fullmatch(r'[A-Za-z0-9._-]{1,100}', request['user']) or not isinstance(request.get('password'), str) or not 1 <= len(request['password']) <= 2048 or re.search(r'[\x00-\x1f\x7f]', request['password']):
            raise MailError('invalid_request')
        client = imaplib.IMAP4_SSL('imap.intranet.th-koeln.de', 993, ssl_context=ssl.create_default_context(), timeout=15)
        try:
            client.login(request['user'], request['password'])
        except imaplib.IMAP4.error:
            raise MailError('auth_failed') from None
        action = request.get('action')
        if action == 'connect':
            select(client, mailbox_id('INBOX'))
            result = {'folders': folders(client), 'smtpReady': False}
            try:
                smtp = smtp_login(request)
                smtp.close()
                result['smtpReady'] = True
            except Exception:
                result['smtpWarning'] = True
            return result
        if action == 'folders':
            return {'folders': folders(client)}
        if action == 'list':
            return message_list(client, request)
        if action in ('message', 'attachment', 'flag'):
            uid = uid_value(request.get('uid'))
            expected = request.get('uidValidity')
            if not isinstance(expected, str) or not re.fullmatch(r'\d{1,20}', expected):
                raise MailError('invalid_request')
            select(client, request['folder'], expected, readonly=action != 'flag')
            if action == 'flag':
                if not isinstance(request.get('unread'), bool):
                    raise MailError('invalid_request')
                # Confirm the UID exists; never apply a sequence-number mutation.
                status, rows = client.uid('fetch', uid, '(UID)')
                if status != 'OK' or not any(isinstance(r, bytes) and re.search(rb'UID\s+' + uid.encode('ascii') + rb'\b', r) for r in rows or []):
                    raise MailError('message_unavailable')
                status, _ = client.uid('store', uid, '-FLAGS.SILENT' if request['unread'] else '+FLAGS.SILENT', '(\\Seen)')
                if status != 'OK':
                    raise MailError('connection_failed')
                return {'uid': uid, 'unread': request['unread']}
            raw = raw_message(client, uid)
            if action == 'message':
                return {'uid': uid, 'uidValidity': expected, **parse_message(raw)}
            part_id = request.get('part')
            if not isinstance(part_id, str) or not re.fullmatch(r'\d{1,3}', part_id):
                raise MailError('invalid_request')
            parts = list(email.message_from_bytes(raw, policy=policy.default).walk())[:200]
            index = int(part_id)
            if index >= len(parts):
                raise MailError('message_unavailable')
            part = parts[index]
            if not is_attachment(part):
                raise MailError('message_unavailable')
            data = attachment_data(part)
            if len(data) > MAX_ATTACHMENTS:
                raise MailError('attachment_too_large')
            return {'name': attachment_name(part), 'data': base64.b64encode(data).decode('ascii')}
        if action == 'send':
            if not address(request.get('address', '')).lower().endswith('@smail.th-koeln.de'):
                raise MailError('invalid_request')
            return send(client, request)
        raise MailError('invalid_request')
    finally:
        if client:
            # LOGOUT does not expunge; CLOSE would remove deleted messages.
            try:
                client.logout()
            except Exception:
                pass


def main():
    try:
        data = sys.stdin.buffer.read(12 * 1024 * 1024 + 1)
        if len(data) > 12 * 1024 * 1024:
            raise MailError('invalid_request')
        result = execute(json.loads(data))
    except MailError as error:
        result = {'error': error.code}
    except smtplib.SMTPAuthenticationError:
        result = {'error': 'auth_failed'}
    except Exception:
        result = {'error': 'connection_failed'}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
