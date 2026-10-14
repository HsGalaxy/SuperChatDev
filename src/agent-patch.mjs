// Small, line-number-free patch dialect inspired by *** Begin Patch syntax.
// All target paths are strictly project-relative. No rename or binary edits.
import path from 'node:path';

const linesOf = text => text.match(/[^\n]*\n|[^\n]+$/g) || [];
const rawLine = line => line.endsWith('\n') ? line.slice(0, -1) : line;
function filePath(value) {
  if (!value || /[\0\r\t]/.test(value) || path.isAbsolute(value) ||
      value.split('/').some(part => !part || part === '.' || part === '..') ||
      value.includes('\\')) throw new Error('Patch paths must be plain relative paths without traversal');
  return value;
}

export function parseAgentPatch(patch) {
  // CRLF in the patch transport is not meaningful to the source file style.
  const lines = linesOf(patch.replace(/\r\n/g, '\n'));
  if (rawLine(lines[0] || '') !== '*** Begin Patch') throw new Error('Expected *** Begin Patch');
  const files = [];
  let i=1;
  let ended=false;
  while (i<lines.length) {
    const line=rawLine(lines[i]);
    if (line === '*** End Patch') {
      if (i !== lines.length-1) throw new Error('Unexpected text after *** End Patch');
      ended=true; break;
    }
    const match=line.match(/^\*\*\* (Add File|Update File|Delete File): (.+)$/);
    if (!match) throw new Error('Expected *** Add/Update/Delete File header');
    const action=match[1], file={path:filePath(match[2]),create:action==='Add File',remove:action==='Delete File',hunks:[]};
    if (files.some(item=>item.path===file.path)) throw new Error('A patch cannot list the same file twice');
    files.push(file);
    if (files.length>32) throw new Error('Patch exceeds 32 files');
    i++;
    if (file.remove) {
      if (i < lines.length && !rawLine(lines[i]).startsWith('*** '))
        throw new Error('Delete File does not accept inline file content');
      file.deleteAll=true;continue;
    }
    if (file.create) {
      const ops=[];
      while (i<lines.length && !rawLine(lines[i]).startsWith('*** ')) {
        const item=lines[i++];
        if (!item.startsWith('+')) throw new Error('Add File requires + lines');
        ops.push({kind:'+',line:item.slice(1)});
      }
      if (!ops.length) throw new Error('Add File requires content');
      file.hunks.push({oldStart:0,oldCount:0,newStart:1,newCount:ops.length,old:[],next:ops.map(op=>op.line),ops});
      continue;
    }
    while (i<lines.length && !rawLine(lines[i]).startsWith('*** ')) {
      const header=rawLine(lines[i++]);
      if (!header.startsWith('@@')) throw new Error('Update File requires @@ context header');
      const anchor=header.slice(2).trim();
      const ops=[];
      while (i<lines.length && !rawLine(lines[i]).startsWith('@@') && !rawLine(lines[i]).startsWith('*** ')) {
        const row=lines[i++];
        if (![' ','+','-'].includes(row[0])) throw new Error('Invalid agent patch line');
        const op={kind:row[0],line:row.slice(1)};
        ops.push(op);
        if (rawLine(lines[i] ?? '')==='\\ No newline at end of file') {
          i++;
          op.line=op.line.replace(/\n$/, '');
        }
      }
      const old=ops.filter(op=>op.kind!=='+').map(op=>op.line);
      const next=ops.filter(op=>op.kind!=='-').map(op=>op.line);
      if (!ops.length || !ops.some(op=>op.kind!== ' '))
        throw new Error('Update hunk must contain changes');
      file.hunks.push({oldStart:null,newStart:null,oldCount:old.length,newCount:next.length,old,next,ops,agent:true,anchor});
    }
    if (!file.hunks.length) throw new Error('Update File requires at least one hunk');
  }
  if (!ended || !files.length) throw new Error('Agent patch missing ending marker or file changes');
  return files;
}
