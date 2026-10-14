"""Interactive launcher: credentials enter the local process only, never a file."""
import getpass
import os
import shutil
import sys
from pathlib import Path

root = Path(__file__).resolve().parent
node = shutil.which('node')
if not node:
    print('Node.js ab Version 22 wird benötigt. Installiere es von nodejs.org.')
    sys.exit(1)
print('Context — lokaler Arbeitsbereich')
print('Leere Eingaben überspringen einen Connector. Mit Ctrl+C brichst du ab.')
print('Tokens müssen zuvor im jeweiligen Anbieter mit passenden Rechten eingerichtet sein.')
print('Hier werden keine neuen Zugriffsrechte erstellt und keine Zugangsdaten gespeichert.')
env = os.environ.copy()
try:
    gitlab = getpass.getpass('GitLab-Token (read_api, optional): ')
    mattermost = getpass.getpass('Mattermost-Token (optional; voller Kontozugriff möglich): ')
    mail_user = input('TH-campusID für IMAP (optional): ').strip()
    mail_password = getpass.getpass('TH-Passwort: ') if mail_user else ''
    mail_address = input('TH-Mailadresse für den Versand (optional): ').strip() if mail_user else ''
    ki_key = getpass.getpass('KI:connect-NRW-API-Schlüssel (optional): ')
except (KeyboardInterrupt, EOFError):
    print('\nAbgebrochen.')
    sys.exit(0)
for key, value in [('GITLAB_TOKEN', gitlab), ('MATTERMOST_TOKEN', mattermost),
                   ('TH_MAIL_USER', mail_user), ('TH_MAIL_PASSWORD', mail_password), ('TH_MAIL_ADDRESS', mail_address), ('KICONNECT_API_KEY', ki_key)]:
    env.pop(key, None)
    if value:
        env[key] = value
env.setdefault('PORT', '4318')
print('\nÖffne http://127.0.0.1:'+env['PORT']+'/ im Browser. Ctrl+C beendet den lokalen Server.')
os.chdir(root)
os.execvpe(node, [node, str(root / 'server.mjs')], env)
