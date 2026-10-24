import React, {useState, useEffect} from 'react';
import {createLibrary, defineComponent, defineFunction} from '@openuidev/react-lang';
import {z} from 'zod/v4';
import {Col, Row, Box, Grid, Card, Divider, Spacer, Form} from './reference/components/layout';
import {Title, Text, Caption, Label, Badge, Link, List, ListItem, Markdown} from './reference/components/text';
import {Input, TextArea, Select, SegmentedControl, Slider, Checkbox, RadioGroup, DatePicker, Button, IconButton, Pressable, Timer} from './reference/components/controls';
import {Carousel, Popover, Quote, Code, MathBlock, Flashcard, Celebration} from './reference/components/extra';
import {Table} from './reference/components/table';
import {Chart} from './reference/components/chart';
import {svgComponents} from './reference/components/svg';
import {functions} from './reference/functions';
import {actions} from './reference/actions';
import {Glyph} from './reference/components/glyph';

export type Receipt = {id:string; rows:Record<string,string|number>[]; credit:string};
let receipts:Receipt[]=[];
export function setReceipts(value:Receipt[]){receipts=value;}
const ReceiptData=defineFunction({name:'Receipt', description:'Verified rows from a server receipt. Use these rows for Chart. Never invent a receipt id.',
  params:z.object({id:z.string()}), returns:z.array(z.record(z.string(),z.union([z.string(),z.number()]))),
  fn:({id})=>receipts.find(r=>r.id===id)?.rows??[]});

export type Photo = {url:string; title:string; page:string; author:string; license:string; licenseUrl:string; retrieved:string};
let lookup:(query:string)=>Promise<Photo[]>=async()=>[];
export function setPhotoLookup(value:typeof lookup){lookup=value;}
let photoFailure=()=>{};
export function setPhotoFailure(value:()=>void){photoFailure=value;}
const imageCache=new Map<string,Promise<Photo[]>>();
function PhotoView({query,src,ratio=1.5,fit='cover'}:{query:string;src?:string;ratio?:number;fit?:string}){
  const [photos,setPhotos]=useState<Photo[]|null>(null),[index,setIndex]=useState(0),[loaded,setLoaded]=useState('');
  useEffect(()=>{let active=true;setPhotos(null);setIndex(0);
    const timer=setTimeout(()=>{let pending=imageCache.get(query);if(!pending){pending=lookup(query);imageCache.set(query,pending);if(imageCache.size>128)imageCache.delete(imageCache.keys().next().value!);}
      pending.then(result=>{if(!result.length)imageCache.delete(query);if(active)setPhotos(result);}).catch(()=>{imageCache.delete(query);if(active)setPhotos([]);});},350);
    return()=>{active=false;clearTimeout(timer);};},[query]);
  // Model URLs are never fetched. The server resolves the subject and returns credited Wikimedia photos.
  const photo=photos?.[index];
  useEffect(()=>{if(photos!==null&&!photo)photoFailure();},[photos,index]);
  return <figure className="jl-photo"><div className={'iui-image'+(photo&&loaded===photo.url?' is-loaded':'')} style={{aspectRatio:Math.min(4,Math.max(.4,ratio)),borderRadius:12}}>
    {photo?<img src={photo.url} alt={query} referrerPolicy="no-referrer" style={{width:'100%',height:'100%',objectFit:fit==='contain'?'contain':'cover'}} onLoad={()=>setLoaded(photo.url)} onError={()=>setIndex(i=>i+1)}/>:
      <span className="jl-photo-status">{photos===null?'Finding photograph…':'Photograph unavailable: '+query}</span>}
    </div>{photo&&<figcaption><a href={photo.page} target="_blank" rel="noreferrer">{photo.title}</a> · {photo.author} · <a href={photo.licenseUrl} target="_blank" rel="noreferrer">{photo.license}</a> · retrieved {photo.retrieved}</figcaption>}</figure>;
}
const SearchImage=defineComponent({name:'SearchImage',props:z.object({query:z.string(),aspectRatio:z.number().optional(),radius:z.union([z.string(),z.number()]).optional(),fit:z.enum(['cover','contain']).optional()}),
  description:'A real, credited photograph of the exact subject, found by the app. Use for places, buildings, products, dishes. No URL needed.',component:({props})=><PhotoView query={props.query} ratio={props.aspectRatio} fit={props.fit}/>});
const Image=defineComponent({name:'Image',props:z.object({src:z.string(),alt:z.string(),aspectRatio:z.number().optional(),radius:z.union([z.string(),z.number()]).optional(),fit:z.enum(['cover','contain']).optional()}),
  description:'A credited photograph; alt identifies its exact subject. The app resolves it through Wikimedia rather than fetching an unverified URL.',component:({props})=><PhotoView query={props.alt} ratio={props.aspectRatio} fit={props.fit}/>});
const Icon=defineComponent({name:'Icon',props:z.object({name:z.string(),size:z.enum(['sm','md','lg','xl']).optional(),color:z.string().optional()}),component:({props})=><Glyph name={props.name} size={props.size==='lg'?24:18}/>});
const Accordion=defineComponent({name:'Accordion',props:z.object({title:z.string(),children:z.array(z.any())}),description:'Details that expand when its heading is tapped.',
  component:({props,renderNode})=><details className="jl-accordion"><summary>{props.title}</summary><div className="jl-accordion-content">{renderNode(props.children)}</div></details>});
export const library=createLibrary({root:'Col',components:[Col,Row,Box,Grid,Card,Carousel,Popover,Accordion,Divider,Spacer,Form,
  Title,Text,Caption,Label,Badge,Link,List,ListItem,Markdown,Quote,Code,MathBlock,
  Input,TextArea,Select,SegmentedControl,Slider,Checkbox,RadioGroup,DatePicker,Button,IconButton,Pressable,Timer,
  SearchImage,Image,Icon,Table,Chart,Flashcard,Celebration,...svgComponents],functions:[...functions,ReceiptData],actions});
