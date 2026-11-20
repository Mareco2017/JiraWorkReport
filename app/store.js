import {validateTodoState} from './todo-data.js';
import {mkdir, readFile, writeFile, rename, rm} from 'node:fs/promises';
import {join, resolve, dirname} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

const pendingWrites = new Map();
const emptyWorkspace = () => ({drafts:[], batches:[], bindings:{}, settings:{}, history:[]});

async function readJson(file, fallback) {
  let content;
  try { content = await readFile(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback();
    throw error;
  }
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid root');
    return parsed;
  }
  catch {
    return {...fallback(), recovery:{code:'DATA_DAMAGED',message:'本地数据无法读取，原文件已保留。新建记录会另行保存。'}};
  }
}

async function readWorkspace(file) {
  const state = await readJson(file,emptyWorkspace);
  if (!Array.isArray(state.drafts) || !Array.isArray(state.batches) || !Array.isArray(state.history) || !state.bindings || !state.settings) {
    return {...emptyWorkspace(),recovery:{code:'DATA_DAMAGED',message:'本地工作台数据格式无法读取，原文件已保留。'}};
  }
  return state;
}

// Atomic replacement avoids exposing half-written drafts to a second window or a restart.
async function replaceJson(file, data, damaged) {
  await mkdir(dirname(file), {recursive:true});
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(data, null, 2), {mode:0o600,flag:'wx'});
    if (damaged) await rename(file, file.replace(/\.json$/,'.damaged.json'));
    await rename(temporary, file);
  } finally {
    await rm(temporary,{force:true});
  }
}

function serialize(file, operation) {
  const previous = pendingWrites.get(file) || Promise.resolve();
  const next = previous.catch(()=>{}).then(operation);
  pendingWrites.set(file,next);
  next.finally(()=>{
    if (pendingWrites.get(file) === next) pendingWrites.delete(file);
  }).catch(()=>{});
  return next;
}

// ENOENT alone means a first-use empty list; every other read failure preserves the original file.
async function readPersonalTodos(file) {
  let content;
  try { content = await readFile(file,'utf8'); }
  catch(error) {
    if(error.code==='ENOENT')return {groups:[],todos:[]};
    throw Object.assign(new Error('本机待办读取失败，请检查文件权限后重试'),{code:'TODO_READ_FAILED'});
  }
  try {return validateTodoState(JSON.parse(content));}
  catch {throw Object.assign(new Error('本机待办文件无法读取，原文件已保留，请恢复有效文件后重试'),{code:'TODO_READ_FAILED'});}
}

/** The main process owns all workspace changes; renderer pages share one account-scoped state. */
export class Store {
  constructor(root) { this.root = resolve(root); }

  workspacePath({site,project,user}) {
    const origin = new URL(site);
    const normalizedSite = origin.origin + origin.pathname.replace(/\/$/,'');
    const id = createHash('sha256').update(JSON.stringify([normalizedSite,project,user])).digest('hex');
    return join(this.root,'workspaces',id + '.json');
  }

  async load(scope) {
    const file = this.workspacePath(scope);
    await (pendingWrites.get(file) || Promise.resolve()).catch(()=>{});
    return readWorkspace(file);
  }

  async update(scope, change) {
    const file = this.workspacePath(scope);
    return serialize(file, async()=>{
      const state = await readWorkspace(file);
      const damaged = Boolean(state.recovery);
      delete state.recovery;
      const updated = await change(state) || state;
      await replaceJson(file,updated,damaged);
      return updated;
    });
  }

  async loadPersonalTodos() {
    const file=join(this.root,'personal-todos.json');
    await (pendingWrites.get(file)||Promise.resolve()).catch(()=>{});
    return readPersonalTodos(file);
  }

  // Read inside the existing per-file queue so separate commands never replace each other's changes.
  async updatePersonalTodos(change) {
    const file=join(this.root,'personal-todos.json');
    return serialize(file,async()=>{
      const state=await readPersonalTodos(file);
      await change(state);
      try {await replaceJson(file,state,false);}
      catch {throw Object.assign(new Error('本机待办保存失败，原数据已保留，请检查写入权限后重试'),{code:'TODO_SAVE_FAILED'});}
      return state;
    });
  }

  async loadConfig() {
    const file = join(this.root,'settings.json');
    await (pendingWrites.get(file) || Promise.resolve()).catch(()=>{});
    return readJson(file,()=>({}));
  }

  async saveConfig(config) {
    const file = join(this.root,'settings.json');
    return serialize(file,async()=>{
      const current = await readJson(file,()=>({}));
      await replaceJson(file,config,Boolean(current.recovery));
      return config;
    });
  }
}
