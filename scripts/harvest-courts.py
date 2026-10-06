#!/usr/bin/env python3
"""Harvest official daily registry metadata; the Worker fetches and validates RTF itself.
No judgment texts or personal fields are saved in the repository or Actions cache.
"""
import argparse,csv,datetime,io,json,os,pathlib,time,urllib.request,urllib.error,zipfile,tempfile,re
parser=argparse.ArgumentParser()
parser.add_argument('--archive')
parser.add_argument('--since',default=(datetime.date.today()-datetime.timedelta(days=90)).isoformat())
parser.add_argument('--limit',type=int,default=1000)
parser.add_argument('--state',default='.court-harvest-state.json')
parser.add_argument('--dry-run',action='store_true')
args=parser.parse_args()
BASE=os.environ.get('WORKER_URL','https://crime-radar.w-siteee.workers.dev')
HEADERS={'User-Agent':'CrimeRadar/0.3 (+https://crime-radar.w-siteee.workers.dev)'}
def request_json(url):
 with urllib.request.urlopen(urllib.request.Request(url,headers=HEADERS),timeout=60) as response:return json.load(response)
def post(documents,withdrawn):
 payload=json.dumps({'documents':documents,'withdrawn':withdrawn}).encode()
 for attempt in range(3):
  try:
   request=urllib.request.Request(BASE+'/internal/court',data=payload,headers={**HEADERS,'Authorization':'Bearer '+harvest_token(),'Content-Type':'application/json'})
   with urllib.request.urlopen(request,timeout=90) as response:result=json.load(response)
   if result.get('skipped'):raise RuntimeError('Collector busy')
   return result
  except Exception as error:
   if isinstance(error,urllib.error.HTTPError) and error.code in (401,403):raise
   if attempt==2:raise
   time.sleep(5*2**attempt)
state_path=pathlib.Path(args.state)
state=json.loads(state_path.read_text()) if state_path.exists() else {}
secret=os.environ.get('INGESTION_SECRET')
ci_oidc=bool(os.environ.get('ACTIONS_ID_TOKEN_REQUEST_URL'))
if not args.dry_run and not secret and not ci_oidc:
 secret=pathlib.Path('.env.ingestion').read_text().strip()
ci_token=None
ci_token_time=0
def harvest_token():
 global ci_token,ci_token_time
 if not ci_oidc:return secret
 if not ci_token or time.time()-ci_token_time>180:
  url=os.environ['ACTIONS_ID_TOKEN_REQUEST_URL']+'&audience=crime-radar-ingestion'
  request=urllib.request.Request(url,headers={'Authorization':'Bearer '+os.environ['ACTIONS_ID_TOKEN_REQUEST_TOKEN']})
  with urllib.request.urlopen(request,timeout=30) as response:ci_token=json.load(response)['value']
  ci_token_time=time.time()
 return ci_token
if not args.archive:
 data=request_json('https://data.gov.ua/api/3/action/package_show?id=ediniy-derzhavniy-reestr-sudovih-rishen-za-2026-rik_7636')['result']
 url=next(r['url'] for r in data['resources'] if r['id']=='b1a4ac1c-b17a-4988-8e6d-dedae8b2dd63')
 if not url.startswith('https://data.gov.ua/') or not url.endswith('.zip'):raise RuntimeError('Unexpected official archive URL')
 temp=tempfile.NamedTemporaryFile(suffix='.zip')
 print('Downloading official daily registry archive',flush=True)
 with urllib.request.urlopen(urllib.request.Request(url,headers=HEADERS),timeout=120) as response:
  while chunk:=response.read(1024*1024):temp.write(chunk)
 temp.flush();archive=temp.name
else:archive=args.archive
with zipfile.ZipFile(archive) as z:
 def rows(name):return csv.DictReader(io.TextIOWrapper(z.open(name),encoding='utf-8-sig'),delimiter='\t')
 cats={row['category_code']:row['name'] for row in rows('cause_categories.csv')}
 # Only specific ordinary-crime categories, not whole chapter totals or military cases.
 pattern=re.compile(r'Крадіжка|Грабіж|Розбій|Шахрайство|Умисне вбивство|Умисне тяжке тілесне|Зґвалтування|Незаконне.*наркот|Незаконне поводження зі зброєю|Порушення правил безпеки дорожнього руху|Одержання.*неправомірної вигоди',re.I)
 chosen={code:name for code,name in cats.items() if pattern.search(name)}
 documents=[];withdrawn=[];total=0;active=set()
 for row in rows('documents.csv'):
  doc_id=row['doc_id']
  if row['status']=='0':
   if doc_id in state:withdrawn.append(doc_id)
   continue
  if row['justice_kind']!='2' or row['judgment_code']!='1' or row['category_code'] not in chosen:continue
  if row['date_publ'][:10]<args.since:continue
  total+=1;active.add(doc_id)
  signature='|'.join([row['doc_url'],row['date_publ'],row['category_code']])
  if state.get(doc_id)==signature:continue
  published=datetime.datetime.fromisoformat(row['date_publ'].replace(' ','T',1)).isoformat()
  documents.append(({'id':doc_id,'url':row['doc_url'],'publishedAt':published,'caseNumber':row['cause_num'],'category':chosen[row['category_code']]},signature))
 # Older known records absent from a refreshed archive are also withdrawn.
 # Restrict to explicit status=0: a shortened archive alone is not evidence of withdrawal.
 documents.sort(key=lambda entry:entry[0]['publishedAt'],reverse=True)
 print(json.dumps({'eligibleVerdicts':total,'newOrChanged':len(documents),'withdrawn':len(withdrawn),'limit':args.limit}),flush=True)
 if args.dry_run:raise SystemExit(0)
 def save():
  temp_state=state_path.with_suffix('.tmp');temp_state.write_text(json.dumps(state));temp_state.replace(state_path)
 for i in range(0,len(withdrawn),100):
  group=withdrawn[i:i+100];print(json.dumps(post([],group)),flush=True)
  for doc_id in group:state.pop(doc_id,None)
  save()
 failed=[];consecutive_failures=0
 for i in range(0,min(args.limit,len(documents)),3):
  batch=documents[i:min(i+3,args.limit)]
  completed=[]
  try:
   result=post([d for d,_ in batch],[])
   print(json.dumps({'batch':i//3+1,**result}),flush=True)
   completed=batch
  except Exception as error:
   if isinstance(error,urllib.error.HTTPError) and error.code in (401,403):raise
   # Isolate an unavailable document so a single source file cannot stop history imports.
   for doc,signature in batch:
    try:
     result=post([doc],[]);completed.append((doc,signature))
     print(json.dumps({'document':doc['id'],**result}),flush=True)
    except Exception as single_error:
     if isinstance(single_error,urllib.error.HTTPError) and single_error.code in (401,403):raise
     failed.append(doc['id'])
     print(json.dumps({'retryLater':doc['id'],'errorType':type(single_error).__name__}),flush=True)
  for doc,signature in completed:state[doc['id']]=signature
  save();time.sleep(1)
  consecutive_failures=0 if completed else consecutive_failures+1
  if consecutive_failures>=3:raise RuntimeError('Three consecutive batches unavailable; retained checkpoint for retry')
 # Reprocess stored originals when publication rules change, even without new documents.
 for _ in range(500):
  result=post([],[])
  if not result.get('result',{}).get('changed'):break
  print(json.dumps({'reprocess':result['result']}),flush=True)
 if failed:raise RuntimeError(f'{len(failed)} unavailable documents will retry on the next harvest')
 print('Court harvest complete',flush=True)
