// The finance upload acts on a Drive file id sent by the browser (make it public, delete it). It
// must only ever touch a file that lies in the finance attachments folder — root → year →
// transaction → file. Checked here against a fake Drive (global fetch stubbed).
//   node tests/finance-upload-guard.test.mjs
import { _insideRootForTests as insideRoot } from '../api/_finance-upload.js';

let failed = 0, passed = 0;
const check = (label, cond) => { if (cond) { passed++; console.log('  ok  ' + label); } else { failed++; console.log('  FAIL ' + label); } };

// A tiny Drive: id → parents.
const DRIVE = {
  ROOTFOLDER0001: [], FY2026FOLDER01: ['ROOTFOLDER0001'], TXN000000001: ['FY2026FOLDER01'], FILE00000001: ['TXN000000001'],
  INVENTORYSHEET1: ['SALESDRIVEROOT'], SALESDRIVEROOT: [], DEEPFILE000001: ['L4FOLDER00001'], L4FOLDER00001: ['L3FOLDER00001'],
  L3FOLDER00001: ['L2FOLDER00001'], L2FOLDER00001: ['L1FOLDER00001'], L1FOLDER00001: ['ROOTFOLDER0001']
};
globalThis.fetch = async url => {
  const id = decodeURIComponent(String(url).split('/files/')[1].split('?')[0]);
  if (!(id in DRIVE)) return new Response(JSON.stringify({ error: { message: 'File not found' } }), { status: 404 });
  const folder = /FOLDER|^TXN/.test(id) && !/^FILE|SHEET/.test(id);
  return new Response(JSON.stringify({ parents: DRIVE[id], mimeType: folder ? 'application/vnd.google-apps.folder' : 'application/pdf' }), { status: 200 });
};

console.log('3 PIN Realty — finance upload: only finance attachments\n');
check('A file in root → year → transaction is a finance attachment', await insideRoot('t', 'FILE00000001', 'ROOTFOLDER0001'));
check('The inventory sheet (elsewhere on the Drive) is not', !(await insideRoot('t', 'INVENTORYSHEET1', 'ROOTFOLDER0001')));
check('…nor a file buried deeper than the attachment layout', !(await insideRoot('t', 'DEEPFILE000001', 'ROOTFOLDER0001')));
check('…nor a transaction folder (deleting it would take every attachment in it)', !(await insideRoot('t', 'TXN000000001', 'ROOTFOLDER0001')));
check('…nor a year folder', !(await insideRoot('t', 'FY2026FOLDER01', 'ROOTFOLDER0001')));
check('…nor the root itself', !(await insideRoot('t', 'ROOTFOLDER0001', 'ROOTFOLDER0001')));
check('…nor an id that is not a Drive id at all', !(await insideRoot('t', '../../etc', 'ROOTFOLDER0001')) && !(await insideRoot('t', '', 'ROOTFOLDER0001')));
let threw = false;
try { await insideRoot('t', 'UNKNOWNFILE01', 'ROOTFOLDER0001'); } catch (e) { threw = e.status === 404; }
check('A file this credential cannot see: the error is passed on (the other credential is tried)', threw);

console.log(failed ? `\n${failed} failed, ${passed} passed.` : `\nAll good (${passed} checks).`);
process.exit(failed ? 1 : 0);
