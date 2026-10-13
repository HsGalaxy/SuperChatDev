#!/usr/bin/env python3
"""Read/write only temporary local preview state; never touch production settings."""
from pathlib import Path
import base64,json,os,secrets,shutil,socket,subprocess,tempfile,time,urllib.request
import websocket

project=Path(__file__).resolve().parent.parent
root=Path(tempfile.mkdtemp(prefix='fast-path-chrome-'))
profile=root/'chrome';profile.mkdir()
work=root/'work';work.mkdir()
password=secrets.token_urlsafe(24)
s=socket.socket();s.bind(('127.0.0.1',0));port=s.getsockname()[1];s.close()
origin='http://127.0.0.1:'+str(port)
module=project.joinpath('src/server.mjs').as_uri()
node="""import {createApp} from %s;
const app=await createApp({workspace:%s,dataRoot:%s,password:process.env.PREVIEW_SECRET,
bearerToken:process.env.PREVIEW_SECRET,publicBaseURL:'',host:'127.0.0.1',port:%d,httpOrigins:[%s],
clientRedirectOrigins:[],allowedOrigins:[],maxJobs:2});
app.server.listen(%d,'127.0.0.1');
"""%(json.dumps(module),json.dumps(str(work)),json.dumps(str(root/'state')),port,json.dumps(origin),port)
entry=root/'server.mjs';entry.write_text(node)
env={**os.environ,'PREVIEW_SECRET':password}
service=subprocess.Popen(['node',str(entry)],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
chrome=subprocess.Popen(['chromium','--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
  '--no-first-run','--no-default-browser-check','--remote-allow-origins=*','--remote-debugging-port=0',
  '--user-data-dir='+str(profile),'--window-size=1400,1000','about:blank'],
  stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
ws=None
try:
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
 def get(url):
  with opener.open(url,timeout=2) as r:return json.loads(r.read())
 for _ in range(70):
  try:
   assert get(origin+'/health')['version']=='0.3.1'
   browserport=int((profile/'DevToolsActivePort').read_text().splitlines()[0])
   tabs=get('http://127.0.0.1:'+str(browserport)+'/json')
   url=next(t['webSocketDebuggerUrl'] for t in tabs if t.get('type')=='page')
   break
  except Exception:time.sleep(.2)
 else:raise RuntimeError('Preview Chromium did not start')
 ws=websocket.create_connection(url,origin='http://localhost',timeout=10)
 seq=[0];errors=[]
 def call(method,params=None):
  seq[0]+=1; n=seq[0]
  ws.send(json.dumps({'id':n,'method':method,'params':params or {}}))
  while True:
   message=json.loads(ws.recv())
   if message.get('method')=='Runtime.exceptionThrown': errors.append(message.get('params',{}))
   if message.get('id')==n:
    if message.get('error'):raise RuntimeError(str(message['error']))
    return message.get('result',{})
 def evaluate(script):
  result=call('Runtime.evaluate',{'expression':script,'returnByValue':True})
  if result.get('exceptionDetails'):raise RuntimeError(str(result['exceptionDetails']))
  return result.get('result',{}).get('value')
 def wait(script):
  for _ in range(70):
   try:
    if evaluate(script):return
   except Exception:pass
   time.sleep(.1)
  raise RuntimeError('Browser wait timed out: '+script)
 call('Page.enable');call('Runtime.enable')
 call('Page.navigate',{'url':origin+'/admin/'})
 wait('document.readyState === "complete" && Boolean(document.getElementById("login-form"))')
 evaluate("document.getElementById('login-password').value="+json.dumps(password)+";document.querySelector('#login-form button').click()")
 try:
  wait('document.getElementById("shell").hidden===false')
 except Exception:
  print('Login diagnostics:',evaluate("({error:document.getElementById('login-error').textContent,ready:document.readyState,formPresent:Boolean(document.getElementById('login-form'))})"))
  raise
 evaluate("""document.querySelector('[data-nav="settings"]').click()""")
 wait('Boolean(document.getElementById("oauth-refreshTokenDays"))')
 initial=evaluate("""({version:toolManifest.version,profile:document.getElementById('tool-profile').value,
   refreshDays:document.getElementById('oauth-refreshTokenDays').value,
   toggle:document.querySelector('[data-oauth-switch="refreshTokensEnabled"]').checked,
   fields:document.getElementById('oauth-policy-fields').querySelectorAll('input').length,
   stats:document.querySelectorAll('.oauth-stat').length,
   formValid:document.getElementById('settings-form').checkValidity()})""")
 assert initial['version']=='0.3.1' and initial['refreshDays']=='30' and initial['toggle'] and initial['fields']==5 and initial['stats']==4 and initial['formValid'],initial
 evaluate("""document.getElementById('oauth-refreshTokenDays').value='45';document.getElementById('settings-form').requestSubmit()""")
 wait('Boolean(settingsSaved && settingsSaved.oauth.refreshTokenDays===45)')
 stored=json.loads((root/'state/admin-settings.json').read_text())
 assert stored['settings']['oauth']['refreshTokenDays']==45
 call('Page.reload')
 wait('document.getElementById("shell") && document.getElementById("shell").hidden===false')
 evaluate("""document.querySelector('[data-nav="settings"]').click()""")
 wait("""Boolean(document.getElementById('oauth-refreshTokenDays') && document.getElementById('oauth-refreshTokenDays').value==='45')""")
 evaluate("""document.getElementById('oauth-refreshTokenDays').scrollIntoView({block:'center'})""")
 time.sleep(.3)
 screenshot=project/'admin-fast-path-preview.png'
 screenshot.write_bytes(base64.b64decode(call('Page.captureScreenshot',{'format':'png','captureBeyondViewport':False})['data']))
 assert not errors,errors
 print(json.dumps({'version':'0.3.1','login':True,'settings_updated':True,
  'settings_survive_reload':True,'initial':initial,'javascript_errors':len(errors),
  'screenshot':screenshot.name},ensure_ascii=False))
finally:
 if ws:ws.close()
 for process in [chrome,service]:
  process.terminate()
  try:process.wait(timeout=4)
  except subprocess.TimeoutExpired:process.kill()
 shutil.rmtree(root,ignore_errors=True)
