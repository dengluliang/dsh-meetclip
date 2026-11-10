import React from 'react'
import { createRoot } from 'react-dom/client'
const status={ok:true,version:'0.3.0',backend:{state:'stopped',phase:'stopped',mode:'stopped',port:8321,pid:null,lastError:'',tokenPresent:false},env:{ready:false,exists:false,mlx:false,version:'',venvDir:'/tmp/venv',venvPython:'/tmp/venv/bin/python',python:'/tmp/venv/bin/python',job:null},locations:{dataDir:'/Users/me/Library/Application Support/MeetClip',stateDir:'/tmp/state',port:8321,dataDirWritable:true},prefs:{},config:{backendMode:'auto',autoStart:false,tools:true}}
window.fetch=async u=>{const t=String(u);let b={};if(t.includes('/app/status'))b=status;return{ok:true,status:200,text:async()=>JSON.stringify(b)}}
window.EventSource=class{close(){}}
const plugin=window.__entry.factory(n=>{if(n==='react')return React;throw Error(n)})
const slots={}
plugin.apply({get:()=>undefined,effect:c=>c(),slots:{inject:(_n,c)=>c(),register:(o,C)=>{slots[o.name]=C;return()=>{}}}})
createRoot(document.getElementById('root')).render(React.createElement('div',{style:{height:'100vh',overflow:'hidden'}},React.createElement(slots.main,{t:k=>k})))
