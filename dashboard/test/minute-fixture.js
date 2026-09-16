// Test-only consistent binary fixture; not used for upstream submissions.
export function minuteFixture(total,stride=3){
 const bytes=new Uint8Array(1440*stride);
 for(let i=0;i<1440;i++){const n=Math.min(255,total);bytes[i*stride]=n?1:126;bytes[i*stride+2]=n;total-=n;}
 if(total)throw Error('fixture overflow');
 return Buffer.from(bytes).toString('base64');
}
