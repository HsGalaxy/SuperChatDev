'use strict';
const byId = id => document.getElementById(id);
const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icon = name => '<svg class="icon"><use href="#i-' + name + '"></use></svg>';
const shortId = id => id ? esc(id.slice(0, 8) + '…') : '—';
const dateTime = t => { if (!t) return '—'; const d = new Date(t); return Number.isFinite(d.getTime()) ? d.toLocaleString('zh-CN', { hour12: false }) : '—'; };
const formatBytes = n => { if (n == null || !Number.isFinite(n)) return '—'; if (n < 1024) return n + ' B'; const units = ['KB','MB','GB','TB']; let i = -1; do { n /= 1024; i++; } while (n >= 1024 && i < 3); return n.toFixed(n < 10 ? 1 : 0) + ' ' + units[i]; };
const stateName = s => ({ succeeded:'成功',running:'运行中',queued:'排队中',failed:'失败',error:'错误',cancelled:'已取消',interrupted:'已中断' })[s] || s || '未知';
const status = s => '<span class="status status-' + esc(s) + '">' + esc(stateName(s)) + '</span>';
const empty = (count, text='暂无记录') => '<tr><td class="empty-row" colspan="' + count + '">' + esc(text) + '</td></tr>';
const isActive = s => ['running','queued'].includes(s);
let csrf = '', currentPage = 'overview', filesPath = '.', filesData = [], editorPath = '', fileWritable = true;
let toolManifest = null;
let activityPage = 0, activityTotal = 0, activityItems = [], settingsSaved = null, toolsCatalog = [], loading = false, pendingRefresh = false;

async function api(url, { method = 'GET', data, body } = {}) {
  const headers = {};
  if (data !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(data); }
  if (method !== 'GET' && method !== 'HEAD') headers['X-CSRF-Token'] = csrf;
  const response = await fetch('/admin/api/' + url, { method, headers, body, credentials: 'same-origin', cache: 'no-store' });
  let value;
  try { value = await response.json(); } catch { throw new Error('服务器返回了无法解析的响应'); }
  if (!response.ok) {
    if (response.status === 401 && url !== 'login') showLogin();
    throw new Error(value.error || '请求失败 (' + response.status + ')');
  }
  return value;
}
function toast(message, error = false) {
  const item = document.createElement('div'); item.className = 'toast' + (error ? ' error' : '');
  item.textContent = message; byId('toasts').append(item);
  setTimeout(() => item.remove(), 4300);
}
function showLogin() {
  clearIssuedBearer();
  csrf = ''; byId('auth-screen').hidden = false; byId('shell').hidden = true;
  byId('login-password').value = ''; byId('login-error').textContent = '';
}
function showShell() {
  byId('auth-screen').hidden = true; byId('shell').hidden = false;
  navigate(currentPage);
}
async function boot() {
  try {
    const s = await api('session');
    if (!s.authenticated) return showLogin();
    csrf = s.csrf; showShell();
  } catch (e) { showLogin(); byId('login-error').textContent = '暂时无法连接管理接口'; }
}
byId('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.target.querySelector('button'); button.disabled = true; byId('login-error').textContent = '';
  try {
    await api('login', { method: 'POST', data: { password: byId('login-password').value } });
    const s = await api('session'); if (!s.authenticated) throw new Error('登录会话未建立');
    csrf = s.csrf; toast('欢迎回来，Administrator'); showShell();
  } catch (e) { byId('login-error').textContent = e.message; }
  finally { button.disabled = false; }
});
byId('logout').addEventListener('click', async () => {
  try { await api('logout', { method:'POST' }); } catch {}
  showLogin();
});
function navigate(page) {
  if (!['overview','activity','jobs','files','settings'].includes(page)) return;
  if (currentPage === 'settings' && page !== 'settings') clearIssuedBearer();
  currentPage = page;
  document.querySelectorAll('.page').forEach(el => el.classList.toggle('active', el.id === 'page-' + page));
  document.querySelectorAll('[data-nav]').forEach(el => el.classList.toggle('active', el.dataset.nav === page));
  byId('top-crumb').textContent = ({overview:'总览',activity:'MCP 调用记录',jobs:'任务与批处理',files:'文件管理',settings:'系统设置'})[page];
  document.querySelector('.sidebar').classList.remove('open');
  window.scrollTo({top:0,behavior:'instant'});
  refreshPage();
}
document.addEventListener('click', event => {
  const nav = event.target.closest('[data-nav], [data-jump]');
  if (nav) navigate(nav.dataset.nav || nav.dataset.jump);
});
byId('mobile-menu').addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('open'));
byId('refresh').addEventListener('click', refreshPage);
function refreshPage() {
  if (byId('shell').hidden) return;
  if (loading) { pendingRefresh = true; return; }
  const loaders = { overview: loadOverview, activity: loadActivity, jobs: loadJobs, files: loadFiles, settings: loadSettings };
  loading = true;
  Promise.resolve(loaders[currentPage]()).catch(e => toast(e.message, true)).finally(() => {
    loading = false;
    if (pendingRefresh) { pendingRefresh = false; refreshPage(); }
  });
}
function setText(id, value) { byId(id).textContent = value; }
function setProgress(id, pct) { byId(id).style.width = Math.max(0, Math.min(100, pct || 0)) + '%'; }
function callCells(call, includeTrace = false) {
  const dur = call.duration_ms == null ? '—' : call.duration_ms + ' ms';
  return '<td class="tool-name">' + esc(call.tool) + '</td><td>' + esc(call.origin === 'desktop_commander' ? 'Desktop Commander' : 'Gateway') +
    '</td><td>' + status(call.status) + '</td><td class="mono">' + esc(dur) + '</td><td>' + dateTime(call.started_at) +
    '</td>' + (includeTrace ? '<td><span class="mono muted" title="' + esc(call.trace_id) + '">' + shortId(call.trace_id) + '</span></td>' : '');
}
async function loadOverview() {
  const data = await api('overview');
  setText('metric-calls', data.calls.total.toLocaleString('zh-CN'));
  setText('metric-recent', data.calls.recent_15m.toLocaleString('zh-CN'));
  setText('metric-active', data.jobs.active + data.batches.active);
  setText('metric-errors', data.calls.errors_15m);
  setText('overview-updated', '更新于 ' + new Date().toLocaleTimeString('zh-CN', {hour12:false}));
  const chart = byId('activity-chart'), values = data.calls.histogram, max = Math.max(1, ...values);
  chart.replaceChildren(...values.map(x => {
    const bar = document.createElement('div');
    bar.className = 'chart-bar'; bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', x + ' 次调用'); bar.dataset.count = x;
    bar.style.setProperty('--height', (x ? Math.max(6, x / max * 100) : 2) + '%');
    bar.style.opacity = x ? '1' : '.3';
    return bar;
  }));
  byId('recent-calls').innerHTML = data.calls.latest.length ?
    data.calls.latest.map(call => '<tr>' + callCells(call) + '</tr>').join('') : empty(5, '暂无 MCP 调用记录');
  const s = data.system;
  const cpu = s.cpu_percent;
  setText('system-cpu', cpu == null ? '采样中…' : cpu.toFixed(1) + '%');
  setText('system-load', s.cpu_count + ' 逻辑核心 · Load ' + s.load.slice(0, 3).map(x => x.toFixed(2)).join(' / '));
  setProgress('bar-cpu', cpu);
  const usedMem = s.memory_total - s.memory_free, memP = s.memory_total ? 100 * usedMem / s.memory_total : 0;
  setText('system-memory', memP.toFixed(1) + '%');
  setText('system-memory-details', formatBytes(usedMem) + ' / ' + formatBytes(s.memory_total));
  setProgress('bar-memory', memP);
  const disk = s.disk, usedDisk = disk ? disk.total - disk.free : 0, diskP = disk && disk.total ? 100 * usedDisk / disk.total : 0;
  setText('system-disk', disk ? diskP.toFixed(1) + '%' : '—');
  setText('system-disk-details', disk ? formatBytes(usedDisk) + ' / ' + formatBytes(disk.total) : '无法读取');
  setProgress('bar-disk', diskP); setText('system-rss', formatBytes(s.process_rss));
}

byId('activity-reload').addEventListener('click', () => loadActivity().catch(e => toast(e.message,true)));
byId('activity-query').addEventListener('input', renderActivity);
byId('activity-status').addEventListener('change', renderActivity);
byId('activity-prev').addEventListener('click', () => { activityPage = Math.max(0, activityPage-1); refreshPage(); });
byId('activity-next').addEventListener('click', () => { activityPage++; refreshPage(); });
async function loadActivity() {
  const data = await api('activity?offset=' + activityPage * 50 + '&limit=50');
  activityTotal = data.total; activityItems = data.calls; renderActivity();
}
function renderActivity() {
  const query = byId('activity-query').value.trim().toLowerCase(), state = byId('activity-status').value;
  const filtered = activityItems.filter(x => (!state || x.status === state) && (!query ||
    x.tool.toLowerCase().includes(query) || x.trace_id.toLowerCase().includes(query)));
  byId('activity-rows').innerHTML = filtered.length ? filtered.map(x => '<tr>' + callCells(x,true) + '</tr>').join('') : empty(6, '本页没有匹配记录');
  setText('activity-count', activityTotal + ' 条历史记录');
  setText('activity-pager-label', activityTotal ? '第 ' + (activityPage * 50 + 1) + '–' + Math.min(activityTotal, activityPage * 50 + activityItems.length) + ' 条 · 本页筛选' : '暂无记录');
  byId('activity-prev').disabled = activityPage <= 0;
  byId('activity-next').disabled = (activityPage + 1) * 50 >= activityTotal;
}
byId('jobs-reload').addEventListener('click', () => loadJobs().catch(e => toast(e.message,true)));
async function loadJobs() {
  const [j,b] = await Promise.all([api('jobs'), api('batches')]);
  setText('jobs-total', j.jobs.length); setText('jobs-active', j.jobs.filter(x => isActive(x.status)).length);
  setText('batches-total', b.executions.length);
  byId('jobs-rows').innerHTML = j.jobs.length ? j.jobs.map(x =>
    '<tr><td class="mono" title="' + esc(x.id) + '">' + shortId(x.id) + '</td><td>' + status(x.status) +
    '</td><td title="' + esc(x.cwd) + '">' + esc(x.cwd || '—') + '</td><td class="mono">' + esc(x.exit_code == null ? '—' : x.exit_code) +
    '</td><td>' + dateTime(x.created_at) + '</td><td>' +
    (isActive(x.status) ? '<button class="small-action" data-act="cancel-job" data-id="' + esc(x.id) + '">取消</button>' : '—') +
    '</td></tr>').join('') : empty(6, '暂无持久化任务');
  byId('batches-rows').innerHTML = b.executions.length ? b.executions.map(x =>
    '<tr><td class="mono" title="' + esc(x.execution_id) + '">' + shortId(x.execution_id) + '</td><td>' + status(x.status) +
    '</td><td>' + esc(x.cwd || '—') + '</td><td>' + dateTime(x.created_at) +
    '</td><td>' + (isActive(x.status) ? '<button class="small-action" data-act="cancel-batch" data-id="' + esc(x.execution_id) + '">取消</button>' : '—') +
    '</td></tr>').join('') : empty(5, '暂无批处理记录');
}
document.addEventListener('click', async event => {
  const b = event.target.closest('[data-act]');
  if (!b) return;
  if (!window.confirm('确认取消此' + (b.dataset.act === 'cancel-job' ? '作业' : '批处理') + '？这不会撤销已写入的文件。')) return;
  b.disabled = true;
  try {
    const type = b.dataset.act === 'cancel-job' ? 'jobs/' : 'batches/';
    await api(type + encodeURIComponent(b.dataset.id) + '/cancel', {method:'POST'});
    toast('已提交取消请求'); await loadJobs();
  } catch(e) { toast(e.message,true); b.disabled = false; }
});

const joined = (directory, name) => (directory && directory !== '.' ? directory + '/' : '') + name;
function fileRow(entry) {
  const isDir = entry.type === 'directory', isFile = entry.type === 'file', canOpen = isDir || isFile;
  const id = esc(entry.name), klass = isDir ? '' : isFile ? ' file-plain' : ' file-link', glyph = isDir ? '▰' : isFile ? '≡' : '↗';
  return '<tr><td><div class="file-cell"><span class="file-icon' + klass + '">' + glyph + '</span>' +
    (canOpen ? '<button class="file-name" data-file="open" data-name="' + id + '" title="' + id + '">' + id + '</button>' :
      '<span class="file-name" title="无法访问符号链接">' + id + '</span>') +
    '</div></td><td>' + (isDir ? '—' : formatBytes(entry.bytes)) + '</td><td>' + dateTime(entry.modified_at) +
    '</td><td><div class="file-actions">' +
    (isFile ? '<button class="small-action" data-file="download" data-name="' + id + '">下载</button>' : '') +
    (fileWritable && canOpen ? '<button class="small-action" data-file="rename" data-name="' + id + '">重命名</button><button class="small-action" data-file="delete" data-name="' + id + '">删除</button>' : '') +
    '</div></td></tr>';
}
function renderFileRows() {
  const q = byId('file-search').value.toLowerCase();
  const rows = filesData.filter(x => x.name.toLowerCase().includes(q));
  byId('file-rows').innerHTML = rows.length ? rows.map(fileRow).join('') : empty(4, '此文件夹暂无匹配文件');
  setText('file-count', filesData.length + ' 个条目');
}
function renderBreadcrumbs() {
  const parts = filesPath === '.' ? [] : filesPath.split('/');
  let html = '<button class="crumb-btn" data-path=".">workspace</button>';
  parts.forEach((x,i) => { html += '<span class="crumb-divider">/</span><button class="crumb-btn" data-path="' +
    esc(parts.slice(0,i+1).join('/')) + '">' + esc(x) + '</button>'; });
  byId('file-breadcrumbs').innerHTML = html;
  byId('file-up').disabled = !parts.length;
}
async function loadFiles() {
  const result = await api('files?path=' + encodeURIComponent(filesPath));
  fileWritable = result.writable;
  document.querySelectorAll('.write-action').forEach(el => el.hidden = !fileWritable);
  setText('file-permission-badge', fileWritable ? 'WORKSPACE ROOT' : '只读文件管理');
  filesData = result.entries; renderBreadcrumbs(); renderFileRows();
}
async function openFolder(target) {
  filesPath = target || '.'; byId('file-search').value = '';
  await loadFiles();
}
byId('file-up').addEventListener('click', () => openFolder(filesPath.split('/').slice(0,-1).join('/') || '.').catch(e => toast(e.message,true)));
byId('file-search').addEventListener('input', renderFileRows);
byId('file-upload-button').addEventListener('click', () => byId('file-upload').click());
byId('file-upload').addEventListener('change', async event => {
  const input = event.target; const list = [...input.files]; input.value = '';
  for (const file of list) {
    try {
      await api('files/upload?path=' + encodeURIComponent(joined(filesPath,file.name)), {method:'PUT',body:file});
      toast('已上传 ' + file.name);
    } catch (e) { toast(file.name + ': ' + e.message,true); }
  }
  await loadFiles().catch(e => toast(e.message,true));
});
byId('file-newfolder').addEventListener('click', async () => {
  const name = prompt('新文件夹名称');
  if (!name) return;
  try { await api('files/mkdir',{method:'POST',data:{path:joined(filesPath,name)}}); toast('文件夹已创建'); await loadFiles(); }
  catch(e){toast(e.message,true);}
});
byId('file-newfile').addEventListener('click', () => {
  const name = prompt('新文件名（如 notes.md）');
  if (name) showEditor(joined(filesPath,name),'');
});
function showEditor(path, content) {
  editorPath = path; byId('editor-title').textContent = path;
  byId('editor-content').value = content;
  byId('editor-content').readOnly = !fileWritable;
  byId('editor-save').hidden = !fileWritable;
  byId('editor-modal').hidden = false; byId('editor-content').focus();
}
function closeEditor(){byId('editor-modal').hidden=true;editorPath='';}
byId('editor-close').addEventListener('click',closeEditor);
byId('editor-cancel').addEventListener('click',closeEditor);
byId('editor-modal').addEventListener('click',e=>{if(e.target===byId('editor-modal'))closeEditor();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!byId('editor-modal').hidden)closeEditor();});
byId('editor-save').addEventListener('click',async()=>{
  try {await api('files/save',{method:'POST',data:{path:editorPath,content:byId('editor-content').value}});toast('保存成功');closeEditor();await loadFiles();}
  catch(e){toast(e.message,true);}
});
document.addEventListener('click',async event=>{
  const crumb = event.target.closest('[data-path]');
  if (crumb) {openFolder(crumb.dataset.path).catch(e=>toast(e.message,true));return;}
  const b=event.target.closest('[data-file]');if(!b)return;
  const entry=filesData.find(x=>x.name===b.dataset.name);if(!entry)return;
  const full=joined(filesPath,entry.name);
  try {
    if(b.dataset.file==='open'){
      if(entry.type==='directory')return await openFolder(full);
      const data=await api('files/text?path='+encodeURIComponent(full));return showEditor(full,data.content);
    }
    if(b.dataset.file==='download') {
      const a=document.createElement('a');a.href='/admin/api/files/download?path='+encodeURIComponent(full);
      a.download=entry.name;a.click();return;
    }
    if(b.dataset.file==='rename'){
      const newName=prompt('重命名为',entry.name);
      if(!newName || newName===entry.name)return;
      await api('files/rename',{method:'POST',data:{from:full,to:joined(filesPath,newName)}});
      toast('已重命名');await loadFiles();return;
    }
    if(b.dataset.file==='delete'){
      if(!confirm('确定删除“'+entry.name+'”？目录必须为空。操作不可撤销。'))return;
      await api('files/delete',{method:'POST',data:{path:full}});
      toast('已删除');await loadFiles();
    }
  }catch(e){toast(e.message,true);}
});

const permissionsInfo = [
 ['filesystemRead','读取工作区','核心文件读取、搜索、导出和差异检查'],
 ['filesystemWrite','写入工作区','关闭后同时拒绝任意命令执行，避免通过 Shell 绕过只读限制'],
 ['fileTransfer','附件导入与导出','允许使用 file_import / file_unpack / file_export'],
 ['jobs','启动后台任务','控制新作业；查看和取消既有作业仍可用'],
 ['workspace','启动工作区批处理','控制新批处理；进度查询和取消仍可用'],
 ['desktopCommander','Desktop Commander','允许访问代理提供的远程文件与进程工具'],
 ['containerBuild','容器镜像构建','允许 workspace_execute 中使用 container_build 步骤'],
 ['commandExecution','远程命令执行','允许 job_start、批处理 exec 及上游进程操作'],
 ['fileManagerWrite','网页文件写入','允许管理页面上传、编辑、重命名和删除']
];
const limitsInfo = [
 ['maxJobLogMB','单作业日志上限','MiB',1,256,'超限后保留已写入部分并标记丢弃字节；不伪装成完整日志'],
 ['maxJobs','并发命令作业','个',1,32,'同时可运行的普通命令作业'],
 ['maxFileMB','附件大小上限','MiB',1,2048,'文件导入与导出最大字节数'],
 ['maxResourceMB','MCP 资源上限','MiB',1,64,'内联二进制资源最大容量'],
 ['maxUploadMB','网页上传大小上限','MiB',1,512,'文件管理页面单文件上传限制'],
 ['maxJobSeconds','命令执行超时','秒',30,86400,'新命令和批处理的最长执行时间'],
 ['maxBatchSteps','批处理最大步骤数','步',1,32,'单次 workspace_execute 的步骤数量'],
 ['maxParallelism','批处理最大并行度','并行',1,4,'新批处理允许的最大并行步骤'],
 ['callsPerMinute','每分钟调用限制','次',0,5000,'所有 MCP 工具调用共享；0 表示无限制'],
 ['traceRetention','调用记录保留量','条',100,20000,'磁盘保留的最近 MCP 调用记录']
];
const oauthNumbersInfo = [
 ['accessTokenMinutes','Access Token 有效期','分钟',1,43200,'新签发的令牌最多可设置 30 天；已有令牌不变'],
 ['authorizationCodeSeconds','授权码有效期','秒',30,600,'仅能兑换一次；默认 60 秒'],
 ['consentFormMinutes','授权确认页面','分钟',1,30,'批准页面的单次表单随机令牌有效期'],
 ['maxClients','客户端注册容量','个',1,1000,'允许注册的 OAuth 客户端数量上限'],
 ['refreshTokenDays','Refresh Token 有效期','天',1,90,'默认 30 天；轮换后重新计算有效期，仅对新令牌生效']
];
const oauthSwitchInfo = [
 ['refreshTokensEnabled','允许 OAuth 自动续期','客户端支持刷新时无需每小时重新网页登录；刷新令牌哈希单独持久化，重启后可用'],
 ['allowDynamicRegistration','允许动态注册 OAuth 客户端','关闭后禁止新客户端通过 /oauth/register 注册，不影响既有客户端'],
 ['persistAccessTokens','服务重启后保留 Access Token','私有状态文件仅存 SHA-256 哈希和有效期；关闭会移除持久化文件'],
 ['envBearerEnabled','允许环境变量中的静态 Bearer 密钥','关闭可能导致使用静态密钥的既有集成立即失去访问权限']
];
const securityNumbersInfo = [
 ['adminSessionMinutes','管理员网页登录有效期','分钟',5,10080,'仅影响新建立的管理会话；旧会话维持原有截止时间']
];
const fieldHTML = ([key,title,unit,min,max,help],prefix,value) =>
  '<div class="field"><label for="'+prefix+key+'">'+title+'</label><span><input id="'+prefix+key+'" type="number" min="'+min+
  '" max="'+max+'" step="1" value="'+value+'" required><small class="field-unit">'+unit+
  '</small></span><span class="field-help">'+help+'</span></div>';
const switchHTML = ([key,title,description],checked) =>
  '<label class="switch-row"><span><span class="switch-name">'+title+'</span><span class="switch-desc">'+description+
  '</span></span><span class="switch-control"><input type="checkbox" data-oauth-switch="'+key+'"'+(checked?' checked':'')+
  '><span class="switch-track"></span></span></label>';
byId('settings-form').addEventListener('input', event => {
  if (event.target.closest('.oauth-key-form')) return;
  markChanged();
});
byId('settings-form').addEventListener('change', event => {
  if (event.target.closest('.oauth-key-form')) return;
  markChanged();
});
function markChanged() {setText('settings-changed','● 有尚未保存的更改');byId('settings-changed').style.color='#625bfa';}
function renderSettings(saved) {
  byId('tool-profile').value=saved.toolProfile || 'core';
  byId('permission-switches').innerHTML=permissionsInfo.map(([key,title,desc]) =>
    '<label class="switch-row"><span><span class="switch-name">'+title+'</span><span class="switch-desc">'+desc+
    '</span></span><span class="switch-control"><input type="checkbox" data-permission="'+key+'"'+(saved.permissions[key]?' checked':'')+
    '><span class="switch-track"></span></span></label>').join('');
  byId('limit-fields').innerHTML=limitsInfo.map(([key,title,unit,min,max,help]) =>
    '<div class="field"><label for="limit-'+key+'">'+title+'</label><span><input id="limit-'+key+'" type="number" min="'+min+
    '" max="'+max+'" step="1" value="'+saved.limits[key]+'" required><small class="field-unit">'+unit+
    '</small></span><span class="field-help">'+help+'</span></div>').join('');
  byId('tool-toggles').innerHTML=toolsCatalog.map(t =>
    '<label class="tool-toggle'+(saved.blockedTools.includes(t.name)?' disabled-tool':'')+'" title="'+esc(t.title)+
    '"><span>'+esc(t.name)+'</span><input type="checkbox" data-tool="'+esc(t.name)+'"'+
    (!saved.blockedTools.includes(t.name)?' checked':'')+'></label>').join('');
  byId('oauth-policy-fields').innerHTML=oauthNumbersInfo.map(item=>fieldHTML(item,'oauth-',saved.oauth[item[0]])).join('');
  byId('oauth-policy-switches').innerHTML=oauthSwitchInfo.map(item=>switchHTML(item,saved.oauth[item[0]])).join('');
  byId('security-fields').innerHTML=securityNumbersInfo.map(item=>fieldHTML(item,'security-',saved.security[item[0]])).join('');
  byId('download-origins').value=saved.downloadOrigins.join('\n');
  fileWritable=saved.permissions.fileManagerWrite;
  document.querySelectorAll('.write-action').forEach(el=>el.hidden=!fileWritable);
  setText('file-permission-badge',fileWritable?'WORKSPACE ROOT':'只读文件管理');
  setText('settings-changed','所有更改将保存到服务器私有状态目录');
  byId('settings-changed').style.color='';
}
function connectionRows(c){
  const values=[['公开服务地址',c.publicBaseURL||'未配置'],['MCP 接口',c.mcpPath],['管理页面',c.adminPath],
    ['工作区',c.workspace],['本地监听',c.host+':'+c.port],
    ['OAuth 回调白名单',(c.oauthRedirectOrigins||[]).join('\n')||'未配置']];
  byId('connection-details').innerHTML=values.map(([k,v])=>
    '<div class="detail-line"><span>'+esc(k)+'</span><strong>'+esc(v)+'</strong></div>').join('');
}
async function loadSettings(){
  const data=await api('settings');settingsSaved=data.settings;toolsCatalog=data.tools;
  renderSettings(settingsSaved);connectionRows(data.connection);
  renderToolManifest(data.catalog);
  await loadOAuthStatus();
}
byId('settings-reset').addEventListener('click',()=>{
  if(!settingsSaved)return;renderSettings(settingsSaved);toast('已撤销未保存的修改');
});
byId('settings-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const permissions={},limits={},oauth={},security={};
  for(const [key] of permissionsInfo)permissions[key]=byId('settings-form').querySelector('[data-permission="'+key+'"]').checked;
  for(const [key] of limitsInfo)limits[key]=Number(byId('limit-'+key).value);
  for(const [key] of oauthNumbersInfo)oauth[key]=Number(byId('oauth-'+key).value);
  for(const [key] of oauthSwitchInfo)oauth[key]=byId('settings-form').querySelector('[data-oauth-switch="'+key+'"]').checked;
  for(const [key] of securityNumbersInfo)security[key]=Number(byId('security-'+key).value);
  if(settingsSaved && settingsSaved.oauth.envBearerEnabled && !oauth.envBearerEnabled &&
      !confirm('确认停用环境变量中的静态 Bearer 密钥？依赖它的现有客户端会立即断连。')) return;
  const downloadOrigins=byId('download-origins').value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const blockedTools=[...document.querySelectorAll('[data-tool]')].filter(x=>!x.checked).map(x=>x.dataset.tool);
  const btn=byId('settings-save');btn.disabled=true;
  try{
    const data=await api('settings',{method:'PUT',data:{permissions,limits,downloadOrigins,blockedTools,oauth,security,toolProfile:byId('tool-profile').value}});
    settingsSaved=data.settings;renderSettings(settingsSaved);renderToolManifest(await api('tools'));toast('设置已保存，并对新的 MCP 请求生效');
  }catch(e){toast(e.message,true);}
  finally{btn.disabled=false;}
});
function renderToolManifest(catalog) {
  toolManifest=catalog;
  if(!catalog)return;
  const rows=[['Version / Profile',catalog.version+' / '+catalog.profile],['Catalog SHA-256',catalog.sha256],['Visible tools',catalog.visible_count+' / '+catalog.registered_count],['DC bridge',catalog.upstream?.state || 'not configured'],['Server tool names',catalog.visible_tools.join(', ')]];
  byId('core-tool-manifest').innerHTML=rows.map(([name,value])=>'<div class="detail-line"><span>'+esc(name)+'</span><strong>'+esc(value)+'</strong></div>').join('');
}
byId('copy-tool-manifest').addEventListener('click',async()=>{
  try{await navigator.clipboard.writeText(JSON.stringify(toolManifest,null,2));toast('Tool catalog copied');}
  catch{toast('Clipboard unavailable; inspect the displayed tool list',true);}
});
function clearIssuedBearer() {
  const container=byId('oauth-one-time');
  if(container)container.hidden=true;
  const value=byId('oauth-issued-value');
  if(value)value.value='';
}
async function loadOAuthStatus() {
  const data=await api('oauth/status');
  setText('oauth-token-count',data.activeTokens);
  setText('oauth-refresh-count',data.activeRefreshTokens);
  setText('oauth-client-count',data.registeredClients);
  setText('oauth-code-count',data.pendingCodes);
  const managed=data.managedBearer;
  const keyStatus=managed.configured ?
    (managed.expired?'已过期':'已启用')+' · 到期 '+dateTime(managed.expires_at):
    '尚未生成独立接入密钥';
  const envStatus=data.envBearerConfigured ?
    (data.envBearerEnabled?'启用中':'已被策略禁用') : '未配置';
  byId('oauth-credential-meta').innerHTML='<div class="detail-line"><span>独立接入密钥</span><strong>'+esc(keyStatus)+
    '</strong></div><div class="detail-line"><span>环境变量静态 Bearer</span><strong>'+esc(envStatus)+
    '</strong></div><div class="detail-line"><span>OAuth 客户端认证方式</span><strong>Public client / PKCE S256（无 client_secret）</strong></div>';
  byId('oauth-client-rows').innerHTML=data.clients.length?data.clients.map(client=>
    '<tr><td>'+esc(client.client_name || '未命名')+'</td><td class="mono" title="'+esc(client.client_id)+'">'+shortId(client.client_id)+
    '</td><td class="oauth-callbacks">'+esc(client.redirect_uris.join(' · '))+
    '</td><td><button class="small-action" type="button" data-oauth-client="'+esc(client.client_id)+'">撤销</button></td></tr>').join(''):
    '<tr><td class="empty-row" colspan="4">暂无已注册客户端</td></tr>';
}
byId('oauth-status-refresh').addEventListener('click',()=>loadOAuthStatus().catch(e=>toast(e.message,true)));
byId('oauth-key-password').addEventListener('keydown',e=>{if(e.key==='Enter')e.preventDefault();});
async function performBearerAction(kind) {
  const password=byId('oauth-key-password').value;
  if(!password){toast('请先填写管理员密码确认操作',true);return;}
  const days=Number(byId('oauth-key-days').value);
  const rotate=kind==='rotate';
  if(rotate && (!Number.isSafeInteger(days)||days<1||days>365)){toast('密钥有效期须为 1–365 天',true);return;}
  if(!confirm(rotate?'生成新密钥会立即撤销之前的独立密钥，确定继续？':
                      '撤销独立密钥后，对应客户端将立即无法访问。确定继续？'))return;
  const button=byId(rotate?'oauth-key-rotate':'oauth-key-revoke');
  button.disabled=true;
  try{
    const result=await api(rotate?'oauth/bearer/rotate':'oauth/bearer/revoke',{
      method:'POST',data:rotate?{password,days}:{password}});
    clearIssuedBearer();
    if(rotate){
      byId('oauth-issued-value').value=result.access_token;
      byId('oauth-one-time').hidden=false;
      toast('密钥已生成，仅显示一次');
    }else toast('独立接入密钥已撤销');
    await loadOAuthStatus();
  }catch(e){toast(e.message,true);}
  finally{byId('oauth-key-password').value='';button.disabled=false;}
}
byId('oauth-key-rotate').addEventListener('click',()=>performBearerAction('rotate'));
byId('oauth-key-revoke').addEventListener('click',()=>performBearerAction('revoke'));
byId('oauth-key-hide').addEventListener('click',clearIssuedBearer);
byId('oauth-key-copy').addEventListener('click',async()=>{
  const value=byId('oauth-issued-value').value;
  if(!value)return;
  try{await navigator.clipboard.writeText(value);toast('密钥已复制，请妥善保存');}
  catch(e){byId('oauth-issued-value').select();toast('复制失败，请手动复制密钥',true);}
});
byId('oauth-revoke-tokens').addEventListener('click',async()=>{
  if(!confirm('撤销全部 OAuth 会话（包括刷新凭据）？所有 OAuth 客户端将需要重新授权！'))return;
  const button=byId('oauth-revoke-tokens');button.disabled=true;
  try{await api('oauth/tokens/revoke',{method:'POST'});toast('已撤销全部 OAuth 会话');await loadOAuthStatus();}
  catch(e){toast(e.message,true);}
  finally{button.disabled=false;}
});
document.addEventListener('click',async event=>{
  const b=event.target.closest('[data-oauth-client]');
  if(!b)return;
  if(!confirm('撤销客户端 '+b.dataset.oauthClient+'？此客户端的令牌也会失效。'))return;
  b.disabled=true;
  try{await api('oauth/clients/revoke',{method:'POST',data:{client_id:b.dataset.oauthClient}});
    toast('已撤销客户端及其令牌');await loadOAuthStatus();}
  catch(e){toast(e.message,true);b.disabled=false;}
});
setInterval(()=>{
  if(byId('shell').hidden)return;
  setText('top-time',new Date().toLocaleTimeString('zh-CN',{hour12:false}));
},1000);
setInterval(()=>{if(!byId('shell').hidden&&['overview','activity','jobs'].includes(currentPage))refreshPage();},12000);
boot();
