import fs from 'node:fs';
import {validateProgram,formulaStates} from './guard';
import {library} from './library';
if(process.argv.includes('--schema'))process.stdout.write(JSON.stringify(library.toJSONSchema()));
else if(process.argv.includes('--prompt'))process.stdout.write(library.prompt()+'\n');
else{try{const {code,receipts=[],harnessAuthored=false}=JSON.parse(fs.readFileSync(0,'utf8'));const result=validateProgram(code,true,receipts,harnessAuthored===true);process.stdout.write(JSON.stringify({ok:true,canonicalCode:result.canonicalCode,formulaStates:formulaStates(result),states:result.stateDeclarations,components:Object.keys(library.components).length})+'\n');}
catch(e){process.stdout.write(JSON.stringify({ok:false,error:String(e instanceof Error?e.message:e)})+'\n');process.exitCode=1;}}
