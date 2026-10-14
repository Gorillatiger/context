// Real Chromium DOM verification. Uses a fresh in-memory partition, intercepts
// its HTTPS fixture locally, and never loads a provider or a user's session.
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const {mkdtempSync,rmSync}=require('node:fs');
const fixtureData=mkdtempSync(path.join(require('node:os').tmpdir(),'context-reader-data-'));
app.setPath('userData',fixtureData);app.setPath('sessionData',fixtureData);app.setPath('logs',fixtureData);
app.disableHardwareAcceleration();
const COURSE='https://spaces.th-koeln.de/synthetic-course/',PAGE=COURSE+'orga/resources/';
const REPO='https://git.coco.study/course/project',BOARD='https://miro.com/app/board/synthetic-board=/';
const FOLDER='https://th-koeln.sciebo.de/s/Synthetic_share?path=%2FCourse',CHANNEL='https://chat.coco.study/students/channels/robotics';
const markup=`<!doctype html><html lang="de"><head><title>Unterrichtsmaterial</title><style>body{margin:20px;font:16px sans-serif}article{padding:20px}.css-hidden{visibility:hidden}.opacity-hidden{opacity:0}</style></head><body>
  <nav><a href="${REPO}-global">PRIVATE_NAV</a></nav>
  <main id="swap-container"><article><h2 class="entry-title"><a rel="bookmark" href="${PAGE}article/">Aufgaben Woche 1</a></h2>
    <a rel="author" href="https://spaces.th-koeln.de/members/teacher/">Anna Lehrerin</a><time datetime="2026-10-14T09:00:00+02:00">vor drei Minuten</time>
    <p>Analysiere die Aufgabenstellung.</p><a id="board" href="${BOARD}?share_link_id=PRIVATE_INVITE">Aufgabenboard</a>
    <a id="repo" href="${REPO}">Abgabeprojekt <span contenteditable="true">PRIVATE_DRAFT</span><span hidden>PRIVATE_HIDDEN</span></a>
    <a href="${FOLDER}">Materialordner</a><a href="${CHANNEL}">Kurschat</a>
    <a class="css-hidden" href="${REPO}-css">PRIVATE_CSS</a><div class="opacity-hidden"><a href="${REPO}-opacity">PRIVATE_OPACITY</a></div>
    <form><input value="PRIVATE_PASSWORD"/><a href="${REPO}-form">PRIVATE_FORM</a></form>
    <a href="${REPO}/-/blob/main/.env.production">Zugangsdaten</a><a href="https://chat.coco.study/error?message=PRIVATE">Fehlerseite</a>
    <div class="comment-body"><a href="${REPO}-comment">Kommentarprojekt</a></div>
  </article></main>
  <aside id="defaultspace-sticky-sidebar"><a href="${REPO}-sidebar">Kursablage</a><div>PRIVATE_PROFILE</div></aside>
</body></html>`;
let win;
const cleanup=()=>{win?.destroy();rmSync(fixtureData,{recursive:true,force:true});};
const timeout=setTimeout(()=>{console.error('Reader Chromium verification timed out.');cleanup();app.exit(1);},30000);
app.whenReady().then(async()=>{
  const {readScript}=await import(pathToFileURL(path.resolve(__dirname,'../desktop/reader.mjs')).href);
  win=new BrowserWindow({show:false,width:1000,height:700,webPreferences:{partition:'reader-platform-fixture-'+Date.now(),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  win.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  win.webContents.session.protocol.handle('https',request=>new Response(request.url===PAGE?markup:'Fixture access denied',{status:request.url===PAGE?200:403,headers:{'content-type':'text/html; charset=utf-8'}}));
  await win.loadURL(PAGE);
  const records=[];
  for(const crawler of [false,true]){
    const code=readScript(0,{crawler,...(crawler?{courseURL:COURSE}:{})}),before=await win.webContents.executeJavaScriptInIsolatedWorld(1001,[{code}]);
    assert.deepEqual(before.platformLinks.map(row=>row.service),['miro','gitlab','sciebo','mattermost','gitlab','gitlab']);
    assert.equal(before.platformLinks[1].title,'Abgabeprojekt');assert.equal(before.platformLinks[0].postedBy,'Anna Lehrerin');assert.equal(before.platformLinks[0].postedAt,'2026-10-14T07:00:00.000Z');
    for(const row of before.platformLinks)assert.equal(row.sourceURL,PAGE);
    assert.equal(before.platformLinks[4].postedBy,'');assert.equal(before.platformLinks[5].postedBy,'');
    assert.equal(before.platformLinksMore,false);assert.match(before.contentRevision,/^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(before.platformLinks),/PRIVATE_|\.env|error\?/);
    await win.webContents.executeJavaScript(`document.getElementById('repo').href=${JSON.stringify(REPO+'-changed-'+crawler)};`);
    const after=await win.webContents.executeJavaScriptInIsolatedWorld(1001,[{code}]);assert.notEqual(after.contentRevision,before.contentRevision);assert.equal(after.platformLinks[1].url,REPO+'-changed-'+crawler);
    records.push({mode:crawler?'crawler':'normal',links:before.platformLinks.length,checks:'visible metadata, hidden/form/secret exclusions, course witness, href revision'});
  }
  console.log(JSON.stringify({ok:true,platform:process.platform,arch:process.arch,electron:process.versions.electron,chromium:process.versions.chrome,fixtureOnly:true,records}));
  clearTimeout(timeout);cleanup();app.exit(0);
}).catch(error=>{clearTimeout(timeout);console.error(error.stack||error.message);cleanup();app.exit(1);});
