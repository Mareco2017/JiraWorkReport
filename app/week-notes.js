import {readdir, readFile, realpath, stat} from 'node:fs/promises';
import {basename, join, resolve, dirname} from 'node:path';
import {createHash} from 'node:crypto';

const weekFilename = /^\d{1,2}月第\d+周\.md$/;
const weekdays = {一:0,二:1,三:2,四:3,五:4,六:5,日:6,天:6};
function sourceDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return '';
  const date = new Date(value + 'T12:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0,10) === value ? value : '';
}

/** Reads only explicit weekly files in the directory the user selected; it never opens linked resources. */
export class WeekNotes {
  constructor({directory}) { this.directory = resolve(directory); }

  async list() {
    const entries = await readdir(this.directory, {withFileTypes:true});
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !weekFilename.test(entry.name)) continue;
      const info = await stat(join(this.directory, entry.name));
      files.push({id:entry.name, name:entry.name, size:info.size, modifiedAt:info.mtime.toISOString()});
    }
    return files.sort((left,right)=>right.modifiedAt.localeCompare(left.modifiedAt) || left.name.localeCompare(right.name,'zh-CN',{numeric:true}));
  }

  async read(fileId) {
    if (typeof fileId !== 'string' || basename(fileId) !== fileId || !weekFilename.test(fileId)) {
      throw Object.assign(new Error('请选择目录中的周文件'), {code:'INVALID_FILE'});
    }
    const [root, file] = await Promise.all([realpath(this.directory), realpath(join(this.directory,fileId))]);
    if (dirname(file) !== root) throw Object.assign(new Error('周文件不能指向目录之外'), {code:'INVALID_FILE'});
    return readFile(file, 'utf8');
  }

  /** Dates and hours must be present in the source. A month/week filename alone does not establish calendar dates. */
  async parse(fileId, {weekStart} = {}) {
    const content = await this.read(fileId);
    const lines = content.replace(/\r\n?/g,'\n').split('\n');
    const result = {file:fileId, content, records:[], warnings:[]};
    const section = lines.findIndex(line=>/^##\s+本周工时记录\s*$/.test(line.trim()));
    if (section < 0) {
      result.warnings.push({code:'MISSING_SECTION',message:'未找到“本周工时记录”，请核对原文'});
      return result;
    }
    const explicitWeek = sourceDay(weekStart) || sourceDay(content.match(/^weekStart:\s*(\d{4}-\d{2}-\d{2})\s*$/m)?.[1]) ||
      sourceDay(content.match(/(\d{4}-\d{2}-\d{2})\s*(?:至|到|~|～|—|–)\s*\d{4}-\d{2}-\d{2}/)?.[1]);
    let day = '';
    for (let index = section + 1; index < lines.length; index++) {
      const raw = lines[index];
      const text = raw.trim();
      if (/^##\s/.test(text)) break;
      if (!text) continue;
      const heading = text.replace(/^#{1,6}\s*/, '');
      const dateMatch = heading.match(/^(\d{4}-\d{2}-\d{2})(?:\s|[：:]|$)/);
      const weekday = heading.match(/^(?:\d{4}-\d{2}-\d{2}\s+)?周([一二三四五六日天])\s*[：:]?$/);
      if (dateMatch || weekday) {
        day = dateMatch ? sourceDay(dateMatch[1]) : '';
        if (!dateMatch && explicitWeek) {
          const date = new Date(explicitWeek + 'T12:00:00Z');
          date.setUTCDate(date.getUTCDate() + weekdays[weekday[1]]);
          day = date.toISOString().slice(0,10);
        }
        continue;
      }
      const item = text.replace(/^[-*+]\s+(?:\[[ xX]\]\s*)?/, '');
      const time = item.match(/^([\d.]+)\s*(?:h|小时)\s+(.+)$/i);
      const parsedHours = time ? Number(time[1]) : NaN;
      const hours = Number.isFinite(parsedHours) && parsedHours >= .5 && parsedHours * 2 % 1 === 0 ? parsedHours : '';
      const title = (time ? time[2] : item).trim();
      if (!title || /^<!--/.test(title)) continue;
      const id = createHash('sha256').update(fileId + '\n' + (index + 1) + '\n' + raw).digest('hex').slice(0,24);
      const missing = [];
      if (!day) missing.push('day');
      if (hours === '') missing.push('hours');
      result.records.push({id, day, hours, title, type:'', issue:'', task:'', source:'批量填报', sourceFile:fileId, sourceLine:index + 1, sourceText:raw, missing});
    }
    return result;
  }
}
