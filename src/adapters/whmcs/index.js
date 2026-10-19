import {LearnedSiteAdapter} from '../learned/index.js';
export class WhmcsAdapter extends LearnedSiteAdapter {
  confirmationDefinition(){return {...this.site.invoice,idPattern:'^\\d+$'};}
  referenceField(){return 'invoiceId';}
  receiptLink(){return this.site.receipt?.invoiceLink;}
  availablePattern(){return this.site.stock.availablePattern||'^(\\d+)\\s+Available$';}
}
