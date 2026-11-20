// ADR-002 fixes the work destination. The display name and Tempo storage value are deliberately separate.
const definitions = [
  ['需求调研','二开支持','需求调研及分析'],
  ['需求分析','需求分析会议','需求调研及分析'],
  ['需求分析评审','需求分析评审','需求调研及分析'],
  ['概要设计','需求设计','概要设计及评审'],
  ['概要与规格评审','需求评审','概要设计及评审'],
  ['规格撰写','规格撰写','规格撰写及评审'],
  ['4.0应用开发','4.0应用开发','开发协同及验收'],
  ['传达与答疑','需求传达','开发协同及验收'],
  ['ui评审','ui设计评审','概要设计及评审'],
  ['系统分析及用例评审','系统分析','开发协同及验收'],
  ['UI设计','产品UI设计','UI设计'],
  ['产品及ui验收','功能验收','开发协同及验收'],
  ['素材设计','运营素材设计（设计支持组）','日常综合'],
  ['平面设计','售前素材设计（设计支持组）','日常综合'],
  ['其他设计','客户素材设计（设计支持组）','日常综合'],
  ['竞品分析','竞品分析','需求调研及分析'],
  ['日常综合','日常综合','日常综合'],
  ['产品知识输出','文档整理','日常综合'],
  ['分享与学习','学习','日常综合'],
  ['团队管理','团队管理','日常综合'],
  ['项目管理','项目管理','迭代项目管理'],
  ['售前及实施支持','实施支持','工单及线上问题处理'],
  ['出差旅途','出差旅途','日常综合'],
  ['请假','请假','日常综合']
];
export const typeMapping = Object.freeze(Object.fromEntries(definitions.map(([name,,task])=>[name,task])));
export const typeValues = Object.freeze(Object.fromEntries(definitions.map(([name,value])=>[name,value])));
export const monthlyTasks = Object.freeze(['日常综合','工单及线上问题处理','迭代项目管理']);
export const requirementTasks = Object.freeze({'项目管理':'开发协同及验收','售前及实施支持':'需求调研及分析'});

export const isCompletedItem = (item) => item.status==='success'||item.status==='deleted';

// 工时粒度集中在一处：0.25h = 15 分钟，二进制可精确表示，累加不会产生尾差。
export const HOURS_MIN = 0.25;
export const HOURS_STEP = 0.25;
export const HOURS_ERROR = '工时至少为0.25小时，且是0.25的倍数';
export function hoursValid(value) {
  return Number.isFinite(value) && value >= HOURS_MIN && Math.round(value / HOURS_STEP) * HOURS_STEP === value;
}
export const HOUR_CHOICES = Object.freeze([0.25,0.5,0.75,1,1.25,1.5,2,2.5,3]);

/** These two types use their monthly task until the user chooses a concrete requirement. */
export function taskForType(type,hasRequirement=false) {
  return hasRequirement && requirementTasks[type] || typeMapping[type];
}
/** 业务分类只看工时类型与是否已选工单，不看用户编辑后的任务名。 */
export function isMonthlyType(type,hasIssue=false) {
  return monthlyTasks.includes(taskForType(type,Boolean(hasIssue)));
}

function validDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const date = new Date(day + 'T12:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0,10) === day;
}

function fieldError(field, message) {
  return Object.assign(new Error(message), {code:'INVALID_RECORD', field});
}

/** Both entry and history edits validate work details here; historical type and destination are preserved during basic edits. */
export function validateWorkDetails(record, {today} = {}) {
  const day = record.day;
  const hours = Number(record.hours);
  if (!validDay(day) || (today && day > today)) throw fieldError('day','请选择今天或过去的有效日期');
  if (typeof record.title !== 'string' || !record.title.trim()) throw fieldError('title','请填写工作事项');
  if (record.hours === '' || record.hours == null || !hoursValid(hours)) {
    throw fieldError('hours',HOURS_ERROR);
  }
  return {...record,title:record.title.trim(),hours,seconds:Math.round(hours * 3600)};
}

export function validateRecord(input, options = {}) {
  const record=validateWorkDetails(input,options);
  if(Object.keys(record.todoConflicts||{}).length)throw fieldError('hours','请先确认待办工时变更');
  if (!Object.hasOwn(typeMapping, record.type)) throw fieldError('type','请选择有效工时类型');
  const task = String(record.task || record.subtask || '').trim();
  if (!task) throw fieldError('task','请填写子任务名称');
  if (task.length > 255 || /[\r\n]/.test(task)) throw fieldError('task','子任务名称不能超过255字且不能换行');
  // 手填子任务时以它为准：父工单在提交阶段由子任务反推，因此不再要求先选工单。
  const subtaskKey = typeof record.subtaskKey==='string' ? record.subtaskKey.trim() : '';
  if (subtaskKey && !/^[A-Z][A-Z0-9_]*-\d+$/.test(subtaskKey)) throw fieldError('subtask','子任务号格式不正确');
  if (record.createSubtask === false && !subtaskKey) throw fieldError('subtask','请选择已有子任务，或允许自动创建');
  const monthly = isMonthlyType(record.type, typeof record.issue === 'string' && Boolean(record.issue.trim()));
  if (!monthly && !subtaskKey && (typeof record.issue !== 'string' || !record.issue.trim())) {
    throw fieldError('issue','请选择关联需求工单');
  }
  return {...record,task,taskSource:record.taskSource === 'manual' ? 'manual' : 'auto',subtaskKey,subtaskTitle:typeof record.subtaskTitle==='string'?record.subtaskTitle:'',createSubtask:subtaskKey?false:record.createSubtask!==false};
}

/** Creation defaults follow the work month, including leap years, independent of the machine's current month. */
export function monthBounds(day) {
  if (!validDay(day)) throw fieldError('day','工作日期无效');
  const month = day.slice(0,7);
  const [year, number] = month.split('-').map(Number);
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return {month, start:month + '-01', end:month + '-' + String(last).padStart(2,'0')};
}

/** Undated imported work stays visible but never inflates a dated weekly total. */
export function totals(records) {
  const result = {hours:0, seconds:0, pendingHours:0, byDay:{}};
  for (const record of records) {
    const hours = Number(record.hours);
    if (!Number.isFinite(hours) || hours <= 0) continue;
    if (!record.day) {
      result.pendingHours += hours;
      continue;
    }
    const seconds = Math.round(hours * 3600);
    const group = result.byDay[record.day] ||= {hours:0, seconds:0, count:0};
    group.seconds += seconds;
    group.hours = group.seconds / 3600;
    group.count += 1;
    result.seconds += seconds;
  }
  result.hours = result.seconds / 3600;
  return result;
}
