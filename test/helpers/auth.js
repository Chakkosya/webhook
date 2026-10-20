export async function loginPage(page,app){
 const base='http://127.0.0.1:'+app.server.address().port;
 const response=await page.request.post(base+'/api/auth/setup',{data:{email:'owner@example.test',password:'fixture-owner-password'}});
 if(response.status()!==201)throw new Error(await response.text());
}
