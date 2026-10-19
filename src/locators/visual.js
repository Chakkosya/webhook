import {readFile,mkdir} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {fail} from '../errors.js';
export class VisualAnchors {
  constructor(page,assetDir){this.page=page;this.assetDir=assetDir;}
  async capture(selector,name) {
    await mkdir(this.assetDir,{recursive:true});
    const target=this.page.locator(selector);
    if(await target.count()!==1)fail('LOCATOR','视觉锚点需要唯一元素');
    const bounds=await target.boundingBox();if(!bounds)fail('LOCATOR','元素不可见');
    const filename=name+'.png';await target.screenshot({path:join(this.assetDir,filename)});
    return {file:filename,search:{x:Math.max(0,Math.floor(bounds.x-200)),y:Math.max(0,Math.floor(bounds.y-200)),width:Math.ceil(bounds.width+400),height:Math.ceil(bounds.height+400)},minSimilarity:0.985};
  }
  async locate(screenshot,anchor) {
    const file=resolve(this.assetDir,anchor.file),rel=relative(resolve(this.assetDir),file);
    if(rel.startsWith('..')||isAbsolute(rel))fail('LOCATOR','视觉锚点必须位于资源目录');
    const reference=await readFile(file);
    return this.page.evaluate(async({screen,reference,anchor})=>{
      const decode=async b64=>{
        const bytes=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));
        const image=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
        const canvas=new OffscreenCanvas(image.width,image.height),ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(image,0,0);
        return {width:image.width,height:image.height,pixels:ctx.getImageData(0,0,image.width,image.height).data};
      };
      const [s,a]=await Promise.all([decode(screen),decode(reference)]);
      const region=anchor.search||{x:0,y:0,width:s.width,height:s.height};
      const points=[];const stride=Math.max(1,Math.floor(Math.sqrt(a.width*a.height/144)));
      for(let y=0;y<a.height;y+=stride)for(let x=0;x<a.width;x+=stride)points.push({x,y,i:(y*a.width+x)*4});
      const candidates=[];
      for(let y=Math.max(0,region.y);y<=Math.min(s.height-a.height,region.y+region.height-a.height);y++)
        for(let x=Math.max(0,region.x);x<=Math.min(s.width-a.width,region.x+region.width-a.width);x++) {
          let difference=0;
          for(const p of points) {const i=((y+p.y)*s.width+x+p.x)*4;difference+=Math.abs(s.pixels[i]-a.pixels[p.i])+Math.abs(s.pixels[i+1]-a.pixels[p.i+1])+Math.abs(s.pixels[i+2]-a.pixels[p.i+2]);}
          const similarity=1-difference/(points.length*765);
          if(similarity>=(anchor.minSimilarity||0.985))candidates.push({x,y,similarity});
        }
      candidates.sort((x,y)=>y.similarity-x.similarity);const best=candidates[0];if(!best)return null;
      const ambiguous=candidates.some(c=>(Math.abs(c.x-best.x)>a.width/2||Math.abs(c.y-best.y)>a.height/2)&&c.similarity>=best.similarity-0.003);
      return ambiguous?null:{x:best.x+a.width/2,y:best.y+a.height/2};
    },{screen:screenshot.toString('base64'),reference:reference.toString('base64'),anchor});
  }
}
