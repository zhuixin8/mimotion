import {build} from 'esbuild';
await build({entryPoints:['src/avatar.js'],bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,legalComments:'inline',outfile:'dist/avatar.js.txt'});
await build({entryPoints:['src/worker.js'],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:'dist/worker.js',loader:{'.html':'text','.css':'text','.svg':'text'}});
