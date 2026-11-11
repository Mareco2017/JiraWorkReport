import {readdir,readFile,realpath,lstat,stat} from 'node:fs/promises';
import {basename,dirname,extname,join,resolve} from 'node:path';
import mammoth from 'mammoth';

const extensions=new Set(['.md','.txt','.docx']);
const fail=(code,message)=>Object.assign(new Error(message),{code});

/** 本地导入的唯一读取入口：只取所选目录第一层文字，不跟随链接或解释文内指令。 */
export class DocumentDirectory {
  constructor({directory}) {this.directory=resolve(directory);}

  async list() {
    const entries=await readdir(this.directory,{withFileTypes:true});
    const files=[];
    for(const entry of entries) {
      const extension=extname(entry.name).toLowerCase();
      if(!entry.isFile()||!extensions.has(extension))continue;
      const info=await stat(join(this.directory,entry.name));
      files.push({id:entry.name,name:entry.name,extension,size:info.size,modifiedAt:info.mtime.toISOString()});
    }
    return files.sort((left,right)=>right.modifiedAt.localeCompare(left.modifiedAt)||left.name.localeCompare(right.name,'zh-CN',{numeric:true}));
  }

  /** 预览与识别共用这里的完整文字；调用方缓存本次结果，解析时不偷偷重读磁盘。 */
  async read(fileId) {
    validateFileId(fileId);
    const path=join(this.directory,fileId);
    const [root,file,info]=await Promise.all([realpath(this.directory),realpath(path),lstat(path)]);
    if(!info.isFile()||dirname(file)!==root)throw fail('INVALID_FILE','请选择目录第一层的普通文档，不能读取文件链接。');
    const buffer=await readFile(file);
    const content=extname(fileId).toLowerCase()==='.docx'?await readWord(buffer):decodeText(buffer);
    return content.replace(/\r\n?/g,'\n');
  }
}

// 文件名来自IPC输入；同时拒绝两平台分隔符，不能靠列表隐藏代替读取入口检查。
function validateFileId(fileId) {
  if(typeof fileId!=='string'||basename(fileId)!==fileId||/[\\/\0]/.test(fileId)||!extensions.has(extname(fileId).toLowerCase())) {
    throw fail('INVALID_FILE','请选择目录第一层的 .md、.txt 或 .docx 文档。');
  }
}

// 只有明确BOM才采用UTF-16；fatal阻止乱码替换字符被当成正常正文交给Agent。
function decodeText(buffer) {
  let encoding='utf-8',offset=0;
  if(buffer[0]===0xff&&buffer[1]===0xfe){encoding='utf-16le';offset=2;}
  else if(buffer[0]===0xfe&&buffer[1]===0xff){encoding='utf-16be';offset=2;}
  else if(buffer[0]===0xef&&buffer[1]===0xbb&&buffer[2]===0xbf)offset=3;
  try {
    const content=new TextDecoder(encoding,{fatal:true}).decode(buffer.subarray(offset));
    if(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(content))throw new Error('binary');
    return content;
  } catch {
    throw fail('DOCUMENT_ENCODING','无法读取文档文字，请另存为 UTF-8 文本后重试。');
  }
}

// extractRawText会丢弃Word段内换行；固定Mammoth 1.13.0的公开transformDocument钩子先取纯文。
// 返回空文档避免转换原内容、图片或链接；升级依赖时必须重跑真实Word回归。
async function readWord(buffer) {
  try {
    let value='';
    await mammoth.convertToHtml({buffer},{
      externalFileAccess:false,
      includeDefaultStyleMap:false,
      includeEmbeddedStyleMap:false,
      transformDocument(document) {
        value=wordText(document);
        return {...document,children:[]};
      }
    });
    if(!value.trim())throw new Error('empty');
    return value;
  } catch {
    throw fail('DOCUMENT_READ_FAILED','无法读取 Word 文档或文档中没有可提取文字，请检查文件后重试。');
  }
}

// Word树保留原顺序；仅补充纯文字必要分隔，不恢复样式或创建HTML解释器。
function wordText(element) {
  if(element.type==='text')return element.value;
  if(element.type==='tab')return '\t';
  if(element.type==='break')return '\n';
  return (element.children||[]).map(wordText).join('')+(element.type==='paragraph'?'\n\n':'');
}
