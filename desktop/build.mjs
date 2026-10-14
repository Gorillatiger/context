import {execFileSync} from 'node:child_process';
import {packager} from '@electron/packager';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {cp,mkdir,rename,stat,chmod,writeFile} from 'node:fs/promises';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const targetPlatform=process.platform;
const out=process.env.CONTEXT_DESKTOP_BUILD_DIR?path.resolve(process.env.CONTEXT_DESKTOP_BUILD_DIR):path.resolve(root,'../../work/context-electron-build');
const {version}=JSON.parse(await (await import('node:fs/promises')).readFile(path.join(root,'package.json'),'utf8'));
execFileSync(process.execPath,[path.join(root,'desktop/build-speech.mjs')],{stdio:'inherit'});
if(targetPlatform==='darwin'){
const ocrHelper=path.join(root,'desktop/ocr-helper'),swiftCache=path.resolve(root,'../../work/swift-module-cache');
await mkdir(swiftCache,{recursive:true});
// Apple recommends an embedded Info.plist identity for single-file tools.
const ocrInfo=path.join(swiftCache,'ocr-helper-info.plist');
await writeFile(ocrInfo,'<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.hazylabs.context.ocr</string><key>CFBundleName</key><string>Context OCR</string><key>CFBundleExecutable</key><string>ocr-helper</string><key>CFBundleInfoDictionaryVersion</key><string>6.0</string><key>CFBundleVersion</key><string>1</string></dict></plist>');
execFileSync('/usr/bin/xcrun',['swiftc','-O','-target',(process.arch==='arm64'?'arm64':'x86_64')+'-apple-macosx13.0','-module-cache-path',swiftCache,'-Xlinker','-sectcreate','-Xlinker','__TEXT','-Xlinker','__info_plist','-Xlinker',ocrInfo,'-framework','Vision','-framework','ImageIO','-framework','CoreGraphics',path.join(root,'desktop/ocr.swift'),'-o',ocrHelper],{stdio:'inherit'});
const documentHelper=path.join(root,'desktop/document-helper');
const documentInfo=path.join(swiftCache,'document-helper-info.plist');
await writeFile(documentInfo,'<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.hazylabs.context.documents</string><key>CFBundleName</key><string>Context Documents</string><key>CFBundleExecutable</key><string>document-helper</string><key>CFBundleInfoDictionaryVersion</key><string>6.0</string><key>CFBundleVersion</key><string>1</string></dict></plist>');
execFileSync('/usr/bin/xcrun',['swiftc','-O','-target',(process.arch==='arm64'?'arm64':'x86_64')+'-apple-macosx13.0','-module-cache-path',swiftCache,'-Xlinker','-sectcreate','-Xlinker','__TEXT','-Xlinker','__info_plist','-Xlinker',documentInfo,'-framework','PDFKit','-framework','Vision','-framework','AppKit','-framework','CoreGraphics',path.join(root,'desktop/document-helper.swift'),'-o',documentHelper],{stdio:'inherit'});
await chmod(documentHelper,0o755);
execFileSync('/usr/bin/codesign',['--force','--sign','-',documentHelper],{stdio:'inherit'});
await chmod(ocrHelper,0o755);
execFileSync('/usr/bin/codesign',['--force','--sign','-',ocrHelper],{stdio:'inherit'});
}
const apps=await packager({dir:root,out,name:'Context Browser',platform:targetPlatform,arch:process.arch,electronVersion:'44.7.0',appVersion:version,extendInfo:{NSMicrophoneUsageDescription:'Context verarbeitet deine Sprache ausschließlich lokal auf diesem Gerät. Audio wird nicht gespeichert.'},appBundleId:'dev.hazylabs.context',asar:{unpack:'**/{*.py,ocr-helper,document-helper,document-worker.mjs,speech-helper,speech-helper.exe,*.dylib,*.dll,*.so}'},overwrite:true,prune:true,ignore:[ /^\/node_modules\b/,/^\/mac\b/,/^\/tests\b/,/^\/\.git(?:\/|$)/,/^\/\.openai(?:\/|$)/,/^\/.env/,/^\/.*\.zip$/,/^\/.*(?:-qa|-benchmark)[^/]*$/,/^\/(?:VALIDIERUNG\.md|search-cache-benchmark\.json|search-pagination-benchmark\.json|speech-extra-cases\.json)$/,/^\/[^/]*\.(?:png|jpe?g|log)$/],download:{cacheRoot:path.resolve(root,'../../work/electron-cache')}});
if(targetPlatform!=='darwin'){console.log('Built '+apps[0]);process.exit(0);}
const destination='/private/tmp/context-browser-runtime/Context Browser.app';
await mkdir(path.dirname(destination),{recursive:true});
try{await stat(destination);await rename(destination,path.join(out,'previous-'+Date.now()+'.app'));}catch(error){if(error.code!=='ENOENT')throw error;}
await cp(path.join(apps[0],'Context Browser.app'),destination,{recursive:true,verbatimSymlinks:true});
for(const attribute of ['com.apple.FinderInfo','com.apple.ResourceFork']){try{execFileSync('/usr/bin/xattr',['-dr',attribute,destination],{stdio:'ignore'});}catch{}}
execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-',destination],{stdio:'inherit'});
execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',destination],{stdio:'inherit'});
console.log('Built '+destination);
