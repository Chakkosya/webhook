// Read the displayed selection separately from the merchant's submitted value.
export function inspectCommerceField(el){
  const text=(el.innerText||'').trim(),rawValue='value' in el?String(el.value):undefined;
  const label=(el.getAttribute('aria-label')||(el.getAttribute('aria-labelledby')||'').split(/\s+/).map(id=>document.getElementById(id)?.textContent||'').join(' ').trim()||[...(el.labels||[])].map(label=>label.textContent).join(' ')).replace(/\s+/g,' ').trim();
  const value=el.tagName==='SELECT'?[...el.selectedOptions].map(option=>option.textContent.trim()).join(' ')
    :['radio','checkbox'].includes(el.type)?el.checked?label:'':['INPUT','TEXTAREA'].includes(el.tagName)?rawValue:undefined;
  return {tag:el.tagName.toLowerCase(),type:el.type,checked:el.checked,value,rawValue,text,
    selectedValue:el.tagName==='SELECT'?rawValue:undefined,name:el.name,form:!!el.form,disabled:el.disabled,
    privateField:el.type==='password'||/token|secret|csrf|session|card|cvv|cvc/i.test(el.name+' '+el.id)};
}

// Runs in the merchant page; strip executable content and private field values.
export function inspectCommercePage(input){
  const {observationId,assignRefs=true}=typeof input==='string'?{observationId:input}:input;
  const readable=el=>(el.innerText||el.textContent||'').replace(/\s+/g,' ').trim();
  const labelText=el=>{const clone=el.cloneNode(true);clone.querySelectorAll('input,select,textarea,button').forEach(node=>node.remove());return readable(clone);};
  const visible=el=>!!el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden';
  const role=el=>el.getAttribute('role')||({BUTTON:'button',A:'link',SELECT:'combobox',TEXTAREA:'textbox',H1:'heading',H2:'heading',H3:'heading'}[el.tagName])||(el.tagName==='INPUT'?({checkbox:'checkbox',radio:'radio',submit:'button',button:'button',number:'spinbutton'}[el.type]||'textbox'):null);
  const headingSelector='h1,h2,h3,h4,h5,h6,[role="heading"]',actionSelector='a[href],button,input[type="submit"],input[type="button"],[role="button"]';
  const semanticSelector='article,li,tr,[role="listitem"]',regions=new Map(),actionCache=new WeakMap(),regionCache=new WeakMap(),textCache=new WeakMap();
  const actionsIn=el=>{if(!actionCache.has(el))actionCache.set(el,[...el.querySelectorAll(actionSelector)]);return actionCache.get(el);};
  const regionText=el=>{if(!textCache.has(el))textCache.set(el,readable(el));return textCache.get(el);};
  for(const container of document.querySelectorAll(semanticSelector)){
    if(!actionsIn(container).length)continue;
    const content=[container,...container.querySelectorAll('p,span,td,dt,dd,strong')].some(node=>!node.closest(actionSelector)&&[...node.childNodes].some(child=>child.nodeType===3&&child.textContent.trim()));
    if(container.querySelector(headingSelector)||content)regions.set(container,'r'+regions.size);
  }
  for(const heading of document.querySelectorAll(headingSelector)){
    if(regions.has(heading.closest(semanticSelector)))continue;
    for(let parent=heading.parentElement;parent&&!['BODY','HTML'].includes(parent.tagName);parent=parent.parentElement){
      if(!actionsIn(parent).some(action=>!heading.contains(action)))continue;
      if(!regions.has(parent))regions.set(parent,'r'+regions.size);
      break;
    }
  }
  const regionFor=el=>{
    if(regionCache.has(el))return regionCache.get(el);
    const visited=[];let region=null;
    for(let parent=el;parent&&!['BODY','HTML'].includes(parent.tagName);parent=parent.parentElement){
      if(regionCache.has(parent)){region=regionCache.get(parent);break;}
      visited.push(parent);if(regions.has(parent)){region=parent;break;}
    }
    for(const node of visited)regionCache.set(node,region);return region;
  };
  const summaries=new WeakMap();
  const contextText=el=>{
    const region=regionFor(el);
    if(region){
      if(!summaries.has(region)){
        const headings=[...region.querySelectorAll(headingSelector)].filter(node=>regionFor(node)===region).map(readable).join(' ').slice(0,300),text=regionText(region);
        const summary=text.length<=1200?text:headings+' '+text.slice(0,780-headings.length)+' … '+text.slice(-400);
        summaries.set(region,summary);
      }
      return summaries.get(region);
    }
    const own=readable(el);
    for(let parent=el.parentElement;parent&&!['BODY','HTML'].includes(parent.tagName);parent=parent.parentElement){
      const text=regionText(parent);if(text&&text!==own)return text.slice(0,1200);
    }
    return '';
  };
  // Every semantic node can provide a purchase action or a verification field.
  // Bound large text/HTML fields, rather than dropping later controls.
  const nodes=[...document.querySelectorAll('a,button,input,select,textarea,label,form,[role],[aria-label],h1,h2,h3,h4,h5,h6,p,span,td,th,dt,dd,strong,output,div,li,b,em,small')].filter(el=>
    !el.matches('div,li,b,em,small')||el.hasAttribute('role')||el.hasAttribute('aria-label')||
    [...el.childNodes].some(node=>node.nodeType===3&&node.textContent.trim()));
  const refs=new Map(nodes.map((el,index)=>[el,'e'+index]));
  if(assignRefs)for(const el of document.querySelectorAll('[data-agent-ref]'))el.removeAttribute('data-agent-ref');
  const elements=nodes.map(el=>{
    const ref=refs.get(el);if(assignRefs)el.setAttribute('data-agent-ref',observationId+':'+ref);
    const labelled=(el.getAttribute('aria-labelledby')||'').split(/\s+/).map(id=>document.getElementById(id)).filter(Boolean).map(readable).join(' ');
    const label=[...(el.labels||[])].map(labelText).join(' ');
    const privateField=el.tagName==='INPUT'&&(el.type==='password'||el.type==='hidden'||/token|secret|csrf|session|email|address|card|cvv|cvc/i.test(el.name+' '+el.id));
    const text=el.tagName==='INPUT'?(el.type==='submit'||el.type==='button'?el.value:''):readable(el).slice(0,300);
    const accessibleName=(el.getAttribute('aria-label')||labelled||label||text||el.getAttribute('alt')||el.getAttribute('title')||'').slice(0,300);
    return {ref,tag:el.tagName.toLowerCase(),role:role(el),accessibleName,text,regionRef:regions.get(regionFor(el)),contextText:contextText(el),label:label.slice(0,300),placeholder:el.getAttribute('placeholder'),name:el.getAttribute('name'),id:el.id||null,
      type:el.getAttribute('type'),visible:visible(el),disabled:!!el.disabled,readOnly:!!el.readOnly,required:!!el.required,checked:['checkbox','radio'].includes(el.type)?el.checked:undefined,
      value:privateField?undefined:el.tagName==='SELECT'?[...el.selectedOptions].map(o=>o.textContent.trim()).join(' '):['INPUT','TEXTAREA'].includes(el.tagName)?el.value:undefined,
      href:el.tagName==='A'?el.getAttribute('href'):undefined,formRef:refs.get(el.form),parentRef:refs.get(el.parentElement),
      options:el.tagName==='SELECT'?[...el.options].map(o=>({value:o.value,text:o.textContent.trim(),selected:o.selected,disabled:o.disabled})):undefined};
  });
  const clone=document.documentElement.cloneNode(true);
  clone.querySelectorAll('script,style,noscript,iframe').forEach(el=>el.remove());
  clone.querySelectorAll('*').forEach(el=>{for(const attr of [...el.attributes])if(/^on/i.test(attr.name)||/value|token|nonce|secret|password|csrf/i.test(attr.name))el.removeAttribute(attr.name);if(el.tagName==='TEXTAREA')el.textContent='[hidden]';});
  const forms=[...document.forms].map(form=>({ref:refs.get(form),method:form.method,action:form.getAttribute('action'),fields:elements.filter(el=>el.formRef===refs.get(form)).map(el=>el.ref)}));
  const allTreeNodes=[document.documentElement,...document.documentElement.querySelectorAll('*')].filter(el=>!['SCRIPT','STYLE','NOSCRIPT'].includes(el.tagName));
  const includedTreeNodes=new Set(allTreeNodes.slice(0,1200));
  // Preserve the hierarchy of every observed control, even after the outline limit.
  for(const node of nodes)for(let parent=node;parent&&!includedTreeNodes.has(parent);parent=parent.parentElement)includedTreeNodes.add(parent);
  const treeNodes=allTreeNodes.filter(el=>includedTreeNodes.has(el)),treeRefs=new Map(treeNodes.map((el,index)=>[el,'n'+index]));
  const text=document.body.innerText||'',html=clone.outerHTML;
  return {observationId,url:location.href,title:document.title,text:text.slice(0,24000),html:html.slice(0,64000),
    totalElements:nodes.length,totalDomNodes:allTreeNodes.length,
    truncated:{elements:false,forms:false,text:text.length>24000,html:html.length>64000,domTree:treeNodes.length<allTreeNodes.length},
    domTree:treeNodes.map(el=>({node:treeRefs.get(el),parent:treeRefs.get(el.parentElement),elementRef:refs.get(el),tag:el.tagName.toLowerCase(),role:role(el)})),elements,forms};
}
