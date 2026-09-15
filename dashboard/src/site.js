import {query} from './jobs.js';
export async function siteSettings(env) {
 const s=await query(env,'SELECT name,announcement,contact,registration_open,new_user_gift_days,revision,updated_at FROM site_settings WHERE id=1').first();
 return {...s,registration_open:!!s.registration_open};
}
export async function publicSite(env) {
 const {name,announcement,contact,registration_open,new_user_gift_days}=await siteSettings(env);
 return {name,announcement,contact,registration_open,new_user_gift_days};
}
