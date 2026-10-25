"""Open Intelligent UI primitive port, compiled into the existing application contract.

Layout vocabulary/semantics adapted from thesysdev/open-intelligent-ui@0321343,
src/lib/components/{layout,text,controls,extra}.tsx. MIT; see vendor attribution.
No Lang interpreter, generated code, network provider or second state store.
"""
import copy
import datetime
import hashlib
import json
import math
import re


def schema(value, rule, defs):
    if '$ref' in rule:
        return schema(value, defs[rule['$ref'].split('/')[-1]], defs)
    if 'oneOf' in rule:
        matches = 0
        for alternative in rule['oneOf']:
            try: schema(value, alternative, defs); matches += 1
            except ValueError: pass
        if matches != 1: raise ValueError('composition schema alternative')
        return
    kinds = rule.get('type', [])
    if isinstance(kinds, str): kinds = [kinds]
    types = {'object':type(value) is dict, 'array':type(value) is list, 'string':type(value) is str,
             'boolean':type(value) is bool, 'number':type(value) in (int,float) and math.isfinite(value),
             'integer':type(value) in (int,float) and math.isfinite(value) and int(value) == value}
    if kinds and not any(types.get(k,False) for k in kinds): raise ValueError('composition schema type')
    if 'enum' in rule and value not in rule['enum']: raise ValueError('composition enum')
    if isinstance(value,str):
        length = len(value.encode('utf-16-le')) // 2
        if not rule.get('minLength',0) <= length <= rule.get('maxLength',10**6): raise ValueError('composition text budget')
        if 'pattern' in rule and not re.search(rule['pattern'],value): raise ValueError('composition identifier')
    if type(value) in (int,float):
        if not math.isfinite(value) or not rule.get('minimum',-10**15) <= value <= rule.get('maximum',10**15): raise ValueError('composition number')
    if isinstance(value,list):
        if not rule.get('minItems',0) <= len(value) <= rule.get('maxItems',512): raise ValueError('composition array budget')
        for item in value: schema(item,rule.get('items',{}),defs)
    if isinstance(value,dict):
        if any(k in ('__proto__','constructor','prototype') for k in value): raise ValueError('composition reserved key')
        if any(k not in value for k in rule.get('required',[])): raise ValueError('composition missing property')
        for key,item in value.items():
            child = rule.get('properties',{}).get(key)
            if child is None:
                if rule.get('additionalProperties') is False: raise ValueError('composition unknown property')
                child = rule.get('additionalProperties',{})
            if isinstance(child,dict): schema(item,child,defs)


def definition(manifest):
    """Use the same canonical schema as the browser, including optional/union fields."""
    props = manifest['schema']['properties']
    return {'component':'application', 'description':
            'Compose an answer from Open Intelligent UI primitives, not a fixed template. '
            'Use Col/Row/Grid/Card/Carousel/Popover/Form/Timeline and typed Input/Slider/Select, '
            'Title/Text/Caption/Badge, Output and Button. First layout node is the root; children '
            'are node IDs. Input bind is its input ID, Output bind is a zero-based output index, '
            'Button bind is an existing LOCAL action ID. Every input/output/action must appear '
            'exactly once. Empty text/bind/children where unused; gap counts 4px, columns 1..3. '
            'Inputs must affect shown outputs. Money inputs/graph use minor units (UGX 1, USD 100); '
            'numeric defaults must come from the user, never invent facts or prices. '
            'Use the existing forward-only graph for live calculations. For a chart first retrieve '
            'a receipt, and use emit_chart; compose qualitative answers freely without numbers. '
            'No HTML, arbitrary styles, URL, event handlers, eval, or new tool calls.',
            'parameters':{'type':'object','additionalProperties':False,
                'required':['title','currency','inputs','graph','outputs','actions','layout','fallback'],
                'properties':{'title':{'type':'string','minLength':1,'maxLength':80},
                    'currency':copy.deepcopy(props['props']['properties']['currency']),
                    **{k:copy.deepcopy(props[k]) for k in ('inputs','graph','outputs','layout','fallback')},
                    'actions':{'type':'array','maxItems':16,'items':copy.deepcopy(manifest['schema']['$defs']['action']['oneOf'][0])}},
                '$defs':copy.deepcopy(manifest['schema']['$defs'])}}


def check_layout(spec, manifest):
    nodes = spec.get('layout')
    if nodes is None: return
    library = manifest['primitives']; by_id = {n['id']:n for n in nodes}
    if len(by_id) != len(nodes): raise ValueError('duplicate layout node')
    seen = set(); ins = set(); outs = set(); actions = set()
    inputs = {i['id']:i for i in spec['inputs']}
    action_ids = {a['id'] for a in spec.get('actions',[])}
    def visit(key,depth):
        if key not in by_id or key in seen or depth > library['maxDepth']: raise ValueError('layout cycle, shared child or depth')
        seen.add(key); n = by_id[key]; kind = n['kind']; bind = n['bind']
        if kind in library['containers']:
            if bind: raise ValueError('container binding')
            for child in n['children']: visit(child,depth+1)
        elif n['children']: raise ValueError('leaf children')
        if kind in ('Input','Slider','Select','Checkbox','TextArea','DatePicker'):
            if bind not in inputs or bind in ins: raise ValueError('layout input binding')
            allowed = {'Input':('number','stepper','text'),'Slider':('range',),'Select':('select',),
                       'Checkbox':('toggle',),'TextArea':('text',),'DatePicker':('date',)}[kind]
            if inputs[bind]['kind'] not in allowed: raise ValueError('layout input type')
            ins.add(bind)
        elif kind == 'Output':
            if not re.fullmatch(r'0|[1-9][0-9]*',bind) or int(bind) >= len(spec['outputs']) or bind in outs: raise ValueError('layout output binding')
            outs.add(bind)
        elif kind == 'Button':
            if bind not in action_ids or bind in actions: raise ValueError('layout action binding')
            actions.add(bind)
        elif kind not in library['containers'] and bind: raise ValueError('unused layout binding')
    if nodes[0]['kind'] not in library['containers']: raise ValueError('layout root container')
    visit(nodes[0]['id'],1)
    if len(seen) != len(nodes) or ins != set(inputs) or outs != {str(i) for i in range(len(spec['outputs']))} or actions != action_ids:
        raise ValueError('layout must display every declaration exactly once')
    # A visible control must influence a visible output, possibly through derived values.
    dependencies = {i:{i} for i in inputs}
    for g in spec['graph']:
        dependencies[g['id']] = set().union(*(dependencies.get(v.get('ref'),set()) for v in g['args'] if isinstance(v,dict)))
    used = set()
    def refs(value):
        if isinstance(value,dict):
            if 'ref' in value: used.update(dependencies.get(value['ref'],set()))
            if value.get('kind') == 'quiz': used.add(value.get('input'))
            for v in value.values(): refs(v)
        elif isinstance(value,list):
            for v in value: refs(v)
    refs(spec['outputs'])
    if set(inputs) - used: raise ValueError('dead input')


def validate(spec, manifest):
    schema(spec,manifest['schema'],manifest['schema']['$defs'])
    check_layout(spec,manifest)
    env = {}; bounds = manifest['budgets']; operations = 0
    for i in spec['inputs']:
        if i['id'] in env: raise ValueError('duplicate input')
        v = i['default']
        if i['kind'] in ('number','range','stepper'):
            if type(v) not in (int,float) or not i['min'] <= v <= i['max'] or i['step'] <= 0 or abs((v-i['min'])/i['step']-round((v-i['min'])/i['step'])) > bounds['stepEpsilon']: raise ValueError('input range')
        if i['kind'] == 'select' and v not in [o['value'] for o in i['options']]: raise ValueError('input option')
        if i['kind'] == 'select' and len({o['value'] for o in i['options']}) != len(i['options']): raise ValueError('duplicate option')
        if i['kind'] == 'toggle' and type(v) is not bool: raise ValueError('input boolean')
        if i['kind'] in ('text','date','select') and type(v) is not str: raise ValueError('input text')
        if i['kind'] == 'date':
            try:
                if datetime.date.fromisoformat(v).isoformat() != v: raise ValueError('input date')
            except (ValueError,TypeError): raise ValueError('input date')
        env[i['id']] = v
    if set(spec.get('initial',{})) - set(env): raise ValueError('unknown initial input')
    action_ids = set()
    for action in spec.get('actions',[]):
        if action['id'] in action_ids: raise ValueError('duplicate action')
        action_ids.add(action['id'])
        if action['class'] == 'LOCAL':
            target = next((i for i in spec['inputs'] if i['id'] == action['set']['input']),None)
            if target is None: raise ValueError('action input')
            v = action['set']['value']
            if target['kind'] in ('number','range','stepper') and (type(v) not in (int,float) or not target['min'] <= v <= target['max'] or abs((v-target['min'])/target['step']-round((v-target['min'])/target['step'])) > bounds['stepEpsilon']): raise ValueError('action range')
            if target['kind'] == 'toggle' and type(v) is not bool: raise ValueError('action boolean')
            if target['kind'] == 'select' and v not in [o['value'] for o in target['options']]: raise ValueError('action option')
            if target['kind'] in ('text','date','select') and (type(v) is not str or len(v.encode()) > min(target.get('maxLength',bounds['inputTextBytes']),bounds['inputTextBytes'])): raise ValueError('action text')
            if target['kind'] == 'date':
                try:
                    if datetime.date.fromisoformat(v).isoformat() != v: raise ValueError('action date')
                except (ValueError,TypeError): raise ValueError('action date')
    def resolve(v):
        if isinstance(v,dict):
            if v['ref'] not in env: raise ValueError('forward reference')
            return env[v['ref']]
        return v
    for g in spec['graph']:
        rule = manifest['operations'].get(g['op']); args = [resolve(v) for v in g['args']]
        if not rule or not rule['min'] <= len(args) <= rule['max'] or g['id'] in env: raise ValueError('graph declaration')
        operations += len(args)+1
        if g['op'] not in ('eq','select','dateDiff') and any(type(v) not in (int,float) for v in args): raise ValueError('graph types')
        a = args; op = g['op']
        def same_type(x,y): return type(x) is type(y) or type(x) in (int,float) and type(y) in (int,float)
        if op == 'eq':
            if not same_type(a[0],a[1]): raise ValueError('comparison types')
            value = a[0] == a[1]
        elif op == 'select':
            if type(a[0]) is not bool or not same_type(a[1],a[2]): raise ValueError('selection types')
            value = a[1] if a[0] else a[2]
        elif op == 'dateDiff': value = (datetime.date.fromisoformat(a[0])-datetime.date.fromisoformat(a[1])).days
        else:
            if op == 'clamp' and a[1] > a[2]: raise ValueError('clamp bounds')
            try: value = {'add':lambda:sum(a),'sub':lambda:a[0]-a[1],'mul':lambda:a[0]*a[1],
                'div':lambda:a[0]/a[1],'min':lambda:min(a),'max':lambda:max(a),
                'round':lambda:math.floor(a[0]+.5),'ceil':lambda:math.ceil(a[0]),'floor':lambda:math.floor(a[0]),
                'clamp':lambda:min(a[2],max(a[1],a[0])),'lt':lambda:a[0]<a[1],'gt':lambda:a[0]>a[1]}[op]()
            except (ArithmeticError,KeyError): raise ValueError('invalid calculation')
        if type(value) in (int,float) and (not math.isfinite(value) or abs(value) > bounds['numberMagnitude']): raise ValueError('numeric overflow')
        env[g['id']] = value
    if operations > bounds['operations']: raise ValueError('operation budget')
    def output_refs(value):
        if isinstance(value,dict):
            if set(value) == {'ref'}: resolve(value)
            for v in value.values(): output_refs(v)
        elif isinstance(value,list):
            for v in value: output_refs(v)
    output_refs(spec['outputs'])
    def numeric(v):
        v = resolve(v)
        if type(v) not in (int,float) or not math.isfinite(v): raise ValueError('output number')
        return v
    for output in spec['outputs']:
        if output['kind'] == 'metrics':
            for item in output['items']:
                if item.get('format','text') != 'text': numeric(item['value'])
        if output['kind'] == 'table':
            for row in output['rows']:
                if len(row) != len(output['columns']): raise ValueError('table width')
                for cell,column in zip(row,output['columns']):
                    if column.get('format','text') != 'text': numeric(cell)
        if output['kind'] == 'diagram':
            for shape in output['shapes']:
                for key in ('x','y','x2','y2','width','height','r'):
                    if key in shape and not 0 <= numeric(shape[key]) <= bounds['coordinateMax']: raise ValueError('diagram coordinate')
    if sum(len(row) for o in spec['outputs'] if o['kind']=='table' for row in o['rows']) > bounds['tableCells']: raise ValueError('table cell budget')
    return spec


def node(id,kind,children=None,text='',bind='',gap=3,columns=1):
    return dict(id=id,kind=kind,children=children or [],text=text,bind=str(bind),gap=gap,columns=columns)


def template_layout(spec, manifest):
    """Fixed emitters use the very same primitives; old stored declarations remain valid."""
    template = manifest['components'][spec['component']].get('template')
    if template is None: return spec
    inputs = template['inputs']; outputs = template['outputs']; nodes = []
    kinds = {'range':'Slider','select':'Select','toggle':'Checkbox','date':'DatePicker','text':'Input','number':'Input','stepper':'Input'}
    fields = [node('field-'+i['id'],kinds[i['kind']],bind=i['id']) for i in inputs]
    nodes += [node('root','Col',['heading','reader-source','fields','result','details']),node('heading','Title',text=spec['props']['title']),
              node('reader-source','Caption',text='Calculated locally from your supplied inputs.'),
              node('fields','Form',[n['id'] for n in fields]),*fields,node('result','Output',bind=0),
              node('details','Popover',['detail-'+str(i) for i in range(1,len(outputs))],text='Calculation details')]
    nodes += [node('detail-'+str(i),'Output',bind=i) for i in range(1,len(outputs))]
    for a in spec.get('actions',[]):
        nodes[0]['children'].append('action-'+a['id']); nodes.append(node('action-'+a['id'],'Button',bind=a['id']))
    spec['layout'] = nodes
    expanded = {**spec,**copy.deepcopy(template)}
    check_layout(expanded,manifest)
    return spec


def emit(arguments, manifest, question, clock):
    schema(arguments,definition(manifest)['parameters'],manifest['schema']['$defs'])
    spec = {'type':'widget','component':'application','version':manifest['contractVersion'],
            'id':'composed-'+hashlib.sha256(json.dumps(arguments,sort_keys=True).encode()).hexdigest()[:24],
            'props':{'title':arguments['title'],'currency':arguments['currency']},
            **{k:copy.deepcopy(arguments[k]) for k in ('inputs','graph','outputs','actions','layout','fallback')}}
    # Do not introduce another numerical source path. Charts still require the existing receipt emitter.
    if any(o['kind'] in ('chart','map') for o in spec['outputs']): raise ValueError('use receipt-backed data path')
    # Supplied numeric defaults must actually appear in the request; the model cannot mint prices.
    words = dict(zip('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'.split(),range(21)))
    supplied = {float(v.replace(',','')) for v in re.findall(r'[-+]?\d[\d,]*(?:\.\d+)?',question)}
    supplied.update(v for k,v in words.items() if re.search(r'\b'+k+r'\b',question,re.I))
    factor = 1 if arguments['currency'] == 'UGX' else 100
    for i in spec['inputs']:
        if i['kind'] in ('number','range','stepper'):
            scale = 100 if i.get('display') == 'basisPoints' else factor if i.get('display') == 'money' else 1
            if i['default']/scale not in supplied: raise ValueError('input default was not supplied')
    # Numeric results are graph references or reader literals, not model-invented facts.
    for o in spec['outputs']:
        values = [o['value']] if o['kind'] == 'text' else [m['value'] for m in o['items']] if o['kind'] == 'metrics' else [v for row in o['rows'] for v in row] if o['kind'] == 'table' else []
        if any(type(v) in (int,float) and v not in supplied and v/factor not in supplied for v in values): raise ValueError('numeric output was not supplied or calculated')
    # Text in a layout is another presentation surface, not an escape from receipts. Computed
    # figures belong in reactive Output bindings; arbitrary static numerical claims are refused.
    def supplied_text(text):
        return all(float(v.replace(',','')) in supplied for v in re.findall(r'[-+]?\d[\d,]*(?:\.\d+)?',text))
    def texts(value):
        if isinstance(value,str): return [value]
        if isinstance(value,list): return sum((texts(v) for v in value),[])
        if isinstance(value,dict): return sum((texts(v) for k,v in value.items() if isinstance(v,(dict,list)) or k in ('value','text','label','summary','question','explanation')),[])
        return []
    if any(not supplied_text(n['text']) for n in spec['layout']) or any(not supplied_text(t) for o in spec['outputs'] for t in texts(o)):
        raise ValueError('static numerical claim lacks supplied evidence; use a reactive output')
    if not supplied_text(spec['fallback']):
        spec['fallback'] = 'Interactive answer from your supplied inputs. ' + '; '.join(i['label']+': '+str(i['default']) for i in spec['inputs'])
    if any(i['kind'] in ('number','range','stepper') for i in spec['inputs']):
        index = len(spec['outputs']); key = 'reader-source'
        spec['outputs'].append({'kind':'text','value':'Calculated locally from your supplied inputs; recorded this turn: '+clock().isoformat().replace('+00:00','Z')})
        spec['layout'][0]['children'].append(key); spec['layout'].append(node(key,'Output',bind=index))
    return validate(spec,manifest)
