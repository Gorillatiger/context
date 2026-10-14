import test from 'node:test';
import assert from 'node:assert/strict';
import {
  miroBoardURL,
  boardSourceURL,
  boardFinding,
  extractBoardLinks,
  validateBoardFindings,
  mergeBoardFindings,
  collectLocalBoards,
  groupBoards,
} from '../dist/board-index.js';

const board = 'https://miro.com/app/board/uXjVLABBOARD=/';
const secondBoard = 'https://miro.com/app/board/uXjVSECOND01=/';
const thirdBoard = 'https://miro.com/app/board/uXjVTHIRD001=/';
const first = '2026-10-12T08:00:00.000Z';
const later = '2026-10-13T10:00:00.000Z';
const source = (overrides = {}) => ({
  id: 'u:spaces-lab-post', projectId: 'lab', kind: 'spaces',
  title: 'Kursbeitrag zu Interfaces', url: 'https://spaces.th-koeln.de/lab/2026/10/12/interfaces/',
  postedBy: 'Anna Beispiel', postedAt: '2026-10-11T09:30:00Z', ...overrides,
});
const finding = (overrides = {}, provenance = {}, foundAt = first) =>
  boardFinding({ url: board, title: 'Interface Board', ...overrides }, source(provenance), foundAt);
const emptyWorkspace = () => ({ projects: [], notes: [], bookmarks: [], tasks: [] });

test('canonical Miro board URLs remove tracking, invitation keys and fragments', () => {
  const original = 'https://WWW.MIRO.COM/app/board/uXjVLABBOARD=/?share_link_id=private-invite&utm_source=spaces&token=private-token#frame';
  assert.equal(miroBoardURL(original), board);
  assert.equal(miroBoardURL(board.slice(0, -1)), board);
  assert.equal(miroBoardURL(board + '?utm_medium=course&amp;share_link_id=private'), board);
  const row = finding({ url: original });
  assert.equal(row.url, board);
  assert.ok(!JSON.stringify(row).includes('private'));
});

test('hostile hosts, credentials, HTTP, foreign paths and nondefault ports cannot become boards', () => {
  for (const url of [
    'http://miro.com/app/board/uXjVLABBOARD=/',
    'https://miro.com.evil.example/app/board/uXjVLABBOARD=/',
    'https://evil.example/app/board/uXjVLABBOARD=/',
    'https://miro.com@evil.example/app/board/uXjVLABBOARD=/',
    'https://user@miro.com/app/board/uXjVLABBOARD=/',
    'https://user:password@miro.com/app/board/uXjVLABBOARD=/',
    'https://miro.com:8443/app/board/uXjVLABBOARD=/',
    'https://miro.com/app/dashboard/',
    'https://miro.com/app/board/uXjVLABBOARD=/forbidden-path',
    'https://miro.com/app/board/abc/',
    'https://miro.com/app/board/' + 'a'.repeat(101) + '/',
    'javascript:alert(1)',
  ]) {
    assert.throws(() => miroBoardURL(url), undefined, url);
    assert.deepEqual(extractBoardLinks(url), [], url);
  }
});

test('URL extraction never salvages an embedded board-shaped prefix from a hostile URL', () => {
  for (const text of [
    'https://evil.test/?next=' + board,
    'https://evil.test/path/' + board,
    '[Untrusted redirect](https://evil.test/?next=' + board + ')',
    '<a href="https://evil.test/?next=' + board + '">Untrusted redirect</a>',
    board + 'not-a-board-path',
    board + '../../dashboard/',
  ]) assert.deepEqual(extractBoardLinks(text), [], text);
});

test('Markdown, HTML and direct URLs produce canonical links with only observed link titles', () => {
  assert.deepEqual(extractBoardLinks('[Interfaces &amp; Design](' + board + '?share_link_id=private)'), [{ url: board, title: 'Interfaces & Design' }]);
  assert.deepEqual(extractBoardLinks('<a class="source" href="' + board + '?utm_source=spaces&amp;token=private"><strong>Pr&#x6F;totyping</strong> &amp; Team</a>'), [{ url: board, title: 'Prototyping & Team' }]);
  assert.deepEqual(extractBoardLinks('Unsere Arbeitsfläche: ' + board + '?utm_source=spaces.'), [{ url: board, title: '' }]);
  const duplicate = extractBoardLinks(board + '\n[Observed title](' + board + '?share_link_id=one)\n<a href="' + board + '?share_link_id=two">Another title</a>');
  assert.equal(duplicate.length, 1);
  assert.equal(duplicate[0].url, board);
  assert.equal(duplicate[0].title, 'Observed title');
  assert.deepEqual(extractBoardLinks(null), []);
});

test('input and output link counts are bounded without scanning beyond the declared text window', () => {
  const text = Array.from({ length: 130 }, (_, index) => `https://miro.com/app/board/board_${String(index).padStart(4, '0')}/`).join('\n');
  assert.equal(extractBoardLinks(text).length, 100);
  assert.deepEqual(extractBoardLinks('x'.repeat(200000) + '\n' + board), []);
});

test('source links retain useful attribution but remove sensitive query keys and fragments', () => {
  const url = 'https://spaces.th-koeln.de/lab/post/?p=42&view=compact&token=private-one&api_key=private-two&client_secret=private-three&Password=private-four&code=private-five&signature=private-six&auth=private-seven&share_link_id=private-eight&%74oken=private-nine#private-fragment';
  assert.equal(boardSourceURL(url), 'https://spaces.th-koeln.de/lab/post/?p=42&view=compact');
  assert.equal(boardSourceURL(''), '');
  for (const value of ['http://spaces.th-koeln.de/lab/', 'https://user@spaces.th-koeln.de/lab/', 'https://user:password@spaces.th-koeln.de/lab/', 'javascript:alert(1)', '/relative-path'])
    assert.throws(() => boardSourceURL(value));
  const row = finding({}, { url });
  assert.equal(row.sourceURL, 'https://spaces.th-koeln.de/lab/post/?p=42&view=compact');
  assert.ok(!JSON.stringify(row).includes('private'));
});

test('URL-valued source identifiers cannot retain removed credentials in local metadata or composite IDs', () => {
  const unsafeSourceId = 'https://spaces.th-koeln.de/lab/post/?p=42&token=fixture-private&share_link_id=fixture-invite#secret';
  for (const id of [unsafeSourceId, '  ' + unsafeSourceId + '  ', unsafeSourceId.replace('https:', 'HTTPS:')]) {
    const row = finding({}, { id, url: unsafeSourceId });
    assert.equal(row.sourceURL, 'https://spaces.th-koeln.de/lab/post/?p=42');
    assert.ok(row.sourceId);
    assert.ok(row.sourceId.length <= 200);
    assert.ok(!JSON.stringify(row).includes('fixture-private'));
    assert.ok(!JSON.stringify(row).includes('fixture-invite'));
    const reloaded = validateBoardFindings([row], ['lab']);
    assert.ok(!JSON.stringify(reloaded).includes('fixture-private'));
  }
});

test('the same canonical board deduplicates per source and course while every distinct provenance remains', () => {
  const a = finding();
  const aAgain = finding({ url: board + '?share_link_id=another' }, {}, later);
  const labOtherSource = finding({}, { id: 'note:lab-notes', kind: 'note', title: 'Eigene Labornotizen', postedBy: '', postedAt: '' });
  const secondCourse = finding({}, { projectId: 'design', id: 'u:spaces-design', title: 'Design: Ressourcen', postedBy: 'Ben Beispiel' });
  const merged = mergeBoardFindings([a], [aAgain, labOtherSource, secondCourse]);
  assert.equal(merged.length, 3);
  assert.equal(new Set(merged.map(row => row.url)).size, 1);
  assert.equal(new Set(merged.map(row => row.id)).size, 3);
  const groups = groupBoards(merged);
  assert.equal(groups.length, 2);
  assert.equal(groups.find(group => group.projectId === 'lab').occurrences.length, 2);
  assert.equal(groups.find(group => group.projectId === 'design').occurrences.length, 1);
  assert.deepEqual(new Set(groups.flatMap(group => group.occurrences.map(row => row.sourceId))), new Set(['u:spaces-lab-post', 'note:lab-notes', 'u:spaces-design']));
});

test('the same observed Spaces source offered by two courses retains both course provenances after repeated merges', () => {
  const shared = { id: 'https://spaces.th-koeln.de/2026/10/12/shared-workshop/', url: 'https://spaces.th-koeln.de/2026/10/12/shared-workshop/', title: 'Gemeinsamer Workshop' };
  const lab = finding({}, { ...shared, projectId: 'lab' });
  const design = finding({}, { ...shared, projectId: 'design' });
  let rows = mergeBoardFindings([], [lab, design]);
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map(row => row.projectId)), new Set(['lab', 'design']));
  rows = mergeBoardFindings(rows, [finding({}, { ...shared, projectId: 'lab' }, later), finding({}, { ...shared, projectId: 'design' }, later)]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.foundAt === first));
  assert.equal(groupBoards(rows, { projectId: 'lab' }).length, 1);
  assert.equal(groupBoards(rows, { projectId: 'design' }).length, 1);
});

test('post authors and post times stay attribution rather than invented board creators or creation times', () => {
  const row = finding();
  assert.equal(row.postedBy, 'Anna Beispiel');
  assert.equal(row.postedAt, '2026-10-11T09:30:00.000Z');
  assert.equal(row.foundAt, first);
  for (const key of ['creator', 'createdBy', 'boardCreator', 'boardCreatedAt', 'createdAt'])
    assert.equal(Object.hasOwn(row, key), false, key);
  const unknown = finding({ title: '' }, { title: '', postedBy: '', postedAt: '' });
  assert.equal(unknown.title, 'Miro-Board');
  assert.equal(unknown.titleOrigin, 'unknown');
  assert.equal(unknown.postedBy, '');
  assert.equal(unknown.postedAt, '');
});

test('repeat collection preserves first discovery time and local title while fresh observed metadata can improve', () => {
  const original = { ...finding(), customTitle: 'Mein Arbeitsboard' };
  const updated = finding({ title: '', sourceTitle: 'Aktualisierte Fundstelle' }, { postedBy: 'Ben Beispiel' }, later);
  const [merged] = mergeBoardFindings([original], [updated]);
  assert.equal(merged.foundAt, first);
  assert.equal(merged.customTitle, 'Mein Arbeitsboard');
  assert.equal(merged.title, 'Interface Board');
  assert.equal(merged.titleOrigin, 'link');
  assert.equal(merged.sourceTitle, 'Aktualisierte Fundstelle');
  assert.equal(merged.postedBy, 'Ben Beispiel');
  const [group] = groupBoards([merged]);
  assert.equal(group.title, 'Mein Arbeitsboard');
  assert.equal(group.titleOrigin, 'custom');
});

test('corrupt security-critical schemas, missing source IDs and excessive counts fail validation', () => {
  const valid = finding();
  assert.deepEqual(validateBoardFindings([valid], ['lab']), [valid]);
  for (const value of [null, {}, 'board', Array(5001).fill(valid), [null], [[]], [{ ...valid, url: 'https://evil.test/' }], [{ ...valid, projectId: 'missing-course' }], [{ ...valid, sourceId: '' }], [{ ...valid, sourceId: ' ' }], [{ ...valid, sourceId: 'x'.repeat(201) }], [{ ...valid, sourceId: 42 }]])
    assert.throws(() => validateBoardFindings(value, ['lab']));
  const missing = { ...valid };
  delete missing.sourceId;
  assert.throws(() => validateBoardFindings([missing], ['lab']));
  assert.throws(() => validateBoardFindings([{ ...valid, sourceURL: 'http://spaces.th-koeln.de/lab/' }], ['lab']));
});

test('overlong source identifiers are rejected instead of collapsing distinct sources to the same prefix', () => {
  const prefix = 'u:' + 'x'.repeat(198);
  assert.equal(prefix.length, 200);
  for (const suffix of ['a', 'b']) {
    assert.throws(() => boardFinding({ url: board }, source({ id: prefix + suffix }), first));
    assert.throws(() => validateBoardFindings([{ ...finding(), sourceId: prefix + suffix }], ['lab']));
  }
});

test('a manual course assignment survives subsequent scans without creating a duplicate occurrence', () => {
  const original = finding();
  const [assigned] = validateBoardFindings([{ ...original, assignedProjectId: 'design' }], ['lab', 'design']);
  assert.equal(assigned.projectId, 'design');
  const rows = mergeBoardFindings([assigned], [finding({}, {}, later)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].projectId, 'design');
  assert.equal(rows[0].assignedProjectId, 'design');
  assert.equal(rows[0].foundAt, first);
  assert.equal(groupBoards(rows, { projectId: 'lab' }).length, 0);
  assert.equal(groupBoards(rows, { projectId: 'design' }).length, 1);
});

test('loading missing or impossible timestamps leaves them unknown instead of inventing current or normalized dates', () => {
  const valid = finding();
  const missing = { ...valid };
  delete missing.foundAt;
  delete missing.postedAt;
  const [loaded] = validateBoardFindings([missing], ['lab']);
  assert.equal(loaded.foundAt, '');
  assert.equal(loaded.postedAt, '');
  for (const invalid of ['not-a-date', '2026-02-30', '2026-02-30T09:00:00Z', '2026-13-01T09:00:00Z', '2026-10-12T25:00:00Z']) {
    const [row] = validateBoardFindings([{ ...valid, foundAt: invalid, postedAt: invalid }], ['lab']);
    assert.equal(row.foundAt, '', invalid);
    assert.equal(row.postedAt, '', invalid);
  }
});

test('local collection combines course notes, bookmarks, tasks, allowed update sources and observed browser links', () => {
  const workspace = emptyWorkspace();
  workspace.projects = [
    { id: 'lab', name: 'Labor', archived: false, note: '[Projektboard](' + board + ')', links: [] },
    { id: 'archived', name: 'Archivkurs', archived: true, note: secondBoard, links: [] },
  ];
  workspace.notes = [{ id: 'own-note', projectId: 'lab', title: 'Eigene Notizen', content: board }];
  workspace.bookmarks = [{ id: 'bookmark', projectId: 'lab', title: 'Lesezeichen', url: board }];
  workspace.tasks = [{ id: 'task', projectId: 'lab', title: 'Board vorbereiten', url: board }];
  const updates = [
    { id: 'spaces-post', source: 'spaces', title: 'Spaces-Beitrag', summary: board, author: { name: 'Anna Beispiel' }, createdAt: '2026-10-11T10:00:00Z', url: 'https://spaces.th-koeln.de/lab/post/' },
    { id: 'mattermost-post', source: 'mattermost', title: 'Teamkanal', content: secondBoard, author: 'Ben Beispiel', createdAt: '2026-10-11T11:00:00Z' },
    { id: 'gitlab-summary', source: 'gitlab', kind: 'summary', title: 'Repository-Übersicht', summary: thirdBoard, createdAt: '2026-10-11T12:00:00Z' },
    { id: 'mail-post', source: 'mail', title: 'Mailinhalt', content: board },
    { id: 'signal-post', source: 'signal', title: 'Signalinhalt', content: board },
  ];
  const browserSources = [{ id: 'live:lab-page', projectId: 'lab', title: 'Gelesene Kursseite', url: 'https://spaces.th-koeln.de/lab/', text: '', boardLinks: [{ url: board, title: 'Kursarbeitsfläche' }] }];
  const result = collectLocalBoards({ workspace, updates, browserSources, courseOf: () => 'lab' }, first);
  assert.equal(result.sources, 8);
  assert.equal(result.findings.length, 8);
  assert.deepEqual(new Set(result.findings.map(row => row.sourceKind)), new Set(['project', 'note', 'bookmark', 'task', 'spaces', 'mattermost', 'gitlab']));
  assert.ok(result.findings.every(row => row.projectId === 'lab' && row.foundAt === first));
  assert.ok(result.findings.every(row => !['mail-post', 'signal-post'].includes(row.sourceId)));
  assert.equal(result.findings.find(row => row.sourceId === 'spaces-post').postedBy, 'Anna Beispiel');
  assert.equal(result.findings.find(row => row.sourceId === 'mattermost-post').postedBy, 'Ben Beispiel');
  assert.equal(result.findings.find(row => row.sourceId === 'gitlab-summary').postedAt, '');
});

test('search matches title, observed post author, source title and URL; course filtering stays exact', () => {
  const rows = [
    finding({ title: 'Accessibility Workshop' }, { projectId: 'lab', postedBy: 'Anna Beispiel', title: 'Orga-Seminar' }),
    finding({ url: secondBoard, title: 'Prototyping' }, { projectId: 'design', id: 'u:design', postedBy: 'Ben Beispiel', title: 'Design-Studio' }),
    finding({ url: thirdBoard, title: 'Materiallabor' }, { projectId: '', id: 'note:unassigned', postedBy: '' }),
  ];
  assert.equal(groupBoards(rows, { query: '  ACCESSIBILITY  ' }).length, 1);
  assert.equal(groupBoards(rows, { query: 'aNnA bEiSpIeL' }).length, 1);
  assert.equal(groupBoards(rows, { query: 'orga-seminar' }).length, 1);
  assert.equal(groupBoards(rows, { query: 'uXjVSECOND01=' }).length, 1);
  assert.equal(groupBoards(rows, { query: 'board creator' }).length, 0);
  assert.equal(groupBoards(rows, { projectId: 'lab' }).length, 1);
  assert.equal(groupBoards(rows, { projectId: 'design', query: 'anna' }).length, 0);
  assert.equal(groupBoards(rows).length, 3);
});

test('title sorting and recent-source sorting are deterministic and do not mutate stored rows', () => {
  const rows = [
    finding({ title: 'Zebra' }, { id: 'u:old', postedAt: '2026-10-01T09:00:00Z' }, later),
    finding({ url: secondBoard, title: 'Alpha' }, { id: 'u:new', postedAt: '2026-10-12T09:00:00Z' }, first),
    finding({ url: thirdBoard, title: 'Beta' }, { id: 'note:fresh', postedAt: '' }, '2026-10-13T12:00:00.000Z'),
  ];
  const before = structuredClone(rows);
  assert.deepEqual(groupBoards(rows, { sort: 'title' }).map(group => group.title), ['Alpha', 'Beta', 'Zebra']);
  assert.deepEqual(groupBoards(rows, { sort: 'recent' }).map(group => group.title), ['Beta', 'Alpha', 'Zebra']);
  assert.deepEqual(rows, before);
});

test('generic link labels use an explicitly attributed source title instead of pretending to be Miro board titles', () => {
  for (const title of ['hier', 'Link', '🔗 Link ↗', 'Hier klicken', "Hier geht's zum Board", 'Miro', 'Miro-Board', 'Board 2', 'Whiteboard', 'URL', 'Open in Miro', board, 'miro.com/app/board/uXjVLABBOARD=/', 'uXjVLABBOARD=']) {
    const row = finding({ title }, { title: 'Interfaces beobachten und analysieren' });
    assert.equal(row.title, 'Board · Interfaces beobachten und analysieren', title);
    assert.equal(row.titleOrigin, 'reference', title);
    assert.equal(row.sourceTitle, 'Interfaces beobachten und analysieren');
    assert.equal(row.postedBy, 'Anna Beispiel');
    assert.equal(Object.hasOwn(row, 'boardCreator'), false);
    const [group] = groupBoards([row]);
    assert.equal(group.title, row.title);
    assert.equal(group.titleOrigin, 'reference');
  }
});

test('a generic page title falls back to the observed course name; lack of meaningful context stays unknown', () => {
  for (const title of ['', 'Home', 'Resources', 'Übersicht', 'Gespeicherte Quelle', 'Link']) {
    const row = finding({ title: 'hier' }, { title, projectTitle: 'Prototyping Things W2026/27' });
    assert.equal(row.title, 'Board · Prototyping Things W2026/27');
    assert.equal(row.titleOrigin, 'reference');
    assert.equal(row.sourceTitle, title || 'Gespeicherte Quelle');
    const [reloaded] = validateBoardFindings([row], ['lab']);
    assert.equal(reloaded.title, row.title);
    assert.equal(reloaded.titleOrigin, 'reference');
  }
  const unknown = finding({ title: 'Link' }, { title: '', projectTitle: '' });
  assert.equal(unknown.title, 'Miro-Board');
  assert.equal(unknown.titleOrigin, 'unknown');
  const noURLTitle = finding({ title: board }, { title: 'https://spaces.th-koeln.de/lab/?token=fixture' });
  assert.equal(noURLTitle.titleOrigin, 'unknown');
});

test('meaningful link titles remain verbatim observed labels, including useful names containing Miro or Board', () => {
  for (const title of ['Interface Workshop', 'Miro-Board für unsere Accessibility-Analyse', 'Design Board', 'Sandwich Challenge', 'Iteration 2: Usability-Test']) {
    const row = finding({ title }, { title: 'Allgemeine Kursseite' });
    assert.equal(row.title, title);
    assert.equal(row.titleOrigin, 'link');
    assert.deepEqual(validateBoardFindings([row], ['lab']), [row]);
  }
  const row = finding({ title: '<strong>Interfaces</strong> &amp; Team' });
  assert.equal(row.title, 'Interfaces & Team');
  assert.equal(row.titleOrigin, 'link');
});

test('old saved generic labels migrate to references and reference origins survive validation and export roundtrips', () => {
  const legacy = { ...finding(), title: 'hier', titleOrigin: 'link' };
  const [migrated] = validateBoardFindings([legacy], ['lab']);
  assert.equal(migrated.title, 'Board · Kursbeitrag zu Interfaces');
  assert.equal(migrated.titleOrigin, 'reference');
  assert.equal(migrated.id, legacy.id);
  assert.equal(migrated.foundAt, first);
  assert.deepEqual(validateBoardFindings(JSON.parse(JSON.stringify([migrated])), ['lab']), [migrated]);
});

test('duplicate extraction upgrades generic labels but never overwrites an existing meaningful link title', () => {
  const genericFirst = '[hier](' + board + ')\n<a href="' + board + '">Interfaces beobachten</a>\n[Link](' + board + ')';
  assert.deepEqual(extractBoardLinks(genericFirst), [{ url: board, title: 'Interfaces beobachten' }]);
  const usefulFirst = '[Accessibility Workshop](' + board + ')\n<a href="' + board + '">Anderer beobachteter Titel</a>';
  assert.deepEqual(extractBoardLinks(usefulFirst), [{ url: board, title: 'Accessibility Workshop' }]);
});

test('repeated findings upgrade references to meaningful link titles while stable good labels and manual titles win', () => {
  const generic = finding({ title: 'hier' }, { title: 'Interfaces beobachten' });
  const specific = finding({ title: 'Accessibility Workshop' }, {}, later);
  let [row] = mergeBoardFindings([generic], [specific]);
  assert.equal(row.title, 'Accessibility Workshop');
  assert.equal(row.titleOrigin, 'link');
  assert.equal(row.foundAt, first);
  [row] = mergeBoardFindings([row], [finding({ title: 'Anderer beobachteter Linktitel' }, {}, later)]);
  assert.equal(row.title, 'Accessibility Workshop');
  [row] = mergeBoardFindings([row], [finding({ title: 'Link' }, { title: 'Ein ausführlicher Kursbeitrag über andere Arbeitsmaterialien' }, later)]);
  assert.equal(row.title, 'Accessibility Workshop');
  const manuallyNamed = { ...generic, customTitle: 'hier' };
  [row] = mergeBoardFindings([manuallyNamed], [specific]);
  assert.equal(row.customTitle, 'hier');
  assert.equal(groupBoards([row])[0].title, 'hier');
  assert.equal(groupBoards([row])[0].titleOrigin, 'custom');
});

test('more descriptive observed reference context improves repeated findings without changing source attribution', () => {
  const old = finding({ title: 'Link' }, { title: 'Interfaces' });
  const fresh = finding({ title: 'hier' }, { title: 'Interfaces beobachten und analysieren: Gruppenaufgabe' }, later);
  const [row] = mergeBoardFindings([old], [fresh]);
  assert.equal(row.title, 'Board · Interfaces beobachten und analysieren: Gruppenaufgabe');
  assert.equal(row.titleOrigin, 'reference');
  assert.equal(row.sourceTitle, 'Interfaces beobachten und analysieren: Gruppenaufgabe');
  assert.equal(row.foundAt, first);
  const [preserved] = mergeBoardFindings([row], [old]);
  assert.equal(preserved.title, row.title);
});

test('grouped display prefers a useful link title over reference labels independent of occurrence order', () => {
  const ref = finding({ title: 'hier' }, { id: 'u:reference', title: 'Interfaces beobachten' });
  const observed = finding({ title: 'Accessibility Workshop' }, { id: 'u:useful' });
  const unknown = finding({ title: 'Link' }, { id: 'note:unknown', title: '', postedBy: '' });
  for (const rows of [[ref, observed, unknown], [unknown, observed, ref]]) {
    const [group] = groupBoards(rows);
    assert.equal(group.title, 'Accessibility Workshop');
    assert.equal(group.titleOrigin, 'link');
    assert.equal(group.occurrences.length, 3);
  }
});

test('local collection supplies actual course names for generic note, bookmark and update contexts', () => {
  const workspace = emptyWorkspace();
  workspace.projects = [{ id: 'lab', name: 'Prototyping Things W2026/27', archived: false, note: '', links: [] }];
  workspace.notes = [{ id: 'note', projectId: 'lab', title: 'Resources', content: '[hier](' + board + ')' }];
  workspace.bookmarks = [{ id: 'bookmark', projectId: 'lab', title: 'Link', url: secondBoard }];
  const updates = [{ id: 'post', source: 'spaces', title: 'Home', summary: '[Miro](' + thirdBoard + ')' }];
  const { findings } = collectLocalBoards({ workspace, updates, courseOf: () => 'lab' }, first);
  assert.equal(findings.length, 3);
  assert.ok(findings.every(row => row.title === 'Board · Prototyping Things W2026/27' && row.titleOrigin === 'reference'));
  assert.deepEqual(new Set(findings.map(row => row.sourceTitle)), new Set(['Resources', 'Link', 'Home']));
  assert.deepEqual(validateBoardFindings(findings, ['lab']), findings);
});
