export type GameWindowOptions={minimizeOnPlay:boolean;restoreAfterPlay:boolean};
export class GameWindowPolicy {
 private running=false;
 update(status:string,options:GameWindowOptions):'minimize'|'restore'|null {
  if(status==='ClientRunning'&&!this.running){this.running=true;return options.minimizeOnPlay?'minimize':null;}
  if(['ClientExited','Cancelled','ConnectionFailed','UpdateError','Error'].includes(status)&&this.running){this.running=false;return options.restoreAfterPlay?'restore':null;}
  return null;
 }
}
