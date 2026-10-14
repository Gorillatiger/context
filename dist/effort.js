// Before a large task starts on the limited university model (KI:connect NRW), Context weighs
// the effort locally and lets the person choose: narrow it, switch to OpenRouter or try anyway.
// No model call is spent on this decision. Other providers are never interrupted.
// German verbs split (\"fasse … zusammen\"); JS \b does not see umlauts, so stems match without it.
const BROAD=/(?:zusammenfass|vergleich|überblick|übersicht|recherch|durchsuch|analysier|auswert|\bsammle|\bfass\w*\b[^.?!]{0,80}\bzusammen\b)/i;
const ALL=/\b(?:alle[nmrs]?|sämtliche[nmrs]?|komplett\w*|gesamte[nmrs]?|jede[nmrs]?|überall|alles)\b/i;

/** {score, reasons, recommend:'switch'|'narrow'} for a large task on KI:connect, otherwise null. */
export function assessEffort({prompt='',provider='',projectId='',courses=0,platforms=false,browser=false,history=0}={}){
  if(provider!=='kiconnect'||typeof prompt!=='string')return null;
  const text=prompt.trim(),all=ALL.test(text),
    // „dieses Board“, „hier“: the open page is the scope, however broad the verb.
    here=/\b(?:hier|diese[mnrs]?|offene[mnrs]?)\b/i.test(text)&&!all,broad=BROAD.test(text)&&!here,questions=(text.match(/\?/g)||[]).length,reasons=[];let score=0;
  if((broad||all)&&!projectId&&courses>1){score+=2;reasons.push(`alle ${courses} Kurse, kein Kurs gewählt`);}
  if(all){score+=1;reasons.push('„alle“ oder „gesamte“ im Auftrag');}
  if(broad){score+=1;reasons.push('Zusammenfassen, Vergleichen oder Durchsuchen');}
  if((broad||all)&&(platforms||browser)){score+=1;reasons.push('Suche über Spaces und Kursplattformen');}
  if(text.length>1500){score+=3;reasons.push('sehr langer Auftrag');}
  if(questions>=3){score+=2;reasons.push(`${questions} Fragen auf einmal`);}
  if(history>=16){score+=1;reasons.push('langer Chatverlauf');}
  return score>=3?{score,reasons:reasons.slice(0,4),recommend:score>=4?'switch':'narrow'}:null;
}
export const EFFORT_ACTIONS=Object.freeze({
  switch:'Zu OpenRouter wechseln und dort vollständig suchen',
  narrow:'Mit Hochschul-KI eingegrenzt starten (gewählter Kurs, neueste Quellen, kurze Antwort)',
  full:'Trotzdem vollständig mit Hochschul-KI versuchen',
});
export const NARROW_NOTE='\n\n(Bitte eingegrenzt arbeiten: nur der gewählte Kurs bzw. die passendste Quelle, neueste Stände zuerst, wenige Schritte, kurze Antwort. Wenn mehr nötig ist, frag mich mit Auswahl.)';
// An ask_user option that offers the switch is carried out, not just answered.
export const offersSwitch=option=>/\bOpenRouter\b/i.test(String(option||''))&&!/\b(?:nicht|kein|ohne)\b/i.test(String(option||''));
