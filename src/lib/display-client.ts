/**
 * Browser scripts shared by the non-SR display pages: change notifications (with remote
 * reconfiguration), sound unlocking, race beeps, and synchronised audio playback.
 * Each returns inline script source; configuration is embedded as JSON.
 */

const json = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c');

/**
 * Live audio delay used until the server announces the shared one (it then adapts to the
 * slowest screen; see nextLiveDelay).
 */
export const LIVE_AUDIO_DELAY_MS = 600;

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
 * and position from server time and corrects drift) or live sound relayed through the server.
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
  // Live audio arrives as Opus chunks stamped with their capture time on the server clock. Each
  // screen decodes them and plays every chunk exactly LIVE_DELAY_MS after it was captured, so all
  // screens play the same sound at the same moment, whatever network they are on.
  var stopLive=function(){
    if(!live)return;
    try{live.events.close();}catch(error){}
    try{if(live.decoder&&live.decoder.state!=='closed')live.decoder.close();}catch(error){}
    clearInterval(live.reportTimer);
    if(live.gain)live.gain.disconnect();
    live=null;
  };
  var decodeBase64=function(text){
    var binary=atob(text),bytes=new Uint8Array(binary.length);
    for(var index=0;index<binary.length;index++)bytes[index]=binary.charCodeAt(index);
    return bytes;
  };
  var startLive=function(info){
    if(live&&live.session===info.session)return;
    stopLive();
    var context=window.CCSound&&window.CCSound.context();
    if(!context||typeof AudioDecoder==='undefined'){console.error('This browser cannot play live audio (needs Web Audio and WebCodecs; use Chrome or Edge).');return;}
    if(context.state!=='running')window.CCSound.needUnlock();
    var id=(Date.now().toString(36)+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9]/g,'').slice(0,40);
    var current={session:info.session,events:null,decoder:null,gain:context.createGain(),nextTime:null,received:0,played:0,late:0,skipped:0,outOfOrder:0,lastChunk:undefined,lastLeadMs:null,recent:[],
      delays:[{from:0,delay:LIVE_DELAY_MS}],arrivals:[],reportTimer:null};
    // The shared delay in force for a chunk: changes apply from a given chunk, the same on every screen.
    var delayFor=function(timestamp){
      for(var index=current.delays.length-1;index>=0;index--)if(current.delays[index].from<=timestamp)return current.delays[index].delay;
      return current.delays[0].delay;
    };
    current.gain.gain.value=volume();
    current.gain.connect(context.destination);
    live=current;
    current.decoder=new AudioDecoder({
      output:function(data){
        try{
          var frames=data.numberOfFrames,channels=Math.min(2,data.numberOfChannels);
          var buffer=context.createBuffer(2,frames,data.sampleRate);
          for(var channel=0;channel<2;channel++){
            var samples=new Float32Array(frames);
            data.copyTo(samples,{planeIndex:Math.min(channel,channels-1),format:'f32-planar'});
            buffer.copyToChannel(samples,channel);
          }
          // When this chunk should be heard, in server time, then on this screen's audio clock.
          var now=serverNow();
          current.arrivals.push(now-data.timestamp/1000);
          if(current.arrivals.length>500)current.arrivals.shift();
          var heardAt=data.timestamp/1000+delayFor(data.timestamp);
          var startAt=context.currentTime+(heardAt-now-outputDelayMs())/1000;
          current.lastLeadMs=Math.round((startAt-context.currentTime)*1000);
          var rate=1;
          if(current.nextTime!==null){
            var error=startAt-current.nextTime;
            if(Math.abs(error)<.08){
              // Small drift (clocks wander by milliseconds): play straight on, a touch faster or
              // slower (at most 0.3%, inaudible) until back on time. No skips, no gaps.
              rate=1-Math.max(-.003,Math.min(.003,error*.2));
              startAt=current.nextTime;
            }else if(error<0){current.skipped++;return;}
            // A later start (the shared delay grew) leaves a short silence, once.
          }
          if(startAt<context.currentTime+.005){current.late++;current.nextTime=null;return;}
          var source=context.createBufferSource();
          source.buffer=buffer;
          source.playbackRate.value=rate;
          source.connect(current.gain);
          source.start(startAt);
          current.nextTime=startAt+buffer.duration/rate;
          current.played++;
        }finally{data.close();}
      },
      error:function(error){console.error('Live audio decoding failed',error);}
    });
    current.decoder.configure({codec:'opus',sampleRate:48000,numberOfChannels:2});
    current.events=new EventSource('/api/public/audio-live/'+encodeURIComponent(info.session)+'/listen?listener='+id);
    // Tell the server how much delay this screen needs: its slow arrivals (99th percentile) plus
    // its own output and speaker delay. The server sets one delay that suits every screen.
    current.reportTimer=setInterval(function(){
      if(current.arrivals.length<10)return;
      var sorted=current.arrivals.slice().sort(function(a,b){return a-b;});
      var need=sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.99))]+outputDelayMs()+10;
      // Dropouts over the last minute, for the admin page.
      current.recent.push({late:current.late,skipped:current.skipped});
      if(current.recent.length>30)current.recent.shift();
      var minuteAgo=current.recent[0];
      fetch('/api/public/audio-live/'+encodeURIComponent(info.session)+'/report',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({from:id,needMs:Math.max(0,Math.min(10000,Math.round(need))),late:current.late-minuteAgo.late,skipped:current.skipped-minuteAgo.skipped})}).catch(function(){});
    },2000);
    current.events.onmessage=function(event){
      var message=JSON.parse(event.data);
      if(message.type==='ended'){if(live===current)stopLive();return;}
      if(message.type!=='audio'||!current.decoder||current.decoder.state!=='configured')return;
      var latest=current.delays[current.delays.length-1];
      if(message.delayMs&&(message.delayMs!==latest.delay||message.delayFrom!==latest.from)){
        current.delays.push({from:message.delayFrom||0,delay:message.delayMs});
        if(current.delays.length>8)current.delays.shift();
      }
      message.chunks.forEach(function(chunk){
        current.received++;
        // Never feed the decoder out of order (it would garble the sound); drop the straggler.
        if(current.lastChunk!==undefined&&chunk.t<=current.lastChunk){current.outOfOrder++;return;}
        current.lastChunk=chunk.t;
        current.decoder.decode(new EncodedAudioChunk({type:'key',timestamp:chunk.t,data:decodeBase64(chunk.d)}));
      });
    };
  };
  var apply=function(next){
    state=next;
    if(state.mode==='live'&&state.live){stopFiles();startLive(state.live);if(live)live.gain.gain.value=volume();}
    else{stopLive();tick();}
  };
  var load=function(){
    fetch(cfg.stateUrl,{cache:'no-store'}).then(function(response){return response.ok?response.json():null;})
      .then(function(next){if(next)apply(next);}).catch(function(){});
  };
  if(window.CCSound)window.CCSound.onUnlock(function(){tick();});
  // For troubleshooting a screen from the browser console: how far it is from where it should be.
  window.ccAudioStatus=function(){
    var player=players[active];
    var at=state&&state.mode==='playing'&&state.startedAt!==null?position(state.tracks,state.startedAt,serverNow(),state.loop):null;
    return {mode:state?state.mode:null,track:currentTrack,playing:!player.paused,currentTime:player.currentTime,
      expected:at?at.offsetMs/1000:null,driftMs:at&&!player.paused?Math.round((player.currentTime-at.offsetMs/1000)*1000):null,
      live:live?{received:live.received,played:live.played,late:live.late,skipped:live.skipped,outOfOrder:live.outOfOrder,leadMs:live.lastLeadMs,delayMs:live.delays[live.delays.length-1].delay,
        audioRunning:Boolean(window.CCSound&&window.CCSound.context()&&window.CCSound.context().state==='running')}:null};
  };
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

/** Audio worklet used by the admin page to capture live sound in 40 ms blocks for encoding. */
export const captureWorkletSource = String.raw`class CompetitionCapture extends AudioWorkletProcessor{
  constructor(){super();this.size=960;this.left=new Float32Array(this.size);this.right=new Float32Array(this.size);this.filled=0;this.startFrame=0;this.out=null;
    var self=this;this.port.onmessage=function(event){if(event.data&&event.data.port)self.out=event.data.port;};}
  process(inputs){
    var input=inputs[0];
    if(!input||!input.length)return true;
    var left=input[0],right=input[1]||input[0];
    for(var index=0;index<left.length;index++){
      if(this.filled===0)this.startFrame=currentFrame+index;
      this.left[this.filled]=left[index];this.right[this.filled]=right[index];this.filled++;
      if(this.filled===this.size){
        (this.out||this.port).postMessage({frame:this.startFrame,left:this.left,right:this.right},[this.left.buffer,this.right.buffer]);
        this.left=new Float32Array(this.size);this.right=new Float32Array(this.size);this.filled=0;
      }
    }
    return true;
  }
}
registerProcessor('competition-capture',CompetitionCapture);`;

/**
 * Background worker for live-audio broadcasting: receives captured blocks straight from the
 * audio worklet, encodes them (Opus) and posts them to the server one request at a time. Nothing
 * runs on the admin page's main thread, so a busy page or background tab cannot stall the sound.
 * The page sends an anchor (audio-clock time ↔ server time) every couple of seconds.
 */
export const broadcastWorkerSource = String.raw`var session=null,anchor=null,sampleRate=48000,encoder=null,pending=[],sending=false,sent=0,failed=0,ended=false;
var toBase64=function(bytes){var binary='';for(var i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));return btoa(binary);};
var send=function(){
  if(sending||ended||!pending.length)return;
  sending=true;
  var chunks=pending.splice(0,100);
  fetch('/api/admin/audio-live/'+encodeURIComponent(session)+'/audio',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chunks:chunks}),credentials:'same-origin'})
    .then(function(response){
      if(response.status===404){ended=true;postMessage({type:'ended'});return;}
      if(response.ok)sent+=chunks.length;else failed+=chunks.length;
    })
    .catch(function(){failed+=chunks.length;})
    .then(function(){sending=false;send();});
};
var onBlock=function(block){
  if(!encoder||encoder.state!=='configured'||!anchor||ended)return;
  var serverAt=anchor.server+(block.frame/sampleRate-anchor.context)*1000;
  var planar=new Float32Array(block.left.length*2);
  planar.set(block.left,0);planar.set(block.right,block.left.length);
  var data=new AudioData({format:'f32-planar',sampleRate:sampleRate,numberOfFrames:block.left.length,numberOfChannels:2,timestamp:Math.round(serverAt*1000),data:planar});
  encoder.encode(data);
  data.close();
};
onmessage=function(event){
  var message=event.data;
  if(message.type==='start'){
    session=message.session;sampleRate=message.sampleRate;anchor=message.anchor;
    message.port.onmessage=function(blockEvent){onBlock(blockEvent.data);};
    encoder=new AudioEncoder({
      output:function(chunk){var bytes=new Uint8Array(chunk.byteLength);chunk.copyTo(bytes);pending.push({t:chunk.timestamp,d:toBase64(bytes)});send();},
      error:function(error){postMessage({type:'error',message:String(error&&error.message||error)});}
    });
    encoder.configure({codec:'opus',sampleRate:48000,numberOfChannels:2,bitrate:160000});
  }else if(message.type==='anchor'){
    anchor=message.anchor;
  }else if(message.type==='stats'){
    postMessage({type:'stats',sent:sent,failed:failed,queued:pending.length});
  }else if(message.type==='stop'){
    ended=true;try{encoder&&encoder.close();}catch(error){}
  }
};`;
