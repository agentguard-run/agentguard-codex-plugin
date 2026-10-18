'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {execFileSync}=require('./helper-test-env.cjs');

test('the plugin ships the generated Burn formatter and gives identical text for every width', async()=>{
  const root=path.resolve(__dirname,'..');
  const {formatStatusFields}=await import(pathToFileURL(path.join(root,'live/generated/status-fields.mjs')));
  const burn=require('../runtime/dependencies.cjs').loadDependency('@agentguard-run/burn');
  const now=Date.now(), input={now,burn:{mode:'enforce',burst:{count:2,limit:40},sustained:{count:0,limit:40},tokens:{used:686e6,limit:5e9}},share:33,
    windows:[{name:'five_hour',usedPercent:44,resetsAt:now+3600000,observedAt:now,source:'claude-statusline'}],
    fields:'pace,cost,cache,spend,unknown',cost:{min:12.4,max:12.4},cache:{tokens:42e6,usd:{min:9,max:9}},spend:{usedCents:900,capCents:1000,resetsAt:now+86400000}};
  for(const width of [60,80,120,200]) assert.deepEqual(formatStatusFields({...input,width}),burn.formatStatusFields({...input,width}));
  const builder=path.join(root,'../../scripts/build-agentguard-status.cjs');
  if(fs.existsSync(builder)) execFileSync(process.execPath,[builder,'--check']);
});

test('status_fields is a non-sensitive empty-default string and reaches only the local display command', async()=>{
  const manifest=require('../.claude-plugin/plugin.json');
  assert.deepEqual({type:manifest.userConfig.status_fields.type,default:manifest.userConfig.status_fields.default,sensitive:manifest.userConfig.status_fields.sensitive},
    {type:'string',default:'',sensitive:false});
  const callbacks=new Map(), calls=[];
  const on=(event,...args)=>{callbacks.set(event,args.at(-1));return {catch(){}};};
  const {register}=await import(pathToFileURL(path.resolve(__dirname,'../live/agentguard-live.mjs')));
  register(on,{status_fields:'cost,cache,spend,unknown'});
  const $={env:{get:async()=>null},command:{register:async()=>{}},session:{id:async()=>'fixture-session',usage:async()=>({rateLimits:[]})},
    plugin:{root:'/fixture/plugin'},clock:{every:()=>{}},ui:{invalidate:()=>{}},process:{run:async args=>{calls.push(args);return {stdout:JSON.stringify({ok:true,burn:{},ledger:{ledger:{}}})};}}};
  const event={surface:'terminal',isInteractive:true};
  assert.equal(await callbacks.get('session.start')($,event,value=>value),event);
  assert.equal(calls.length,1);
  assert.equal(calls[0][0],'node');assert.equal(calls[0][1],'/fixture/plugin/runtime/mod-status.cjs');
  assert.equal(calls[0][calls[0].indexOf('--fields')+1],'cost,cache,spend,unknown');
});

async function liveHarness(t, options = {}) {
  let now = Date.parse('2026-10-07T12:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const hooks=[], timers=[], calls=[];
  const on=(event,...args)=>{hooks.push({event,matcher:args.length>1?args[0]:null,fn:args.at(-1)});return {catch(){}};};
  const {register}=await import(pathToFileURL(path.resolve(__dirname,'../live/agentguard-live.mjs'))+'?test='+Math.random());
  register(on,options);
  const state={usage:{rateLimits:[{kind:'five_hour',percentUsed:73,resetsAt:new Date(now+3600000).toISOString()}]}, reads:0, error:false, model:'claude-opus-5-5', fills:[],suggestions:[],logs:[],toasts:[],notifies:[],usageArgs:[]};
  const element=type=>props=>({type,props});
  const $={env:{get:async()=>null},command:{register:async()=>{}},session:{id:async()=>'timer-test',model:async()=>state.model,usage:async args=>{state.reads++;state.usageArgs.push(args);if(state.error)throw Error('host unavailable');return state.usage;}},
    prompt:{fill:async value=>{state.fills.push(value);},suggest:async value=>{state.suggestions.push(value);}},
    plugin:{root:'/fixture/plugin'},clock:{every:(ms,fn)=>timers.push({ms,fn})},ui:{invalidate(){},close:async()=>{},log:value=>state.logs.push(value),toast:(text,options)=>state.toasts.push({text,options}),notify:async(text,options)=>{state.notifies.push({text,options});return {isSent:true,channel:'test'};},resolve:()=>({Box:element('Box'),Text:element('Text'),Button:element('Button')})},
    process:{run:async args=>{calls.push(args);return {stdout:JSON.stringify({ok:true,burn:{mode:'enforce',burst:{count:2,limit:40},sustained:{count:0,limit:40},tokens:{used:100,limit:1e9}}})};}}};
  const fire=(event,e={})=>hooks.find(h=>h.event===event&&(!h.matcher?.component||h.matcher.component===e.component)).fn($,e,async value=>event==='ui.render'?null:value);
  const flatten=node=>typeof node==='string'?node:(node?.props?.children??[]).map(flatten).join('');
  return {$,state,calls,fire,advance:ms=>{now+=ms;},tick:()=>timers[0].fn(),timers,
    line:async()=>flatten(await fire('ui.render',{component:'AbovePrompt',props:{bodyColumns:200}})),
    pane:async()=>flatten(await fire('ui.render',{component:'Pane',requestId:'agentguard'}))};
}

test('the twenty-second timer re-reads host usage even while idle and preserves the last good reading on error', async t=>{
  const h=await liveHarness(t);
  await h.fire('session.start',{surface:'terminal',isInteractive:true});
  assert.equal(h.timers[0].ms,20000);
  assert.match(await h.line(),/5-hour 73%/);
  h.state.usage.rateLimits[0].percentUsed=80;
  h.advance(20000);await h.tick();
  assert.equal(h.state.reads,2);
  assert.equal(h.calls.length,1,'idle polling does not spawn another status process');
  assert.match(await h.line(),/5-hour 80%/);
  h.state.error=true;h.advance(120000);await h.tick();
  assert.match(await h.line(),/5-hour 80% \(2m ago\)/);
  h.state.error=false;await h.tick();
  assert.doesNotMatch(await h.line(),/ago/);
});

test('model buttons only fill exact commands, use unique hotkeys and never submit or change helpers', async t=>{
  const h=await liveHarness(t,{quick_models:'custom/model,opus,bad id,\n/model bad'});
  await h.fire('session.start',{surface:'terminal',isInteractive:true});
  assert.deepEqual(h.state.fills,[]);
  const tree=await h.fire('ui.render',{component:'Pane',requestId:'agentguard'});
  const nodes=node=>[node,...(node?.props?.children??[]).filter(n=>typeof n==='object').flatMap(nodes)];
  const buttons=nodes(tree).filter(n=>n.type==='Button'&&n.props.key.startsWith('model:'));
  assert.deepEqual(buttons.map(b=>b.props.label),['Fable','Opus','Sonnet','Haiku 5.5','custom/model']);
  assert.equal(new Set(buttons.map(b=>b.props.hotkey)).size,buttons.length);
  for(const button of buttons)await button.props.onPress();
  assert.deepEqual(h.state.fills,buttons.map(b=>({text:'/model '+b.props.key.slice(6),mode:'replace'})));
  assert.equal(h.state.model,'claude-opus-5-5');
  assert.equal(h.calls.length,1);
  const manifest=require('../.claude-plugin/plugin.json');
  assert.equal(manifest.userConfig.quick_models.default,'');
  assert.equal(manifest.userConfig.quick_models.sensitive,false);
  assert.equal(manifest.userConfig.helper_model,undefined);
});

test('the highest plan window triggers exactly one cheaper-model suggestion per eighty-percent crossing', async t=>{
  const h=await liveHarness(t);
  await h.fire('session.start',{surface:'terminal',isInteractive:true});
  h.state.usage.rateLimits.push({...h.state.usage.rateLimits[0],kind:'seven_day',percentUsed:80});
  await h.tick();await h.tick();await h.fire('session.measure');
  assert.deepEqual(h.state.suggestions,[{text:'/model sonnet'}]);
  h.state.usage.rateLimits[1].percentUsed=79;await h.tick();
  h.state.usage.rateLimits[1].percentUsed=81;await h.tick();
  assert.equal(h.state.suggestions.length,2);
  h.state.usage.rateLimits[1].percentUsed=79;await h.tick();
  h.state.model='unknown-model';h.state.usage.rateLimits[1].percentUsed=81;await h.tick();
  assert.equal(h.state.suggestions.length,2,'unknown prices are not guessed');
  assert.deepEqual(h.state.fills,[]);
});

test('PreModelSwitch logs the host catalog estimate and passes the event through, even if display fails', async t=>{
  const h=await liveHarness(t);
  await h.fire('session.start',{surface:'terminal',isInteractive:true});
  const e=Object.freeze({pricing:'catalog',estimated_cache_write_usd:1.25,to_model:'claude-sonnet-5-5'});
  assert.equal(await h.fire('classic.PreModelSwitch',e),e);
  assert.equal(h.state.logs[0],'AgentGuard: switching re-sends this chat, ≈ $1.25 at API list price, not a bill.');
  for(const pricing of ['configured','default']) {
    await h.fire('classic.PreModelSwitch',{...e,pricing});
    assert.doesNotMatch(h.state.logs.at(-1),/\$/);
  }
  h.$.ui.log=()=>{throw Error('display unavailable');};
  assert.equal(await h.fire('classic.PreModelSwitch',e),e);
});

test('the panel lists all host limits, removed limits disappear, and invalid host readings preserve the last result', async t=>{
  const h=await liveHarness(t);
  const reset=h.state.usage.rateLimits[0].resetsAt;
  h.state.usage.rateLimits.push({kind:'seven_day',percentUsed:81,resetsAt:reset},{kind:'seven_day_opus',percentUsed:42,resetsAt:reset});
  await h.fire('session.start',{surface:'terminal',isInteractive:true});
  const panel=await h.pane();
  for(const value of ['73% (5-hour)','81% (weekly)','42% (seven day opus)',reset])assert.ok(panel.includes(value),value);
  h.state.usage={rateLimits:null};h.advance(120000);await h.tick();
  assert.match(await h.line(),/weekly 81% \(2m ago\)/);
  h.state.usage={rateLimits:[]};await h.tick();
  assert.doesNotMatch(await h.pane(),/Plan usage:/);
});

test('the band counts down to auto-compaction from Claude Code\'s own figures, read with the summary breakdown once per two minutes', async t=>{
  const h=await liveHarness(t);
  await h.fire('session.start',{surface:'terminal',isInteractive:true});
  // No breakdown from the host: nothing is shown and nothing is guessed.
  assert.doesNotMatch(await h.line(),/auto-compact/);
  assert.deepEqual(h.state.usageArgs[0],{breakdown:'summary'});
  h.state.usage.context={tokens:720e3,window:1e6,breakdown:{isAutoCompactEnabled:true,autoCompactThreshold:1e6}};
  h.advance(20000);await h.tick();
  // Inside the two minutes the read is the plain one, so the point is not known yet.
  assert.equal(h.state.usageArgs.at(-1),undefined);
  assert.doesNotMatch(await h.line(),/auto-compact/);
  h.advance(120000);await h.tick();
  assert.deepEqual(h.state.usageArgs.at(-1),{breakdown:'summary'});
  assert.match(await h.line(),/tokens 100 of 1B · 28% to auto-compact · 5-hour 73%/);
  assert.match(await h.pane(),/Context: 720,000 of 1,000,000 tokens, 28% left before Claude Code compacts the conversation\./);
  assert.equal(h.state.reads,3,'one host read per tick, breakdown or not');
  // Auto-compaction off: the field goes away at the next two-minute read.
  h.state.usage.context.breakdown.isAutoCompactEnabled=false;h.advance(120000);await h.tick();
  assert.doesNotMatch(await h.line(),/auto-compact/);
});

test('one toast and one notification per approach to the compaction point, armed again after a compaction', async t=>{
  const h=await liveHarness(t);
  h.state.usage.context={tokens:500e3,window:1e6,breakdown:{isAutoCompactEnabled:true,autoCompactThreshold:1e6}};
  await h.fire('session.start',{surface:'terminal',isInteractive:true});
  assert.match(await h.line(),/50% to auto-compact/);
  assert.deepEqual(h.state.toasts,[]);
  h.state.usage.context.tokens=905e3;await h.tick();
  assert.match(await h.line(),/10% to auto-compact/);
  assert.equal(h.state.toasts.length,1);
  assert.equal(h.state.toasts[0].text,'10% of context left before Claude Code auto-compacts. Finish this step, or type /compact and say what to keep.');
  assert.equal(h.state.toasts[0].options.timeoutMs,15000);
  assert.deepEqual(h.state.notifies.map(n=>[n.text,n.options.title]),[[h.state.toasts[0].text,'AgentGuard']]);
  h.state.usage.context.tokens=980e3;await h.tick();await h.fire('session.measure');
  assert.equal(h.state.toasts.length,1,'the warning is not repeated while the context stays high');
  // A compaction brings the context down; the next approach warns once more.
  h.state.usage.context.tokens=150e3;await h.tick();
  assert.match(await h.line(),/85% to auto-compact/);
  h.state.usage.context.tokens=950e3;await h.tick();
  assert.equal(h.state.toasts.length,2);
  assert.equal(h.state.notifies.length,2);
  // A Claude Code without toasts or notifications: the band still works, and
  // readUsage runs on past the warning (the plan suggestion after it still fires).
  delete h.$.ui.toast;delete h.$.ui.notify;
  h.state.usage.context.tokens=150e3;await h.tick();
  h.state.usage.context.tokens=950e3;h.state.usage.rateLimits[0].percentUsed=80;await h.tick();
  assert.match(await h.line(),/5% to auto-compact/);
  assert.deepEqual(h.state.suggestions,[{text:'/model sonnet'}],'the code after the warning still ran');
});

test('a slow or failing notification never holds the refresh, and the countdown does not depend on the plan-limit reading', async t=>{
  const h=await liveHarness(t);
  h.$.ui.notify=()=>new Promise(()=>{});  // a Notification hook that never answers
  h.state.usage.context={tokens:950e3,window:1e6,breakdown:{isAutoCompactEnabled:true,autoCompactThreshold:1e6}};
  await h.fire('session.start',{surface:'terminal',isInteractive:true});
  assert.equal(h.state.toasts.length,1,'session.start returned with the notification still pending');
  h.$.ui.notify=async()=>{throw Error('refused');};
  h.state.usage.context.tokens=150e3;await h.tick();h.state.usage.context.tokens=950e3;await h.tick();
  assert.equal(h.state.toasts.length,2);
  await h.tick();
  assert.equal(h.state.toasts.length,2,'a rejected notification does not re-arm the warning');
  // A gateway spend window without a reset time fails the plan-limit validation;
  // the context reading still counts down and still warns.
  h.state.usage.rateLimits=[{kind:'spend_limit',percentUsed:12}];
  h.state.usage.context.tokens=150e3;await h.tick();
  assert.match(await h.line(),/85% to auto-compact/);
  assert.match(await h.line(),/5-hour 73%/,'the last good plan reading is kept, as before');
  assert.doesNotMatch(await h.line(),/spend_limit/);
  h.state.usage.context.tokens=960e3;await h.tick();
  assert.match(await h.line(),/4% to auto-compact/);
  assert.equal(h.state.toasts.length,3);
});

test('a model change reads the new compaction point at once instead of counting down against the old one', async t=>{
  const h=await liveHarness(t);
  h.state.usage.context={tokens:100e3,window:200e3,breakdown:{isAutoCompactEnabled:true,autoCompactThreshold:160e3}};
  await h.fire('session.start',{surface:'terminal',isInteractive:true});
  assert.match(await h.line(),/38% to auto-compact/);
  // The switch to a 1M model lands within the two minutes: the plain read sees
  // the new window and reads the point again in the same tick.
  h.state.usage.context={tokens:300e3,window:1e6,breakdown:{isAutoCompactEnabled:true,autoCompactThreshold:1e6}};
  h.advance(20000);await h.tick();
  assert.equal(h.state.reads,3,'one plain read, then the point read again');
  assert.deepEqual(h.state.usageArgs.at(-1),{breakdown:'summary'});
  assert.match(await h.line(),/70% to auto-compact/);
  assert.deepEqual(h.state.toasts,[],'no false warning from the old model\'s point');
  // PreModelSwitch alone also forces the next read to fetch the point.
  await h.fire('classic.PreModelSwitch',{});
  h.advance(20000);await h.tick();
  assert.deepEqual(h.state.usageArgs.at(-1),{breakdown:'summary'});
});

test('a host that rejects the breakdown argument gets one plain read in its place, once per two minutes', async t=>{
  const h=await liveHarness(t);
  const plain=h.$.session.usage;
  h.$.session.usage=async args=>{if(args&&args.breakdown){h.state.reads++;throw Error('unknown argument');}return plain(args);};
  await h.fire('session.start',{surface:'terminal',isInteractive:true});
  assert.equal(h.state.reads,2,'the refused read plus its plain fallback');
  assert.match(await h.line(),/5-hour 73%/);
  assert.doesNotMatch(await h.line(),/auto-compact/);
  h.advance(20000);await h.tick();
  assert.equal(h.state.reads,3,'inside the two minutes the tick costs one read');
  h.advance(120000);await h.tick();
  assert.equal(h.state.reads,5);
});

test('past the session token limit the pane and the band both say so instead of an impossible fraction', async t=>{
  const h=await liveHarness(t);
  const over={ok:true,burn:{mode:'enforce',burst:{count:2,limit:40},sustained:{count:0,limit:40},tokens:{used:24e9,limit:5e9}}};
  h.$.process.run=async args=>{h.calls.push(args);return {stdout:JSON.stringify(over)};};
  await h.fire('session.start',{surface:'terminal',isInteractive:true});
  assert.match(await h.line(),/tokens 24B, past the 5B limit: sub-agents wait for your yes/);
  assert.doesNotMatch(await h.line(),/24B of 5B/);
  assert.match(await h.pane(),/Tokens: 24B\. This session passed its 5B token limit, so each new sub-agent waits for your yes\./);
  over.burn.mode='shadow';await h.fire('session.measure');await h.fire('turn.complete',{});
  assert.match(await h.pane(),/Tokens: 24B\. This session passed its 5B token limit\. Watching only, so nothing waits\./);
});
