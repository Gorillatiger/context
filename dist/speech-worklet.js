/* Local PCM capture. No network, storage or transcription runs in this worklet. */
export class MonoResampler {
  constructor(inputRate,outputRate=16000,chunkSize=1536){
    if(!Number.isFinite(inputRate)||inputRate<8000||inputRate>192000||!Number.isFinite(outputRate)||outputRate<8000||outputRate>48000||!Number.isInteger(chunkSize)||chunkSize<128||chunkSize>8192)throw new Error('Invalid PCM configuration');
    this.ratio=inputRate/outputRate;this.chunkSize=chunkSize;this.chunk=new Float32Array(chunkSize);this.used=0;this.inputIndex=0;this.nextPosition=0;this.previous=0;
  }
  process(channels){
    if(!channels?.length||!channels[0]?.length)return [];
    const length=channels[0].length,chunks=[];
    for(let i=0;i<length;i++){
      let current=0;for(const channel of channels)current+=Number.isFinite(channel[i])?channel[i]:0;current=Math.max(-1,Math.min(1,current/channels.length));
      const index=this.inputIndex++;
      while(this.nextPosition<=index+1e-8){
        const value=index===0?current:this.previous+(current-this.previous)*(this.nextPosition-(index-1));
        this.chunk[this.used++]=Math.max(-1,Math.min(1,value));this.nextPosition+=this.ratio;
        if(this.used===this.chunkSize){chunks.push(this.chunk);this.chunk=new Float32Array(this.chunkSize);this.used=0;}
      }
      this.previous=current;
    }
    return chunks;
  }
  flush(){const tail=this.chunk.slice(0,this.used);this.chunk.fill(0);this.used=0;return tail;}
  clear(){this.chunk.fill(0);this.used=0;this.previous=0;}
}

if(typeof registerProcessor==='function'){
  class ContextSpeechCapture extends AudioWorkletProcessor {
    constructor(options){super();this.resampler=new MonoResampler(sampleRate,16000,options.processorOptions?.chunkSize||1536);this.active=true;
      this.port.onmessage=({data})=>{
        if(data?.type==='flush'){const samples=this.resampler.flush();if(samples.length)this.port.postMessage({type:'audio',samples},[samples.buffer]);this.active=false;this.port.postMessage({type:'flushed'});}
        if(data?.type==='cancel'){this.active=false;this.resampler.clear();this.port.postMessage({type:'flushed'});}
      };
    }
    process(inputs,outputs){for(const output of outputs)for(const channel of output)channel.fill(0);if(!this.active)return false;
      for(const samples of this.resampler.process(inputs[0]))this.port.postMessage({type:'audio',samples},[samples.buffer]);return true;
    }
  }
  registerProcessor('context-speech-capture',ContextSpeechCapture);
}
