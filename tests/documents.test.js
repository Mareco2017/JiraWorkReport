import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,symlink,rm,utimes,stat,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DocumentDirectory} from '../app/documents.js';
import mammoth from 'mammoth';
import fs from 'node:fs';

async function workspace(t) {
  const directory=await mkdtemp(join(tmpdir(),'jira-documents-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return {directory,documents:new DocumentDirectory({directory})};
}

// A small, genuine OOXML ZIP fixture exercises the installed reader, including table cells;
// it deliberately contains no macros, images, remote relations or office-software dependency.
function wordDocument(body,relationships='') {
  const entries={
    '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml':`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}</w:body></w:document>`,
    ...(relationships?{'word/_rels/document.xml.rels':`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`}:{})
  };
  const locals=[],centrals=[];let offset=0;
  for(const [path,text] of Object.entries(entries)) {
    const name=Buffer.from(path),data=Buffer.from(text);
    let crc=0xffffffff;
    for(const byte of data){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    crc=(crc^0xffffffff)>>>0;
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
    locals.push(local,name,data);centrals.push(central,name);offset+=local.length+name.length+data.length;
  }
  const central=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(centrals.length/2,8);end.writeUInt16LE(centrals.length/2,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,central,end]);
}

test('TC-002 lists arbitrary supported first-level documents with mtime and numeric name order',async t=>{
  const {directory,documents}=await workspace(t);
  const names=['会议记录.MD','项目随记.txt','评审纪要.DocX','11月第2周.md','README.md','记录2.md','记录10.md','忽略.pdf','旧版.doc','表格.xlsx'];
  for(const name of names){await writeFile(join(directory,name),'文字');await utimes(join(directory,name),new Date('2026-11-01'),new Date('2026-11-01'));}
  await utimes(join(directory,names[0]),new Date('2026-11-10'),new Date('2026-11-10'));
  await utimes(join(directory,names[1]),new Date('2026-11-09'),new Date('2026-11-09'));
  await mkdir(join(directory,'子目录'));await writeFile(join(directory,'子目录','下层.md'),'下层');
  await symlink(join(directory,'README.md'),join(directory,'链接.md'));
  const files=await documents.list();
  assert.deepEqual(new Set(files.map(f=>f.id)),new Set(names.slice(0,7)));
  assert.deepEqual(files.slice(0,2).map(f=>f.name),names.slice(0,2));
  assert.ok(files.findIndex(f=>f.id==='记录2.md')<files.findIndex(f=>f.id==='记录10.md'));
  assert.equal(files.find(f=>f.id==='评审纪要.DocX').extension,'.docx');
  assert.ok(files.every(f=>typeof f.size==='number'&&/^2026-/.test(f.modifiedAt)));
});

test('TC-003 read rejects traversal, nested paths, unsupported formats and symbolic links',async t=>{
  const {directory,documents}=await workspace(t);
  const outside=await mkdtemp(join(tmpdir(),'jira-document-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));
  await writeFile(join(outside,'outside.md'),'NEVER_RETURN');
  await writeFile(join(directory,'普通.md'),'有效原文');await mkdir(join(directory,'inside'));
  await symlink(join(outside,'outside.md'),join(directory,'外链.md'));
  await symlink(join(directory,'普通.md'),join(directory,'内链.md'));
  for(const name of ['../outside.md',join(outside,'outside.md'),'inside/文件.md','inside\\文件.md','非法.pdf','外链.md','内链.md']) {
    await assert.rejects(documents.read(name),error=>error.code==='INVALID_FILE',name);
  }
  assert.equal(await documents.read('普通.md'),'有效原文');
});

test('TC-004 UTF-8 and BOM UTF-16 decoding preserves markdown/tab/paragraphs and leaves files unchanged',async t=>{
  const {directory,documents}=await workspace(t);
  const raw='# 标题\r\n第一行\tEnglish\r第二行\n\n最后一段';
  const le=Buffer.from(raw,'utf16le'),be=Buffer.from(le);be.swap16();
  const encodings=[Buffer.from(raw),Buffer.concat([Buffer.from([239,187,191]),Buffer.from(raw)]),Buffer.concat([Buffer.from([255,254]),le]),Buffer.concat([Buffer.from([254,255]),be])];
  for(let n=0;n<encodings.length;n++) {
    const name=`记录${n}.${n%2?'txt':'md'}`,path=join(directory,name);await writeFile(path,encodings[n]);const before=await stat(path);
    assert.equal(await documents.read(name),raw.replace(/\r\n?/g,'\n'));
    assert.deepEqual(await readFile(path),encodings[n]);assert.equal((await stat(path)).mtimeMs,before.mtimeMs);
  }
});

test('TC-005 invalid UTF-8, NUL binary and malformed UTF-16 fail without replacement text',async t=>{
  const {directory,documents}=await workspace(t);
  for(const [n,data] of [Buffer.from([0xc4,0xe3]),Buffer.from('abc\0xyz'),Buffer.from([255,254,65]),Buffer.from([255,254,0,216])].entries()) {
    const name=`错误${n}.txt`;await writeFile(join(directory,name),data);
    await assert.rejects(documents.read(name),error=>error.code==='DOCUMENT_ENCODING'&&/UTF-8/.test(error.message));
  }
});

test('TC-006 real Word body, line breaks and table cells retain text order and separation',async t=>{
  const {directory,documents}=await workspace(t);
  const paragraph=text=>`<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const row=cells=>`<w:tr>${cells.map(text=>`<w:tc>${paragraph(text)}</w:tc>`).join('')}</w:tr>`;
  const data=wordDocument(paragraph('评审纪要')+'<w:p><w:r><w:t>完成范围核对</w:t><w:br/><w:t>English</w:t><w:tab/><w:t>补充</w:t></w:r></w:p>'+`<w:tbl>${row(['日期','事项','耗时'])}${row(['2026-10-30','梳理筛选场景','2.5小时'])}${row(['2026-11-02','整理规格','90分钟'])}</w:tbl>`);
  const path=join(directory,'评审纪要.docx');await writeFile(path,data);const result=await documents.read('评审纪要.docx');
  const expected=['评审纪要','完成范围核对','English','日期','事项','耗时','2026-10-30','梳理筛选场景','2.5小时','2026-11-02','整理规格','90分钟'];
  let previous=-1;for(const text of expected){const at=result.indexOf(text,previous+1);assert.ok(at>previous,text);previous=at;}
  assert.match(result,/日期\s+事项\s+耗时/);assert.match(result,/完成范围核对\nEnglish\t补充/);
  assert.deepEqual(await readFile(path),data);
});

test('TC-007 corrupt, disguised and empty Word documents are reading errors',async t=>{
  const {directory,documents}=await workspace(t);
  for(const [n,data] of [Buffer.from('PK\x03\x04broken'),Buffer.from('这是普通文本'),wordDocument('<w:p/>')].entries()) {
    const name=`损坏${n}.docx`;await writeFile(join(directory,name),data);
    await assert.rejects(documents.read(name),error=>error.code==='DOCUMENT_READ_FAILED'&&/文档|文字/.test(error.message));
  }
});


test('TC-006 Word preview extracts text without converting images, reading external files or fetching links',async t=>{
  const {directory,documents}=await workspace(t);
  const external=join(directory,'图片哨兵.png');await writeFile(external,'NEVER_READ_IMAGE');
  const originalRead=fs.readFile;let externalReads=0;
  t.mock.method(fs,'readFile',function(path,...args){if(String(path).includes('图片哨兵'))externalReads++;return originalRead.call(this,path,...args);});
  // Count an actual image node before the adapter clears the tree, so a malformed
  // fixture cannot make a zero-conversion assertion pass accidentally.
  const originalConvert=mammoth.convertToHtml;let imageNodes=0,generatedHtml;
  t.mock.method(mammoth,'convertToHtml',async(input,options)=>{
    const result=await originalConvert(input,{...options,transformDocument(document){
      imageNodes=mammoth.transforms.getDescendantsOfType(document,'image').length;
      return options.transformDocument(document);
    }});
    generatedHtml=result.value;return result;
  });
  const imageConversion=t.mock.method(mammoth.images,'dataUri',()=>{throw new Error('must not convert image');});
  const requests=t.mock.method(globalThis,'fetch',()=>{throw new Error('must not fetch document link');});
  const image='<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:link="image1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  const body='<w:p><w:hyperlink r:id="link1"><w:r><w:t>原文链接文字</w:t></w:r></w:hyperlink></w:p>'+image;
  const relationships=`<Relationship Id="image1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${external}" TargetMode="External"/><Relationship Id="link1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://fixture.invalid/must-not-read" TargetMode="External"/>`;
  const data=wordDocument(body,relationships),path=join(directory,'图片与链接.docx');await writeFile(path,data);
  const result=await documents.read('图片与链接.docx');
  assert.equal(result.trim(),'原文链接文字');assert.equal(imageNodes,1);assert.equal(generatedHtml,'');
  assert.equal(imageConversion.mock.callCount(),0);
  assert.equal(externalReads,0);assert.equal(requests.mock.callCount(),0);
  assert.deepEqual(await readFile(path),data);
});
