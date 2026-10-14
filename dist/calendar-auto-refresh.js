import {dateKey} from './core.js';
import {berlinLocalToInstant} from './calendar-engine.js';

export const CALENDAR_REFRESH_TIMING=Object.freeze({interval:15*60_000,busy:5_000,retries:Object.freeze([60_000,120_000,300_000,900_000])});

// Calendar boundaries are Berlin wall-clock midnights, including DST changes.
// The automatic window follows today, rather than a historical month in the UI.
export function calendarRefreshRange(month,{automatic=false,today=dateKey()}={}) {
  if(typeof automatic!=='boolean')throw new TypeError('Ungültiger Aktualisierungsmodus.');
  let first,fromOffset=0,toOffset=1;
  if(automatic){
    berlinLocalToInstant(today,'00:00');
    first=today.slice(0,7)+'-01';fromOffset=-1;toOffset=4;
  }else{
    if(typeof month!=='string'||!/^\d{4}-\d{2}$/.test(month))throw new Error('Ein gültiger Kalendermonat wird benötigt.');
    first=month+'-01';berlinLocalToInstant(first,'00:00');
  }
  const boundary=offset=>{
    const date=new Date(first+'T12:00:00Z');date.setUTCMonth(date.getUTCMonth()+offset);
    return berlinLocalToInstant(date.toISOString().slice(0,10),'00:00');
  };
  return {from:boundary(fromOffset),to:boundary(toOffset)};
}

// Timing only: the caller owns account reads, native cancellation and commits.
// One active promise survives pause/resume so slow native requests never overlap.
export function createCalendarAutoRefresh({refresh,isVisible=()=>globalThis.document?.visibilityState!=='hidden',timers=globalThis}={}) {
  if(typeof refresh!=='function'||typeof isVisible!=='function'||typeof timers?.setTimeout!=='function'||typeof timers?.clearTimeout!=='function')
    throw new TypeError('Ungültiger Auftrag für die Kalenderaktualisierung.');
  let started=false,paused=false,disposed=false,generation=0,timer=null,running=null,initial=null,rerun=false,forceRerun=false,hiddenDue=false,failures=0;
  const visible=()=>{try{return isVisible()===true;}catch{return false;}};
  const stopped=()=>({skipped:true,...(disposed?{disposed:true}:{paused:true})});
  function clearTimer(){if(timer!==null){timers.clearTimeout(timer);timer=null;}}
  function arm(delay,force=false){
    clearTimer();if(!started||paused||disposed||running)return;
    const epoch=generation;
    timer=timers.setTimeout(()=>{
      if(disposed||paused||!started||epoch!==generation)return;
      timer=null;
      if(!force&&!visible()){hiddenDue=true;return;}
      hiddenDue=false;void attempt();
    },delay);
    timer?.unref?.();
  }
  function attempt(){
    if(disposed||paused||!started)return Promise.resolve(stopped());
    if(running){rerun=true;return running.promise;}
    clearTimer();hiddenDue=false;
    const run={generation,promise:null,result:null};running=run;
    run.promise=Promise.resolve().then(()=>{
      if(disposed||paused||run.generation!==generation)return stopped();
      return refresh();
    }).then(result=>run.result=result&&typeof result==='object'?result:{}).catch(()=>run.result={failed:true}).finally(()=>{
      if(running===run)running=null;
      if(disposed||paused||!started)return;
      if(rerun){const force=forceRerun;rerun=false;forceRerun=false;arm(0,force);return;}
      if(run.generation!==generation)return;
      if(run.result.failed===true){failures=Math.min(CALENDAR_REFRESH_TIMING.retries.length,failures+1);arm(CALENDAR_REFRESH_TIMING.retries[failures-1]);}
      else if(run.result.skipped===true)arm(CALENDAR_REFRESH_TIMING.busy);
      else{failures=0;arm(CALENDAR_REFRESH_TIMING.interval);}
    });
    return run.promise;
  }
  return {
    start(){
      if(disposed)return Promise.resolve(stopped());
      if(started)return initial;
      started=true;paused=false;generation++;initial=attempt();return initial;
    },
    refreshSoon(){
      if(disposed||paused||!started)return Promise.resolve(stopped());
      if(running){rerun=true;return running.promise;}
      if(!visible()){clearTimer();hiddenDue=true;return Promise.resolve({skipped:true,hidden:true});}
      return attempt();
    },
    pause(){paused=true;generation++;rerun=false;forceRerun=false;hiddenDue=false;clearTimer();},
    resume(){
      if(disposed||!started)return Promise.resolve(stopped());
      if(paused){paused=false;generation++;failures=0;if(running){rerun=true;forceRerun=true;return running.promise;}return attempt();}
      if(hiddenDue&&visible())return attempt();
      return running?.promise||Promise.resolve({skipped:true});
    },
    dispose(){if(disposed)return;disposed=true;paused=true;generation++;rerun=false;forceRerun=false;hiddenDue=false;clearTimer();},
  };
}
