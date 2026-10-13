/**
 * Browser scripts shared by the non-SR display pages: change notifications (with remote
 * reconfiguration), sound unlocking, race beeps, and synchronised audio playback.
 * Each returns inline script source; configuration is embedded as JSON.
 */

const json = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c');

/**
 * How long every screen holds live audio between receiving it and it coming out of the speaker
 * (network + buffer + output). Each screen measures its own and steers its buffer to match.
 */
export const LIVE_AUDIO_DELAY_MS = 400;

/**
 * Change feed. Top-level pages open the server's event stream and pass each revision on to
 * their panels (iframes), so a custom screen holds one connection however many panels it has.
 * Top-level pages also reload when their own settings change, so screens are configured remotely.
 */
export function revisionScript(config: { panel: boolean; configUrl: string; hash: string }): string {
  return String.raw`(function(cfg){
  var handlers=[];
  window.ccOnRevision=function(fn){handlers.push(fn);};
  var fire=function(){handlers.forEach(function(fn){try{fn();}catch(error){console.error(error);}});};
  if(cfg.panel){
    window.addEventListener('message',function(event){if(event.origin===location.origin&&event.data==='cc-revision')fire();});
    return;
  }
  try{
    new EventSource('/api/public/changes').addEventListener('revision',function(){
      fire();
      document.querySelectorAll('iframe').forEach(function(frame){try{frame.contentWindow.postMessage('cc-revision',location.origin);}catch(error){}});
    });
  }catch(error){}
  var pending=null;
  window.ccOnRevision(function(){
    clearTimeout(pending);
    pending=setTimeout(function(){
      fetch(cfg.configUrl,{cache:'no-store'}).then(function(response){return response.ok?response.json():null;})
        .then(function(result){if(result&&result.hash&&result.hash!==cfg.hash)location.reload();}).catch(function(){});
    },400);
  });
})(${json(config)});`;
}

/** One AudioContext per page, and a "Click to enable sound" button when the browser blocks audio. */
export const soundSupportScript = String.raw`(function(){
  var context=null,listeners=[],button=null;
  var getContext=function(){
    if(!context){var Context=window.AudioContext||window.webkitAudioContext;if(!Context)return null;context=new Context();}
    return context;
  };
  var unlock=function(){
    var audio=getContext();
    if(audio&&audio.state!=='running')audio.resume().catch(function(){});
    listeners.forEach(function(fn){try{fn();}catch(error){}});
    if(button){button.remove();button=null;}
  };
  var needUnlock=function(){
    if(button||!document.body)return;
    button=document.createElement('button');
    button.type='button';
    button.className='sound-unlock';
    button.textContent='Click to enable sound';
    button.addEventListener('click',unlock);
    document.body.appendChild(button);
  };
  document.addEventListener('pointerdown',unlock,true);
  document.addEventListener('keydown',unlock,true);
  window.CCSound={context:getContext,needUnlock:needUnlock,onUnlock:function(fn){listeners.push(fn);}};
})();`;

/**
 * Race-style beeps scheduled on the audio clock against server time: short beeps on 3, 2, 1,
 * a long high beep on GO and a horn at END. Defines ccScheduleBeep(serverTimeMs, kind).
 */
export function beepScript(config: { volume: number }): string {
  return String.raw`(function(cfg){
  var scheduled={};
  var sounds={tick:{frequency:880,seconds:.2,type:'square'},go:{frequency:1760,seconds:.75,type:'square'},end:{frequency:330,seconds:1.4,type:'sawtooth'}};
  window.ccScheduleBeep=function(at,kind){
    var key=kind+':'+at;
    if(scheduled[key]||!window.ServerClock)return;
    var lead=at-window.ServerClock.now();
    if(lead>1500||lead<-120)return;
    var context=window.CCSound&&window.CCSound.context();
    if(!context)return;
    if(context.state!=='running'){window.CCSound.needUnlock();return;}
    scheduled[key]=true;
    var sound=sounds[kind]||sounds.tick;
    var start=context.currentTime+Math.max(0,lead/1000)-(context.outputLatency||context.baseLatency||0);
    start=Math.max(context.currentTime,start);
    var volume=Math.max(0,Math.min(1,cfg.volume/100))*.3;
    var oscillator=context.createOscillator();
    var gain=context.createGain();
    oscillator.type=sound.type;
    oscillator.frequency.value=sound.frequency;
    gain.gain.setValueAtTime(0,start);
    gain.gain.linearRampToValueAtTime(volume,start+.006);
    gain.gain.setValueAtTime(volume,start+sound.seconds-.04);
    gain.gain.linearRampToValueAtTime(0,start+sound.seconds);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start+sound.seconds+.05);
  };
  // Start the audio engine now, so the first beep is on time; ask for a click if the browser blocks it.
  var context=window.CCSound&&window.CCSound.context();
  if(context&&context.state!=='running'){
    context.resume().catch(function(){});
    setTimeout(function(){if(context.state!=='running')window.CCSound.needUnlock();},800);
  }
})(${json(config)});`;
}

/**
 * Plays the competition's audio: the shared playlist (every screen works out the same track
 * and position from server time and corrects drift) or a live WebRTC broadcast.
 */
export function audioPlayerScript(config: { stateUrl: string; volume: number; speakerDelayMs: number }): string {
  return String.raw`(function(cfg){
  var LIVE_DELAY_MS=${LIVE_AUDIO_DELAY_MS};
  // Sound leaves the browser this long before it is heard: the device's audio output plus any
  // delay the screen's own speaker adds (set per display), so playback runs that much ahead.
  var outputDelayMs=function(){
    var context=window.CCSound&&window.CCSound.context();
    var device=context?(context.outputLatency||context.baseLatency||0)*1000:0;
    return device+(cfg.speakerDelayMs||0);
  };
  var state=null,players=[new Audio(),new Audio()],active=0,currentTrack=null,live=null;
  players.forEach(function(player){player.preload='auto';});
  var serverNow=function(){return window.ServerClock?window.ServerClock.now():Date.now();};
  var volume=function(){return Math.max(0,Math.min(1,(state?state.volume:80)/100*cfg.volume/100));};
  var play=function(player){var result=player.play();if(result&&result.catch)result.catch(function(){if(window.CCSound)window.CCSound.needUnlock();});};
  var position=function(tracks,startedAt,now,loop){
    var total=tracks.reduce(function(sum,track){return sum+track.durationMs;},0);
    if(!tracks.length||total<=0)return null;
    var at=now-startedAt;
    if(at<0)return {index:0,offsetMs:at};
    if(at>=total){if(!loop)return null;at%=total;}
    for(var index=0;index<tracks.length;index++){
      if(at<tracks[index].durationMs)return {index:index,offsetMs:at};
      at-=tracks[index].durationMs;
    }
    return null;
  };
  var stopFiles=function(){players.forEach(function(player){player.pause();});currentTrack=null;};
  var tick=function(){
    if(!state||state.mode!=='playing'||state.startedAt===null){stopFiles();return;}
    var at=position(state.tracks,state.startedAt,serverNow(),state.loop);
    if(!at){stopFiles();return;}
    var track=state.tracks[at.index];
    var player=players[active];
    if(currentTrack!==track.id){
      var other=players[1-active];
      if(other.dataset.track===track.id){player.pause();active=1-active;player=other;}
      else if(player.dataset.track!==track.id){player.dataset.track=track.id;player.src=track.url;}
      currentTrack=track.id;
    }
    player.volume=volume();
    if(at.offsetMs<0){
      player.pause();
      if(at.offsetMs>-400)setTimeout(tick,Math.max(0,-at.offsetMs));
      return;
    }
    var expected=(at.offsetMs+outputDelayMs())/1000;
    if(player.readyState<1)return;
    var drift=player.currentTime-expected;
    if(player.paused){player.currentTime=expected;player.playbackRate=1;play(player);}
    else if(Math.abs(drift)>.25){player.currentTime=expected;player.playbackRate=1;}
    else if(Math.abs(drift)>.03){player.playbackRate=drift>0?.97:1.03;}
    else player.playbackRate=1;
    var remaining=track.durationMs-at.offsetMs;
    if(remaining<15000){
      var nextIndex=at.index+1;
      if(nextIndex>=state.tracks.length)nextIndex=state.loop?0:-1;
      var idle=players[1-active];
      if(nextIndex>=0&&state.tracks[nextIndex].id!==track.id&&idle.dataset.track!==state.tracks[nextIndex].id){
        idle.dataset.track=state.tracks[nextIndex].id;idle.src=state.tracks[nextIndex].url;idle.load();
      }
    }
  };
  var waitForIce=function(connection){
    if(connection.iceGatheringState==='complete')return Promise.resolve();
    return new Promise(function(resolve){
      var done=function(){if(connection.iceGatheringState==='complete'){connection.removeEventListener('icegatheringstatechange',done);resolve();}};
      connection.addEventListener('icegatheringstatechange',done);
      setTimeout(resolve,3000);
    });
  };
  var stopLive=function(){
    if(!live)return;
    try{live.events.close();}catch(error){}
    if(live.connection)live.connection.close();
    clearInterval(live.syncTimer);
    live.audio.pause();live.audio.srcObject=null;
    live=null;
  };
  var startLive=function(info){
    if(live&&live.session===info.session)return;
    stopLive();
    var id=(Date.now().toString(36)+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9]/g,'').slice(0,40);
    var base='/api/public/audio-live/'+encodeURIComponent(info.session);
    var current={session:info.session,connection:null,audio:new Audio(),events:null,syncTimer:null,samples:[],bufferMs:LIVE_DELAY_MS/2,latencyMs:null};
    live=current;
    var post=function(message){
      message.from=id;
      return fetch(base+'/signal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(message)}).catch(function(){});
    };
    current.events=new EventSource(base+'/listen?listener='+id);
    current.events.onmessage=function(event){
      var message=JSON.parse(event.data);
      if(message.type==='ended'){if(live===current)stopLive();return;}
      if(message.type!=='offer')return;
      if(current.connection)current.connection.close();
      clearInterval(current.syncTimer);
      current.samples=[];
      var connection=new RTCPeerConnection({iceServers:info.iceServers||[]});
      current.connection=connection;
      connection.ontrack=function(trackEvent){
        var receiver=trackEvent.receiver;
        var setBuffer=function(ms){
          current.bufferMs=Math.max(0,Math.min(4000,ms));
          try{
            if('jitterBufferTarget' in receiver)receiver.jitterBufferTarget=current.bufferMs;
            else receiver.playoutDelayHint=current.bufferMs/1000;
          }catch(error){}
        };
        setBuffer(current.bufferMs);
        current.audio.srcObject=trackEvent.streams[0]||new MediaStream([trackEvent.track]);
        current.audio.volume=volume();
        play(current.audio);
        // Every screen gets the same stream from the same broadcaster, so what differs between screens
        // is their network delay, how much audio they are holding in their buffer, and their speaker.
        // Each second, add those up and steer the buffer so the total is the same on every screen.
        var previous=null;
        current.syncTimer=setInterval(function(){
          connection.getStats().then(function(report){
            var inbound=null,pair=null;
            report.forEach(function(stat){
              if(stat.type==='inbound-rtp'&&stat.kind==='audio')inbound=stat;
              if(stat.type==='candidate-pair'&&stat.nominated&&stat.state==='succeeded')pair=stat;
            });
            if(!inbound||inbound.jitterBufferEmittedCount===undefined)return;
            var sample={delay:inbound.jitterBufferDelay,count:inbound.jitterBufferEmittedCount};
            if(previous&&sample.count>previous.count){
              var bufferedMs=(sample.delay-previous.delay)/(sample.count-previous.count)*1000;
              var networkMs=pair&&pair.currentRoundTripTime?pair.currentRoundTripTime*500:0;
              current.samples.push(networkMs+bufferedMs+outputDelayMs());
              if(current.samples.length>4)current.samples.shift();
              var sorted=current.samples.slice().sort(function(a,b){return a-b;});
              current.latencyMs=Math.round(sorted[Math.floor(sorted.length/2)]);
              var error=LIVE_DELAY_MS-current.latencyMs;
              if(current.samples.length>=3&&Math.abs(error)>6){setBuffer(current.bufferMs+error*.7);current.samples=[];}
            }
            previous=sample;
          }).catch(function(){});
        },1000);
      };
      connection.setRemoteDescription({type:'offer',sdp:message.sdp})
        .then(function(){return connection.createAnswer();})
        .then(function(answer){return connection.setLocalDescription(answer);})
        .then(function(){return waitForIce(connection);})
        .then(function(){return post({type:'answer',sdp:connection.localDescription.sdp});})
        .catch(function(error){console.error('Live audio failed',error);});
    };
  };
  var apply=function(next){
    state=next;
    if(state.mode==='live'&&state.live){stopFiles();startLive(state.live);if(live)live.audio.volume=volume();}
    else{stopLive();tick();}
  };
  var load=function(){
    fetch(cfg.stateUrl,{cache:'no-store'}).then(function(response){return response.ok?response.json():null;})
      .then(function(next){if(next)apply(next);}).catch(function(){});
  };
  if(window.CCSound)window.CCSound.onUnlock(function(){tick();if(live)play(live.audio);});
  // For troubleshooting a screen from the browser console: how far it is from where it should be.
  window.ccAudioStatus=function(){
    var player=players[active];
    var at=state&&state.mode==='playing'&&state.startedAt!==null?position(state.tracks,state.startedAt,serverNow(),state.loop):null;
    return {mode:state?state.mode:null,track:currentTrack,playing:!player.paused,currentTime:player.currentTime,
      expected:at?at.offsetMs/1000:null,driftMs:at&&!player.paused?Math.round((player.currentTime-at.offsetMs/1000)*1000):null,
      live:live?{connected:Boolean(live.connection&&live.connection.connectionState==='connected'),playing:!live.audio.paused,
        state:live.connection?live.connection.connectionState+'/'+live.connection.signalingState+'/'+live.connection.iceConnectionState:'waiting for the broadcaster',
        delayMs:live.latencyMs,targetMs:LIVE_DELAY_MS,bufferMs:Math.round(live.bufferMs)}:null};
  };
  window.ccAudioConnection=function(){return live&&live.connection;};
  var pending=null;
  if(window.ccOnRevision)window.ccOnRevision(function(){clearTimeout(pending);pending=setTimeout(load,150);});
  load();
  setInterval(load,30000);
  setInterval(tick,250);
})(${json(config)});`;
}

/**
 * Rotates each area of a custom screen through its panels (and the sponsor images). Turns are
 * taken from server time, so every copy of the same screen shows the same panel at once.
 */
export function customScreenScript(config: { rotateMs: number; imageMs: number }): string {
  return String.raw`(function(cfg){
  var now=function(){return window.ServerClock?window.ServerClock.now():Date.now();};
  var groups=[];
  document.querySelectorAll('.custom-area').forEach(function(area){
    var panels=[].slice.call(area.querySelectorAll(':scope>.custom-panel[data-panel]'));
    if(panels.length)groups.push({items:panels,period:cfg.rotateMs});
  });
  document.querySelectorAll('.custom-images').forEach(function(box){
    var images=[].slice.call(box.querySelectorAll('img'));
    if(images.length)groups.push({items:images,period:cfg.imageMs});
  });
  var show=function(){
    groups.forEach(function(group){
      var index=Math.floor(now()/group.period)%group.items.length;
      group.items.forEach(function(item,itemIndex){item.classList.toggle('active',itemIndex===index);});
    });
  };
  show();
  setInterval(show,250);
})(${json(config)});`;
}
