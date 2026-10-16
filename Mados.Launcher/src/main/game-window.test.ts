import {expect,it} from 'vitest';
import {GameWindowPolicy} from './game-window';
it('minimizes only for a real running client and restores once after that session',()=>{
 const policy=new GameWindowPolicy();const options={minimizeOnPlay:true,restoreAfterPlay:true};
 expect(policy.update('DownloadingClientUpdate',options)).toBe(null);
 expect(policy.update('ClientRunning',options)).toBe('minimize');expect(policy.update('ClientRunning',options)).toBe(null);
 expect(policy.update('ClientExited',options)).toBe('restore');expect(policy.update('ClientExited',options)).toBe(null);
 expect(policy.update('ConnectionFailed',options)).toBe(null);
});
it('honors both independent disabled options',()=>{const p=new GameWindowPolicy();expect(p.update('ClientRunning',{minimizeOnPlay:false,restoreAfterPlay:false})).toBe(null);expect(p.update('ClientExited',{minimizeOnPlay:false,restoreAfterPlay:false})).toBe(null);});
