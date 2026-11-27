import {execFileSync} from 'node:child_process';
import {readdir,readFile} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const repository=process.env.GITHUB_REPOSITORY;
if(!repository||!/^[-\w.]+\/[-\w.]+$/.test(repository))throw new Error('Set GITHUB_REPOSITORY to the intended owner/repository.');
const gh=process.env.GH_CLI_PATH||'gh';
const env={...process.env};delete env.GH_DEBUG;
const api=(path,method='GET',body)=>{
 const args=['api',path,'--method',method,'--hostname','github.com'];if(body)args.push('--input','-');
 const output=execFileSync(gh,args,{cwd:root,env,input:body?JSON.stringify(body):undefined,encoding:'utf8',stdio:['pipe','pipe','pipe'],maxBuffer:12000000});
 return output.trim()?JSON.parse(output):{};
};
const files=[];
async function add(path){const data=await readFile(path);files.push({path:relative(root,path).split('\\').join('/'),data});}
async function walk(path){for(const entry of await readdir(path,{withFileTypes:true})){const p=join(path,entry.name);if(entry.isSymbolicLink())throw new Error('Publish only ordinary source files.');if(entry.isDirectory())await walk(p);else if(entry.isFile())await add(p);}}
for(const dir of ['.github','public','core','server','worker','scripts','test'])await walk(resolve(root,dir));
for(const path of ['package.json','pnpm-lock.yaml','README.md','PRODUCT.md','.gitignore','wrangler.toml.example'])await add(resolve(root,path));
const configPath=resolve(process.env.TNS_WRANGLER_CONFIG||resolve(root,'wrangler.toml'));
const config=await readFile(configPath,'utf8');
if(/REPLACE_WITH_|YOUR-GITHUB-USERNAME/.test(config))throw new Error('Configure the actual Worker database ID and public origin before publishing.');
if(config.split('\n').some(line=>!line.trim().startsWith('#')&&/^\s*[\w-]*(?:token|password|secret)[\w-]*\s*=/i.test(line)))throw new Error('Use Cloudflare secrets instead of embedding a credential in wrangler.toml.');
files.push({path:'wrangler.toml',data:Buffer.from(config)});
if(process.argv.includes('--dry-run')){console.log(JSON.stringify({repository,files:files.map(f=>f.path)}));process.exit(0);}
const repo=api(`repos/${repository}`);if(!repo.permissions?.push)throw new Error('The signed-in GitHub account cannot publish to this repository.');
const branch=repo.default_branch||'main';const refPath=`repos/${repository}/git/ref/heads/${branch}`;
let head;
try{head=api(refPath);}catch(error){
 if(repo.size!==0||!/(HTTP 404|HTTP 409|Git Repository is empty)/.test(String(error.stderr)))throw error;
 const seed=files.find(f=>f.path==='.gitignore');api(`repos/${repository}/contents/.gitignore`,'PUT',{message:'Initialize the TNS application repository',content:seed.data.toString('base64')});head=api(refPath);
}
const parent=head.object.sha,base=api(`repos/${repository}/git/commits/${parent}`);
if(process.env.GITHUB_EXPECTED_HEAD && parent!==process.env.GITHUB_EXPECTED_HEAD)throw new Error('The source branch changed since this workspace was reviewed. Inspect the newer changes before publishing.');
const entries=[];
for(const file of files){
 if(/\.(png|ttf|woff2)$/.test(file.path)){const blob=api(`repos/${repository}/git/blobs`,'POST',{content:file.data.toString('base64'),encoding:'base64'});entries.push({path:file.path,mode:'100644',type:'blob',sha:blob.sha});}
 else entries.push({path:file.path,mode:'100644',type:'blob',content:file.data.toString('utf8')});
}
const tree=api(`repos/${repository}/git/trees`,'POST',{base_tree:base.tree.sha,tree:entries});
const commit=api(`repos/${repository}/git/commits`,'POST',{message:process.env.GITHUB_COMMIT_MESSAGE||'Build TNS team workspace and prepare production hosting',tree:tree.sha,parents:[parent]});
if(api(refPath).object.sha!==parent)throw new Error('The branch changed during preparation. Inspect the new changes before retrying.');
api(`repos/${repository}/git/refs/heads/${branch}`,'PATCH',{sha:commit.sha,force:false});
console.log(JSON.stringify({repository,branch,commit:commit.sha,url:commit.html_url,files:files.length}));
