import {z} from 'zod';
const address=z.string().max(2048).refine(value=>{try{const u=new URL(value);return ['ss14:','ss14s:'].includes(u.protocol)&&!!u.hostname&&!u.username&&!u.password&&!u.search&&!u.hash;}catch{return false}},'Нужен адрес SS14 без паролей и параметров').transform(value=>{const u=new URL(value);u.hostname=u.hostname.toLowerCase();if((u.protocol==='ss14:'&&u.port==='1212')||(u.protocol==='ss14s:'&&u.port==='443'))u.port='';return u.toString().replace(/\/+$/,'');});
const entry=z.object({address,name:z.string().trim().min(1).max(120)}).strict();
export const personalDataSchema=z.object({favorites:z.array(entry).max(2000),profiles:z.array(entry).max(500),notes:z.array(z.object({address,text:z.string().max(4000)}).strict()).max(2000)}).strict();
const block=z.enum(['lastServer','favorites','week','recent','quickActions','profiles']);
export const appearanceSchema=z.object({
 theme:z.enum(['mados','ocean','violet','emerald','amber']),reducedMotion:z.boolean(),sidebarCollapsed:z.boolean(),
 home:z.object({version:z.literal(1),order:z.array(block).max(6),hidden:z.array(block).max(6),pinned:z.array(address).max(4)}).strict(),
 favoriteLayout:z.object({version:z.literal(1),groups:z.array(z.object({id:z.string().regex(/^[a-zA-Z0-9-]{1,64}$/),name:z.string().min(1).max(32)}).strict()).max(12),entries:z.array(z.object({address,groupId:z.string().max(64)}).strict()).max(2000)}).strict(),
}).strict();
export const personalArchiveSchema=z.object({format:z.literal('mados-personal'),version:z.literal(1),createdAt:z.string().datetime(),data:personalDataSchema,appearance:appearanceSchema}).strict();
export type PersonalData=z.infer<typeof personalDataSchema>;
export type PersonalAppearance=z.infer<typeof appearanceSchema>;
export type PersonalArchive=z.infer<typeof personalArchiveSchema>;
export const personalSections=z.enum(['favorites','profiles','notes','appearance']);
export type PersonalSection=z.infer<typeof personalSections>;
export function previewPersonal(current:PersonalData,incoming:PersonalData){
 current=personalDataSchema.parse(current);incoming=personalDataSchema.parse(incoming);
 const count=(key:'favorites'|'profiles'|'notes')=>{const old=new Map(current[key].map(item=>[item.address,JSON.stringify(item)]));return {total:incoming[key].length,added:incoming[key].filter(item=>!old.has(item.address)).length,updated:incoming[key].filter(item=>old.has(item.address)&&old.get(item.address)!==JSON.stringify(item)).length};};
 return {favorites:count('favorites'),profiles:count('profiles'),notes:count('notes')};
}
