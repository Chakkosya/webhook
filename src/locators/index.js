import {Fault} from '../errors.js';
export class Locators {
  constructor(repository,{visual}={}){this.repository=repository;this.visual=visual;}
  async resolve(page,workflowId,step) {
    const ranked=this.repository.ranking(workflowId,step.id);
    const strategies=['selector',...(step.target.anchor&&this.visual?['visual']:[])];
    strategies.sort((a,b)=>{
      const score=s=>ranked.find(r=>r.strategy===s)?.rate;
      return (score(b)??-1)-(score(a)??-1);
    });
    let cause;
    for(const strategy of strategies) {
      try {
        let locator;
        if(strategy==='selector')locator=page.locator(step.target.selector);
        else {
          const point=await this.visual.locate(await page.screenshot(),step.target.anchor);
          if(!point)throw new Error('视觉锚点没有唯一匹配');
          const selector=await page.evaluate(({x,y})=>{
            for(const element of document.querySelectorAll('[data-workflow-anchor]'))element.removeAttribute('data-workflow-anchor');
            const el=document.elementFromPoint(x,y);if(!el)return null;
            const target=el.closest('button,input,select,textarea,a')||el;
            target.setAttribute('data-workflow-anchor','active');return '[data-workflow-anchor="active"]';
          },point);
          if(!selector)throw new Error('视觉坐标没有命中元素');locator=page.locator(selector);
        }
        if(await locator.count()!==1||!await locator.isVisible()||!await locator.isEnabled())throw new Error('定位元素不存在、不唯一或不可见');
        this.repository.locator(workflowId,step.id,strategy,true);
        return {locator,strategy};
      }catch(error){cause=error;this.repository.locator(workflowId,step.id,strategy,false);}
    }
    throw new Fault('LOCATOR','选择器与视觉锚点均未定位到目标',{cause,details:{selector:step.target.selector}});
  }
}
