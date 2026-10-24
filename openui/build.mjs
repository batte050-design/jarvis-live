import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
process.chdir(dir);
// The SDK's opt-in telemetry is unnecessary here. Remove its implementation from both bundles,
// rather than relying on deployment environment flags. Fail closed if the pinned package changes.
const noTelemetry={name:'no-telemetry',setup(build){build.onLoad({filter:/@openuidev\/lang-core\/dist\/index\.mjs$/},async({path:file})=>{
  let source=fs.readFileSync(file,'utf8');const start=source.indexOf('//#region src/telemetry/runtime.ts'),end=source.indexOf('//#endregion',start);
  if(start<0||end<start)throw Error('Pinned telemetry boundary changed; inspect the SDK before building.');
  source=source.slice(0,start)+'function recordSystemPromptGeneration(){}\nfunction prepareParserParseTelemetry(){}\nfunction captureParserParseResult(){}\nfunction captureParserParseException(){}\n'+source.slice(end);
  return {contents:source,loader:'js'};
});}};
const common={bundle:true,logLevel:'warning',jsx:'automatic',plugins:[noTelemetry],define:{'process.env.NODE_ENV':'"production"'},legalComments:'linked'};
await esbuild.build({...common,entryPoints:['src/frame.tsx'],outfile:'../static/openui-frame.js',platform:'browser',format:'iife',minify:true,loader:{'.woff':'dataurl','.woff2':'dataurl','.ttf':'dataurl'},assetNames:'openui-fonts/[name]-[hash]'});
await esbuild.build({...common,entryPoints:['src/validate-cli.ts'],outfile:'validate.cjs',platform:'node',format:'cjs',minify:true,loader:{'.css':'empty'},external:['node:fs']});
const {execFileSync}=await import('node:child_process');
const prompt=execFileSync(process.execPath,['validate.cjs','--prompt'],{encoding:'utf8'});
fs.writeFileSync('system-prompt.txt',prompt);
console.log('Built local OpenUI renderer, validator and matching prompt.');
