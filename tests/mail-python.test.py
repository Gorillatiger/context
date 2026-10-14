import base64
import importlib.util
import ssl
import socketserver
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from email.message import EmailMessage
from email import policy

spec = importlib.util.spec_from_file_location('mail_client', Path(__file__).parent.parent / 'connectors/mail-client.py')
mail = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mail)


class IMAP:
    def __init__(self):
        self.calls = []
        self.validity = b'123'
        self.raw = b'Subject: Hallo\r\nFrom: Test <person@example.org>\r\nTo: qa@smail.th-koeln.de\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nNachrichtentext'
        self.size = len(self.raw)

    def login(self, user, password):
        self.calls.append(('login', user, password))

    def select(self, folder, readonly):
        self.calls.append(('select', folder, readonly))
        return 'OK', [b'45']

    def response(self, name):
        return name, [self.validity]

    def list(self):
        return 'OK', [b'(\\HasNoChildren) "/" "INBOX"', b'(\\Sent) "/" "Gesendet"', b'(\\Noselect) "/" "Root"', b'() "/" "Entw&APw-rfe"', b'() "/" "A\\" B"']

    def uid(self, command, *args):
        self.calls.append((command, *args))
        if command == 'search':
            return 'OK', [b' '.join(str(i).encode() for i in range(1, 46))]
        if command == 'fetch':
            if args[1] == '(RFC822.SIZE)':
                return 'OK', [b'1 (UID 45 RFC822.SIZE ' + str(self.size).encode() + b')']
            if args[1] == '(BODY.PEEK[])':
                return 'OK', [(b'1 (UID 45 BODY[] {200}', self.raw)]
            if args[1] == '(UID)':
                return 'OK', [b'1 (UID ' + args[0].encode() + b')']
            return 'OK', [(b'1 (UID ' + uid + b' FLAGS () RFC822.SIZE 200 BODY[HEADER.FIELDS] {200}', self.raw.split(b'\r\n\r\n')[0]) for uid in args[0].split(b',')]
        if command == 'store':
            return 'OK', [None]
        raise AssertionError(command)

    def append(self, *args):
        self.calls.append(('append', *args))
        return 'OK', []

    def logout(self):
        self.calls.append(('logout',))


class SMTP:
    def __init__(self, *args, **kwargs):
        self.calls = []
        self.refused = {}

    def ehlo(self):
        self.calls.append('ehlo')

    def starttls(self, context):
        assert context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname
        self.calls.append('tls')

    def login(self, user, password):
        self.calls.append('login')

    def send_message(self, message, from_addr, to_addrs):
        self.message, self.recipients = message, to_addrs
        assert self.calls == ['ehlo', 'tls', 'ehlo', 'login']
        return self.refused

    def close(self):
        pass


class MailTests(unittest.TestCase):
    def setUp(self):
        self.imap, self.smtp = IMAP(), SMTP()
        self.request = {'user': 'qa-user', 'password': 'synthetic', 'address': 'qa@smail.th-koeln.de', 'folder': mail.mailbox_id('INBOX'), 'uid': '45', 'uidValidity': '123'}

    def execute(self, action, **data):
        def create(host, port, ssl_context, timeout):
            self.assertEqual((host, port), ('imap.intranet.th-koeln.de', 993))
            self.assertEqual(ssl_context.verify_mode, ssl.CERT_REQUIRED)
            self.assertTrue(ssl_context.check_hostname)
            return self.imap
        with patch.object(mail.imaplib, 'IMAP4_SSL', create), patch.object(mail.smtplib, 'SMTP', return_value=self.smtp) as smtp:
            result = mail.execute({**self.request, **data, 'action': action})
            if action in ('send', 'connect'):
                smtp.assert_called_once_with('smtp.intranet.th-koeln.de', 587, timeout=15)
            self.assertEqual(self.imap.calls[-1], ('logout',))
            return result

    def test_connect_and_folders_use_verified_tls_and_modified_utf7(self):
        result = self.execute('connect')
        self.assertTrue(result['smtpReady'])
        self.assertEqual([f['label'] for f in result['folders']], ['Posteingang', 'Gesendet', 'A" B', 'Entwürfe'])
        self.assertNotIn('synthetic', str(result))

    def test_read_uses_uid_peek_and_readonly_without_mutations(self):
        result = self.execute('message')
        self.assertEqual(result['text'], 'Nachrichtentext')
        self.assertIn(('select', '"INBOX"', True), self.imap.calls)
        self.assertIn(('fetch', '45', '(BODY.PEEK[])'), self.imap.calls)
        self.assertFalse(any(c[0] in ('store', 'append', 'close') for c in self.imap.calls))

    def test_empty_plain_alternative_uses_the_readable_html_body(self):
        message = EmailMessage()
        message.set_content(' \n')
        message.add_alternative('<p>Wichtige Kursinformationen</p><script>unsafe()</script>', subtype='html')
        result = mail.parse_message(message.as_bytes())
        self.assertIn('Wichtige Kursinformationen', result['text'])
        self.assertNotIn('unsafe', result['text'])
        self.assertTrue(result['convertedHTML'])

    def test_mixed_sections_preserve_html_and_plain_without_duplicating_alternatives(self):
        message = EmailMessage()
        message.make_mixed()
        intro = EmailMessage()
        intro.set_content('Einleitung')
        details = EmailMessage()
        details.set_content('Aufgabe als Klartext')
        details.add_alternative('<p>Dieselbe Aufgabe als HTML</p>', subtype='html')
        ending = EmailMessage()
        ending.set_content('<p>Zusätzliche Termine</p>', subtype='html')
        message.attach(intro)
        message.attach(details)
        message.attach(ending)
        message.add_attachment(b'Attachment should not become body', maintype='text', subtype='plain', filename='Notiz.txt')
        result = mail.parse_message(message.as_bytes())
        self.assertIn('Einleitung', result['text'])
        self.assertEqual(result['text'].count('Aufgabe als Klartext'), 1)
        self.assertNotIn('Dieselbe Aufgabe als HTML', result['text'])
        self.assertIn('Zusätzliche Termine', result['text'])
        self.assertNotIn('Attachment should not become body', result['text'])
        self.assertEqual(result['attachments'][0]['name'], 'Notiz.txt')
        self.assertTrue(result['convertedHTML'])

    def test_imap_login_rejection_is_auth_failed_and_does_not_echo_credentials(self):
        with patch.object(mail.imaplib, 'IMAP4_SSL', return_value=self.imap), patch.object(self.imap, 'login', side_effect=mail.imaplib.IMAP4.error('private server message')):
            with self.assertRaises(mail.MailError) as caught:
                mail.execute({**self.request, 'action': 'connect'})
        self.assertEqual(caught.exception.code, 'auth_failed')
        self.assertNotIn('private server message', str(caught.exception))
        self.assertEqual(self.imap.calls[-1], ('logout',))

    def test_message_size_rejected_before_fetching_body(self):
        self.imap.size = mail.MAX_MESSAGE + 1
        with self.assertRaises(mail.MailError) as ctx:
            self.execute('message')
        self.assertEqual(ctx.exception.code, 'message_too_large')
        self.assertFalse(any('BODY.PEEK[]' in str(c) for c in self.imap.calls))

    def test_uidvalidity_change_cannot_read_or_mutate_another_message(self):
        for action in ('message', 'flag'):
            with self.assertRaises(mail.MailError) as ctx:
                self.execute(action, uidValidity='124', unread=False)
            self.assertEqual(ctx.exception.code, 'mailbox_changed')
        self.assertFalse(any(c[0] in ('fetch', 'store') for c in self.imap.calls))

    def test_flags_are_explicit_uid_mutations_and_never_expunge(self):
        self.execute('flag', unread=False)
        self.assertIn(('select', '"INBOX"', False), self.imap.calls)
        self.assertIn(('store', '45', '+FLAGS.SILENT', '(\\Seen)'), self.imap.calls)
        self.assertFalse(any(c[0] == 'close' for c in self.imap.calls))

    def test_batched_headers_paginate_and_unicode_search_is_literal(self):
        result = self.execute('list', query='Köln " test', offset=40, unread=True)
        self.assertEqual([i['uid'] for i in result['items']], ['5', '4', '3', '2', '1'])
        self.assertEqual(result['nextOffset'], None)
        self.assertEqual(result['matched'], 45)
        self.assertEqual(self.imap.literal, 'Köln " test'.encode())
        self.assertIn(('search', 'CHARSET', 'UTF-8', 'UNSEEN', 'TEXT'), self.imap.calls)

    def test_actual_imaplib_sends_charset_and_search_text_as_literal(self):
        observed = []
        query = 'Köln " ) DELETE INBOX'

        class Wire(socketserver.StreamRequestHandler):
            def handle(self):
                self.connection.settimeout(3)
                self.wfile.write(b'* OK QA IMAP ready\r\n')
                while True:
                    command = self.rfile.readline()
                    if not command:
                        break
                    tag, action, *_ = command.split()
                    response = b''
                    if action == b'CAPABILITY':
                        response = b'* CAPABILITY IMAP4rev1\r\n'
                    elif action == b'EXAMINE':
                        response = b'* 0 EXISTS\r\n* OK [UIDVALIDITY 123] valid\r\n'
                    elif action == b'UID':
                        observed.append(command)
                        if b'UID SEARCH CHARSET UTF-8 UNSEEN TEXT {' not in command:
                            self.wfile.write(tag + b' BAD invalid search charset\r\n')
                            continue
                        length = int(command.split(b'{')[-1].split(b'}')[0])
                        self.wfile.write(b'+ send search literal\r\n')
                        observed.append(self.rfile.read(length))
                        self.rfile.readline()
                        response = b'* SEARCH\r\n'
                    elif action == b'LOGOUT':
                        self.wfile.write(b'* BYE\r\n' + tag + b' OK logout\r\n')
                        break
                    self.wfile.write(response + tag + b' OK done\r\n')

        with socketserver.TCPServer(('127.0.0.1', 0), Wire) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                client = mail.imaplib.IMAP4('127.0.0.1', server.server_address[1], timeout=3)
                client.login('synthetic-user', 'synthetic-password')
                try:
                    result = mail.message_list(client, {'folder':mail.mailbox_id('INBOX'),'query':query,'unread':True})
                finally:
                    client.logout()
                self.assertEqual(result['matched'], 0)
                self.assertEqual(observed[1], query.encode('utf-8'))
                self.assertNotIn(query.encode('utf-8'), observed[0])
            finally:
                server.shutdown()
                thread.join(timeout=4)

    def test_mailbox_and_uid_reject_command_injection(self):
        for folder in ('INBOX\r\nDELETE INBOX', '\0', ''):
            with self.assertRaises(mail.MailError):
                mail.mailbox_raw(base64.urlsafe_b64encode(folder.encode()).decode().rstrip('='))
        for uid in ('1:*', '1 STORE', '0', '1\r\nLOGOUT'):
            with self.assertRaises(mail.MailError):
                mail.uid_value(uid)
        self.assertEqual(mail.quoted('A" B\\C'), '"A\\" B\\\\C"')

    def test_mime_prefers_plain_decodes_headers_and_preserves_attachments(self):
        msg = EmailMessage()
        msg['Subject'] = 'Grüße vom Kurs'
        msg['From'] = 'Lehrperson <kurs@example.org>'
        msg.set_content('Hallo Köln!')
        msg.add_alternative('<p>HTML Alternative</p><script>evil()</script>', subtype='html')
        msg.add_attachment(b'QA\x00Datei', maintype='application', subtype='octet-stream', filename='../Köln.txt')
        result = mail.parse_message(msg.as_bytes())
        self.assertEqual(result['subject'], 'Grüße vom Kurs')
        self.assertEqual(result['text'].strip(), 'Hallo Köln!')
        self.assertFalse(result['convertedHTML'])
        self.assertEqual(result['attachments'][0]['name'], 'Köln.txt')
        self.imap.raw = msg.as_bytes(); self.imap.size = len(self.imap.raw)
        download = self.execute('attachment', part=result['attachments'][0]['part'])
        self.assertEqual(base64.b64decode(download['data']), b'QA\x00Datei')

    def test_html_cannot_execute_or_load_remote_images(self):
        msg = EmailMessage();msg.set_content('<head><style>secret-css</style></head><p>Hallo &amp; Welt</p><script>secret-js</script><img src="https://tracking.invalid/secret"><p>Termin</p><a href="https://campus.example.org/unterlagen">Unterlagen</a><a href="javascript:evil()">Unsicher</a>', subtype='html')
        result = mail.parse_message(msg.as_bytes())
        self.assertTrue(result['convertedHTML'])
        self.assertIn('Hallo & Welt', result['text'])
        self.assertIn('https://campus.example.org/unterlagen', result['text'])
        for unsafe in ('secret-css', 'secret-js', 'tracking.invalid', '<img', 'javascript:'):
            self.assertNotIn(unsafe, result['text'])

    def test_mime_part_limit_is_explicitly_marked(self):
        msg = EmailMessage();msg.set_content('Haupttext')
        for i in range(201):
            msg.add_attachment(b'x', maintype='application', subtype='octet-stream', filename='file-' + str(i) + '.txt')
        result = mail.parse_message(msg.as_bytes())
        self.assertTrue(result['partsLimited'])
        self.assertLessEqual(len(result['attachments']), 200)

    def test_attached_email_is_an_attachment_not_the_visible_body(self):
        forwarded = EmailMessage();forwarded['Subject'] = 'Weitergeleitet';forwarded.set_content('Nur im Anhang')
        msg = EmailMessage();msg.set_content('Haupttext');msg.add_attachment(forwarded, filename='mail.eml')
        result = mail.parse_message(msg.as_bytes())
        self.assertEqual(result['text'].strip(), 'Haupttext')
        self.assertEqual(len(result['attachments']), 1)
        self.imap.raw = msg.as_bytes();self.imap.size = len(self.imap.raw)
        download = self.execute('attachment', part=result['attachments'][0]['part'])
        self.assertIn(b'Subject: Weitergeleitet', base64.b64decode(download['data']))

    def test_smtp_uses_tls_before_login_bcc_only_envelope_and_saves_copy(self):
        draft = {'to': ['to@example.org'], 'bcc': ['hidden@example.org'], 'subject': 'Test ä', 'text': 'Hallo', 'inReplyTo': '<original@example.org>', 'attachments': [{'name': 'test.txt', 'data': base64.b64encode(b'Test').decode()}]}
        result = self.execute('send', draft=draft)
        self.assertEqual(result['accepted'], 2)
        self.assertTrue(result['sentCopySaved'])
        self.assertNotIn('Bcc', self.smtp.message)
        self.assertEqual(self.smtp.recipients, ['to@example.org', 'hidden@example.org'])
        self.assertEqual(self.smtp.message['In-Reply-To'], '<original@example.org>')
        copy = next(c[-1] for c in self.imap.calls if c[0] == 'append')
        self.assertNotIn(b'hidden@example.org', copy)

    def test_disconnect_during_data_has_unknown_status_not_safe_retry(self):
        with patch.object(self.smtp, 'send_message', side_effect=OSError('synthetic secret in provider error')):
            with self.assertRaises(mail.MailError) as ctx:
                self.execute('send', draft={'to':['to@example.org'],'subject':'Hallo','text':'Test'})
        self.assertEqual(ctx.exception.code, 'delivery_unknown')
        self.assertFalse(any(c[0] == 'append' for c in self.imap.calls))

    def test_partial_smtp_acceptance_is_reported_without_resending(self):
        self.smtp.refused = {'no@example.org': (550, b'Refused')}
        result = self.execute('send', draft={'to':['yes@example.org','no@example.org'],'subject':'Hallo','text':'Test'})
        self.assertEqual(result['accepted'], 1)
        self.assertEqual(result['refused'], ['no@example.org'])

    def test_header_and_attachment_injection_are_rejected(self):
        for values in ({'subject':'Hallo\r\nBcc: evil@example.org'}, {'to':['x@example.org\r\nQUIT']}, {'inReplyTo':'<id>\r\nX: x'}, {'attachments':[{'name':'../test','data':'eA=='}]}, {'attachments':[{'name':'file','data':'invalid'}]}):
            with self.assertRaises(mail.MailError):
                mail.draft_message({'draft':{'to':['to@example.org'],'subject':'Hallo','text':'Test',**values}}, 'qa@smail.th-koeln.de')


if __name__ == '__main__':
    unittest.main()
