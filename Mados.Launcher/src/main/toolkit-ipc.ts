import {dialog,type BrowserWindow} from 'electron';
import {writeFile,rename,stat,realpath,mkdir,open,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {personalArchiveSchema,personalDataSchema,previewPersonal,type PersonalArchive,type PersonalAppearance,type PersonalSection} from '../contracts/personal-archive';
type Worker={invoke<T=unknown>(method:string,params?:unknown):Promise<T>};
type Snapshot={accountId:string;data:ReturnType<typeof personalDataSchema.parse>};
export class ToolkitIpc {
 private folders=new Set<string>();private archives=new Map<string,string>();
 private preview:{id:string;account:string;archive:PersonalArchive;expires:number}|null=null;
 private restoring=false;
 constructor(private worker:Worker,private window:()=>BrowserWindow|undefined,private dataPath:string){}
 private async account(){const state=await this.worker.invoke<{activeAccount?:{id:string}}>('app.getState',{});if(!state.activeAccount)throw Error('Войдите в аккаунт.');return state.activeAccount.id;}
 private recoveryPath(account:string){return join(this.dataPath,'personal-recovery-'+createHash('sha256').update(account).digest('hex')+'.mados-backup');}
 private async snapshot(){const snapshot=await this.worker.invoke<Snapshot>('personal.snapshot',{});return {...snapshot,data:personalDataSchema.parse(snapshot.data)};}
 private async readArchive(path:string){const file=await open(path,'r');try{const data=Buffer.alloc(4*1024*1024+1);let count=0;while(count<data.length){const part=await file.read(data,count,data.length-count,null);if(!part.bytesRead)break;count+=part.bytesRead;}if(count>4*1024*1024)throw Error('Архив превышает 4 МБ.');return personalArchiveSchema.parse(JSON.parse(data.subarray(0,count).toString('utf8')));}finally{await file.close();}}
 private async save(path:string,archive:PersonalArchive){const text=JSON.stringify(personalArchiveSchema.parse(archive),null,2);if(Buffer.byteLength(text,'utf8')>4*1024*1024)throw Error('Личная копия превышает 4 МБ. Сократите длинные заметки перед экспортом или восстановлением.');const temp=path+'.'+randomUUID()+'.tmp';try{await writeFile(temp,text,{flag:'wx'});await rename(temp,path);}finally{try{await unlink(temp)}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')console.error('[mados] Backup temporary file cleanup failed');}}}
 async addDroppedReplay(path:string){const account=await this.account();const safe=await realpath(path);if(!/\.zip$/i.test(safe)||!(await stat(safe)).isFile())throw Error('Выберите ZIP-файл.');return this.worker.invoke('replays.add',{path:safe,expectedAccountId:account});}
 async handle(method:string,params:Record<string,unknown>):Promise<{handled:boolean;result?:unknown}>{
  if(!['cache.chooseFolder','cache.move','replays.chooseFile','replays.add','personal.export','personal.inspect','personal.restore','personal.recovery'].includes(method))return {handled:false};
  const owner=this.window();if(!owner||owner.isDestroyed())throw Error('Окно недоступно.');
  if(method==='cache.chooseFolder'){const chosen=await dialog.showOpenDialog(owner,{title:'Куда перенести игровой кэш?',properties:['openDirectory','createDirectory']});if(chosen.canceled)return{handled:true,result:null};const folder=await realpath(chosen.filePaths[0]);this.folders.clear();this.folders.add(folder);return{handled:true,result:folder};}
  if(method==='cache.move'){const folder=resolve(params.folder as string);if(!this.folders.delete(folder))throw Error('Выберите папку через кнопку лаунчера.');return{handled:true,result:await this.worker.invoke(method,{folder})};}
  if(method==='replays.chooseFile'){const account=await this.account();const chosen=await dialog.showOpenDialog(owner,{title:'Добавить реплей или бандл SS14',properties:['openFile'],filters:[{name:'SS14 ZIP',extensions:['zip']}]});if(chosen.canceled)return{handled:true,result:null};const path=await realpath(chosen.filePaths[0]);this.archives.clear();this.archives.set(path,account);return{handled:true,result:path};}
  if(method==='replays.add'){const path=resolve(params.path as string);const account=this.archives.get(path);this.archives.delete(path);if(!account)throw Error('Выберите ZIP через кнопку лаунчера или перетащите файл.');return{handled:true,result:await this.worker.invoke(method,{path,expectedAccountId:account})};}
  if(method==='personal.export'){
   const before=await this.snapshot();const target=await dialog.showSaveDialog(owner,{title:'Сохранить «Мой Mados»',defaultPath:'My-Mados.mados-backup',filters:[{name:'Mados backup',extensions:['mados-backup']}]});if(target.canceled||!target.filePath)return{handled:true,result:{saved:false}};
   const current=await this.snapshot();if(current.accountId!==before.accountId)throw Error('Аккаунт изменился. Повторите экспорт.');
   await this.save(target.filePath,{format:'mados-personal',version:1,createdAt:new Date().toISOString(),data:current.data,appearance:params.appearance as PersonalAppearance});return{handled:true,result:{saved:true}};
  }
  if(method==='personal.inspect'){
   const before=await this.snapshot();const picked=await dialog.showOpenDialog(owner,{title:'Восстановить «Мой Mados»',properties:['openFile'],filters:[{name:'Mados backup',extensions:['mados-backup','json']}]});if(picked.canceled)return{handled:true,result:null};
   const path=picked.filePaths[0];if((await stat(path)).size>4*1024*1024)throw Error('Архив превышает 4 МБ.');let archive:PersonalArchive;try{archive=await this.readArchive(path);}catch{throw Error('Этот файл не является поддерживаемой копией Mados.');}
   const current=await this.snapshot();if(before.accountId!==current.accountId)throw Error('Аккаунт изменился. Откройте архив заново.');this.preview={id:randomUUID(),account:current.accountId,archive,expires:Date.now()+10*60*1000};
   return{handled:true,result:{id:this.preview.id,createdAt:archive.createdAt,sections:previewPersonal(current.data,archive.data),theme:archive.appearance.theme}};
  }
  if(method==='personal.restore'){
   if(this.restoring)throw Error('Восстановление уже выполняется.');const preview=this.preview;if(!preview||preview.id!==params.id||Date.now()>preview.expires)throw Error('Предпросмотр устарел. Откройте архив заново.');
   this.restoring=true;try{
    const current=await this.snapshot();if(current.accountId!==preview.account)throw Error('Аккаунт изменился. Откройте архив заново.');
    await mkdir(this.dataPath,{recursive:true});await this.save(this.recoveryPath(current.accountId),{format:'mados-personal',version:1,createdAt:new Date().toISOString(),data:current.data,appearance:params.appearance as PersonalAppearance});
    const sections=params.sections as PersonalSection[];await this.worker.invoke('personal.apply',{expectedAccountId:preview.account,data:preview.archive.data,sections:sections.filter(s=>s!=='appearance')});this.preview=null;
    return{handled:true,result:{ok:true,appearance:sections.includes('appearance')?preview.archive.appearance:null}};
   }finally{this.restoring=false;}
  }
  const recovery=this.recoveryPath(await this.account());let archive:PersonalArchive;try{archive=await this.readArchive(recovery);}catch{throw Error('Копии перед восстановлением пока нет.');}
  const target=await dialog.showSaveDialog(owner,{title:'Сохранить копию до восстановления',defaultPath:'My-Mados-before-restore.mados-backup',filters:[{name:'Mados backup',extensions:['mados-backup']}]});if(target.canceled||!target.filePath)return{handled:true,result:{saved:false}};await this.save(target.filePath,archive);return{handled:true,result:{saved:true}};
 }
}
