export async function inspectPage(page) {
  return page.locator('form,button,input,select,textarea,a').evaluateAll(elements=>{
    const selector=el=>{
      if(el.id)return '#'+CSS.escape(el.id);
      if(el.getAttribute('name')) {
        const value=el.tagName.toLowerCase()+'[name="'+CSS.escape(el.getAttribute('name'))+'"]';
        if(document.querySelectorAll(value).length===1)return value;
      }
      const parts=[];for(let node=el;node&&node!==document.body;node=node.parentElement){const siblings=[...node.parentElement.children].filter(e=>e.tagName===node.tagName);parts.unshift(node.tagName.toLowerCase()+':nth-of-type('+(siblings.indexOf(node)+1)+')');}
      return 'body > '+parts.join(' > ');
    };
    return {url:location.origin+location.pathname,elements:elements.filter(el=>el.getBoundingClientRect().width>0||el.type==='hidden').map(el=>({
      selector:selector(el),tag:el.tagName.toLowerCase(),name:el.getAttribute('name'),type:el.getAttribute('type'),
      label:el.matches('button,a')?el.textContent.trim().slice(0,160):undefined,
      request:el.matches('form')?{method:(el.getAttribute('method')||'GET').toUpperCase(),path:new URL(el.getAttribute('action')||location.href,location.href).pathname,query:Object.fromEntries(new URL(el.getAttribute('action')||location.href,location.href).searchParams),fields:[...el.elements].map(e=>({name:e.name,type:e.type})).filter(e=>e.name)}:undefined
    }))};
  });
}
