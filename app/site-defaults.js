import {readFile} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';

/** 本机部署配置只在启动入口读取；没有私有文件的源码使用随仓库提供的示例。 */
export async function loadSiteDefaults(directory) {
  let content;
  try {
    content = await readFile(join(directory,'site-defaults.local.json'),'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    content = await readFile(join(directory,'site-defaults.example.json'),'utf8');
  }
  const settings = JSON.parse(content);
  if (!settings || typeof settings.projectKey !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(settings.projectKey) ||
      !Array.isArray(settings.trustedModelOrigins) ||
      !settings.trustedModelOrigins.every(origin => {
        if (typeof origin !== 'string') return false;
        try { const url = new URL(origin); return url.protocol === 'https:' && url.origin === origin; }
        catch { return false; }
      }) || typeof settings.notesRelativeDirectory !== 'string' ||
      isAbsolute(settings.notesRelativeDirectory) || settings.notesRelativeDirectory.split(/[\\/]/).includes('..')) {
    throw new Error('站点配置格式不正确，请核对项目标识、模型来源和笔记相对路径。');
  }
  return settings;
}
