// Voice exchanges remain in RAM unless explicitly opted into the chat archive.
// Also exclude later turns derived from an ephemeral voice exchange.
export function speechArchiveFields({messages=[],draft='',steps=[],attachments=[],voiceDraft=false,privateSpeechSession=false,busy=false}={}){
  return {messages:messages.filter(message=>message.ephemeral!==true),draft:voiceDraft||privateSpeechSession?'':draft,steps:privateSpeechSession&&busy?[]:steps,attachments:voiceDraft||privateSpeechSession?[]:attachments};
}
export function acceptSpeechFinal({event,contextKey,currentKey,seen,maxLength=6000,draft='',privateDraft=false}){
  if(!event||typeof event.id!=='string'||seen.has(event.id)||contextKey!==currentKey||typeof event.text!=='string')return null;
  seen.add(event.id);if(seen.size>64)seen.delete(seen.values().next().value);
  const text=event.text.trim();if(!text)return null;
  const combined=[draft.trimEnd(),text].filter(Boolean).join('\n');
  // Never truncate an instruction and accidentally auto-send a different request.
  return {draft:combined,tooLong:combined.length>maxLength,autoSend:event.autoSend===true&&combined.length<=maxLength,saveTranscript:event.saveTranscript===true&&!privateDraft};
}
