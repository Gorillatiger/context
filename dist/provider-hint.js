// When the university service cannot take a request, point to the providers
// that can. Nothing is switched automatically: course content would leave for
// another service, so the person decides.
const SWITCHABLE=new Set(['conversation_limit','body_limit','request_limit','response_limit','timeout','provider_limit','local_limit']);
const SWITCHABLE_TEXT=/Höchstens (?:24 Nachrichten|zehn KI-Anfragen)|Der Chat ist zu lang|Die Anfrage ist zu groß|Die KI-Antwort war zu groß|Die KI hat zu lange gebraucht|-Limit ist erreicht|Schrittgrenze erreicht|Kontextbudget ist erreicht|zu lang für den Projektkontext/;
export const SWITCH_TARGETS=Object.freeze(['openrouter','local']);

export function providerSwitchHint(provider,error){
  if(provider!=='kiconnect'||!error||error.name==='AbortError')return null;
  const known=typeof error.code==='string'&&SWITCHABLE.has(error.code);
  if(!known&&!SWITCHABLE_TEXT.test(String(error.message||'')))return null;
  return {providers:[...SWITCH_TARGETS]};
}
