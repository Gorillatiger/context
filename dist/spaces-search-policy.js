export function spacesSearchCourseURL(value){
  let u;try{u=new URL(value);}catch{}
  const slug=u?.pathname.match(/^\/([a-z0-9][a-z0-9-]{0,100})\/?$/)?.[1];
  if(typeof value!=='string'||value.length>300||!u||u.origin!=='https://spaces.th-koeln.de'||u.username||u.password||u.search||u.hash||!slug||['public','home','hilfe','app','wp-json','wp-admin'].includes(slug))throw new Error('Wähle einen verknüpften Spaces-Kurs mit eigener Startadresse.');
  return u.origin+'/'+slug+'/';
}
