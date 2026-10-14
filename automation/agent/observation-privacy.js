const credentialKey=/^(?:password|passwd|credentials?|cookies?|cookieHeader|set-cookie|authorization|storageState)$/i;

// Apply at the AI boundary as well as before reducing a full observation.
export function redactAIInput(input){
  const secrets=new Set();
  const remember=value=>{if(typeof value==='string'&&value)secrets.add(value);};
  const collect=(value,privateValue=false)=>{
    if(typeof value==='string'){if(privateValue)remember(value);return;}
    if(!value||typeof value!=='object')return;
    if(String(value.type||'').toLowerCase()==='password'){remember(value.value);remember(value.rawValue);}
    for(const [key,child]of Object.entries(value))collect(child,privateValue||credentialKey.test(key));
  };
  collect(input);
  const ordered=[...secrets].sort((a,b)=>b.length-a.length);
  const clean=value=>{
    if(typeof value==='string')return ordered.reduce((text,secret)=>text.split(secret).join('[hidden]'),value);
    if(!value||typeof value!=='object')return value;
    if(Array.isArray(value))return value.map(clean);
    const password=String(value.type||'').toLowerCase()==='password';
    return Object.fromEntries(Object.entries(value).filter(([key])=>!credentialKey.test(key)&&!(password&&['value','rawValue','selectedValue'].includes(key))).map(([key,child])=>[key,clean(child)]));
  };
  return clean(input);
}
