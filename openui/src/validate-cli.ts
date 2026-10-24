import fs from 'node:fs';
import {validateProgram} from './guard';
import {library} from './library';
if(process.argv.includes('--schema'))process.stdout.write(JSON.stringify(library.toJSONSchema()));
else if(process.argv.includes('--prompt'))process.stdout.write(library.prompt()+'\n');
else{try{const {code,receipts=[]}=JSON.parse(fs.readFileSync(0,'utf8'));const result=validateProgram(code,true,receipts);process.stdout.write(JSON.stringify({ok:true,states:result.stateDeclarations,components:Object.keys(library.components).length})+'\n');}
catch(e){process.stdout.write(JSON.stringify({ok:false,error:String(e instanceof Error?e.message:e)})+'\n');process.exitCode=1;}}
