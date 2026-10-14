export function spaceBrowserURL(project){
  for(const link of project?.links||[]){
    if(link.tool!=='spaces')continue;
    try{
      const url=new URL(link.url);
      if(url.protocol!=='https:'||url.hostname!=='spaces.th-koeln.de'||url.port||url.username||url.password)continue;
      if(/(?:^|\/)wp-admin(?:\/|$)|(?:^|\/)wp-login\.php$/.test(url.pathname))continue;
      if([...url.searchParams.keys()].some(key=>!['page_id','paged','s'].includes(key)))continue;
      return url.href;
    }catch{}
  }
  return '';
}
