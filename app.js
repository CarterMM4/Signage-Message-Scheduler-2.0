// Signage Message Scheduler — Single-file JS (no imports)
// Works on GitHub Pages with PDF/Image upload, render to canvas, OCR fallback,
// rules-based schedule generation, pins, CSV/XLSX export.

(() => {
  "use strict";

  // ---------- helpers / store ----------
  const $  = (s, r=document)=>r.querySelector(s);
  const $$ = (s, r=document)=>Array.from(r.querySelectorAll(s));
  const storeKey = 'sms-projects-v1';
  const load  = () => { try { return JSON.parse(localStorage.getItem(storeKey)) || [] } catch { return [] } };
  const save  = () => { localStorage.setItem(storeKey, JSON.stringify(projects)); renderProjects(); };
  const uuid  = ()=>'p-'+Math.random().toString(36).slice(2,9);

  let projects = load();
  let currentId = projects[0]?.id || null;
  let ocrIndex = {}; // projectId:pageIndex -> text

  const getProject = () => projects.find(p=>p.id===currentId);
  const pageKey    = () => (getProject()?.id||'')+':'+pageIndex;

  // ---------- UI binds ----------
  $('#btnNew').onclick=()=>{ createProject($('#projectName')?.value?.trim()||'Untitled'); $('#projectName').value=''; };
  $('#btnSave').onclick=save;
  $('#building').onchange=()=>updateProject({building: $('#building').value});
  $('#level').onchange=()=>updateProject({level: $('#level').value});
  $('#btnZoomIn').onclick = ()=>{ zoomBy(1.1) };
  $('#btnZoomOut').onclick= ()=>{ zoomBy(1/1.1) };
  $('#btnToggleGrid').onclick=()=>{ showGrid=!showGrid; draw(); };
  $('#btnScale').onclick=calibrateScale;
  $('#btnClearPins').onclick=()=>{ const p=getProject(); if(!p) return; if(confirm('Clear pins on this page?')){ p.pins=p.pins.filter(x=>x.page!==pageIndex); save(); renderPins(); } };
  $('#btnAddRow').onclick=()=>{ const p=getProject(); if(!p) return; p.schedule.push(blankRow()); save(); renderSchedule(); };
  $('#btnClearSchedule').onclick=()=>{ const p=getProject(); if(!p) return; if(confirm('Clear schedule?')){ p.schedule=[]; save(); renderSchedule(); } };
  $('#btnExportCSV').onclick = ()=> exportCSV(getProject());
  $('#btnExportXLSX').onclick= ()=> exportXLSX(getProject());
  $('#btnExportXLSX2').onclick=()=> exportXLSX(getProject());
  $('#btnGenerate').onclick = generateSchedule;
  $('#btnScanAll').onclick  = scanAllPages;
  $('#btnScanPage').onclick = async ()=>{ await runOCRForPage(pageIndex); alert('OCR complete for this page. Click Generate.'); };

  // Palette presets
  const PRESETS = [
    {key:'1', label:'FOH',            payload:{SignType:'FOH'}},
    {key:'2', label:'BOH',            payload:{SignType:'BOH'}},
    {key:'S', label:'Stair Bundle',   bundle:'STAIR'},
    {key:'L', label:'Elevator Bundle',bundle:'ELEV'},
    {key:'X', label:'Exit',           payload:{SignType:'EXIT'}},
  ];
  const pal = $('#pinPalette');
  PRESETS.forEach(p=>{ const b=document.createElement('button'); b.className='btn'; b.textContent=p.label; b.title=p.key?`${p.label} [${p.key}]`:p.label; b.onclick=()=>activePreset=p; pal.appendChild(b); });
  window.addEventListener('keydown', (e)=>{
    if (['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) return;
    const hit = PRESETS.find(p=>p.key && p.key.toLowerCase()===e.key.toLowerCase());
    if (hit){ activePreset=hit; e.preventDefault(); }
    if (e.key.toLowerCase()==='g'){ showGrid=!showGrid; draw(); }
  });

  // ---------- Projects & Pages ----------
  function createProject(name){
    const id = uuid();
    projects.push({id,name,building:'',level:'',pages:[],pins:[],schedule:[],scale:{}});
    currentId=id; save(); renderAll();
  }
  function updateProject(part){ Object.assign(getProject(), part); save(); }

  function renderProjects(){
    const list=$('#projectList'); list.innerHTML='';
    projects.forEach(p=>{
      const div=document.createElement('div'); div.className='item';
      const left=document.createElement('div'); left.className='inline';
      const name=document.createElement('input'); name.className='input'; name.value=p.name; name.style.width='170px'; name.onchange=()=>{ p.name=name.value; save(); };
      const small=document.createElement('small'); small.textContent=`${p.pages.length} page(s)`;
      left.append(name, small);
      const right=document.createElement('div'); right.className='inline';
      const open=document.createElement('button'); open.className='btn'; open.textContent='Open'; open.onclick=()=>{ currentId=p.id; renderAll(); };
      const del=document.createElement('button'); del.className='btn danger'; del.textContent='Delete'; del.onclick=()=>{ if(confirm('Delete project?')){ projects=projects.filter(x=>x.id!==p.id); if(currentId===p.id) currentId=projects[0]?.id||null; save(); renderAll(); } };
      right.append(open, del); div.append(left,right); list.append(div);
    });
  }

  function renderPages(){
    const list=$('#pageList'); list.innerHTML='';
    const p=getProject(); if(!p){ list.innerHTML='<div class="note">No project selected.</div>'; return; }
    p.pages.forEach((page, idx)=>{
      const row=document.createElement('div'); row.className='item';
      const left=document.createElement('div'); left.textContent=page.name||`Page ${idx+1}`;
      const btn=document.createElement('button'); btn.className='btn'; btn.textContent='View'; btn.onclick=()=>openPage(idx);
      const right=document.createElement('div'); right.append(btn);
      row.append(left,right); list.append(row);
    });
  }

  // ---------- File handling (robust PDF & images) ----------
  const fileInput = $('#fileInput');
  fileInput.addEventListener('change', async (e)=>{
    const files = Array.from(e.target.files||[]);
    const p = getProject(); if(!p){ alert('Create/select a project first.'); return; }

    for (const f of files){
      const name=(f.name||'').toLowerCase();
      const type=(f.type||'').toLowerCase();
      const isPdf = type.includes('pdf') || name.endsWith('.pdf');

      try{
        if (isPdf){
          if (!window.pdfjsLib){ alert('PDF engine not loaded.'); return; }
          let pdf=null;
          try{
            const buf = await f.arrayBuffer();
            pdf = await pdfjsLib.getDocument({ data: buf }).promise;
          }catch{
            const url = URL.createObjectURL(f);
            try{ pdf = await pdfjsLib.getDocument({ url }).promise; } finally { URL.revokeObjectURL(url); }
          }
          for (let i=1;i<=pdf.numPages;i++){
            const page = await pdf.getPage(i);
            // downscale huge canvases to avoid memory errors
            const vp1 = page.getViewport({ scale: 1 });
            const MAX=2200;
            const scale=Math.min(1, MAX/Math.max(vp1.width,vp1.height));
            const vp = page.getViewport({ scale });
            const c=document.createElement('canvas'), cx=c.getContext('2d');
            c.width=Math.ceil(vp.width); c.height=Math.ceil(vp.height);
            await page.render({canvasContext: cx, viewport: vp}).promise;
            const dataUrl = c.toDataURL('image/png');
            let txt=''; try{ const tc=await page.getTextContent(); txt=(tc.items||[]).map(it=>it.str).join('\n'); }catch{}
            p.pages.push({type:'image', name:`${f.name} — p${i}`, dataUrl, w:c.width, h:c.height, _pdfText:txt});
          }
        } else if (type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(name)){
          const dataUrl = await blobToDataURL(f);
          const dims = await imageDims(dataUrl);
          p.pages.push({type:'image', name:f.name, dataUrl, w:dims.w, h:dims.h, _pdfText:''});
        } else {
          alert(`Unsupported file: ${f.name}. Upload PDFs or images.`);
        }
      }catch(err){
        console.error('Add file error:', err);
        alert(`Could not open ${f.name}. Try “Print to PDF” and upload the new file.`);
      }
    }
    save(); renderPages(); if (p.pages.length) openPage(0);
  });

  function blobToDataURL(file){ return new Promise(res=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.readAsDataURL(file); }) }
  function imageDims(src){ return new Promise(res=>{ const img=new Image(); img.onload=()=>res({w:img.naturalWidth,h:img.naturalHeight}); img.src=src; }) }

  // ---------- Viewer (draw/pan/zoom/pins) ----------
  const stage  = $('#stage');
  const canvas = $('#pageCanvas');
  const ctx    = canvas.getContext('2d');

  let pageIndex=0, zoom=1, originX=0, originY=0, dragging=false, lx=0, ly=0;
  let activePreset=null, showGrid=false;

  function openPage(i){ pageIndex=i; $('#pageBadge').textContent = `Page ${i+1} / ${getProject().pages.length}`; zoom=fit(); originX=originY=0; draw(); renderPins(); }
  function fit(){ const p=getProject(); if(!p||!p.pages[pageIndex]) return 1; const pg=p.pages[pageIndex]; const r=stage.getBoundingClientRect(); const z=Math.min(r.width/pg.w, r.height/pg.h)*0.98; $('#zoomBadge').textContent=Math.round(z*100)+'%'; return z; }
  function zoomBy(f){ zoom*=f; $('#zoomBadge').textContent=Math.round(zoom*100)+'%'; draw(); renderPins(); }
  function toScreen(x,y){ return {x:(x*zoom)+originX, y:(y*zoom)+originY} }
  function toWorld(x,y){ return {x:(x-originX)/zoom, y:(y-originY)/zoom} }

  function draw(){
    const p=getProject(); if(!p) return; const pg=p.pages[pageIndex]; if(!pg) return;
    const r=stage.getBoundingClientRect(); canvas.width=r.width; canvas.height=r.height;
    const img=new Image(); img.onload=()=>{ ctx.clearRect(0,0,canvas.width,canvas.height); const s=toScreen(0,0); ctx.drawImage(img, s.x, s.y, pg.w*zoom, pg.h*zoom); if(showGrid) drawGrid(); }; img.src=pg.dataUrl;
  }
  function drawGrid(){ const g=20*zoom; ctx.save(); ctx.strokeStyle='rgba(255,255,255,.07)'; ctx.lineWidth=1; for(let x=((originX%g)+g)%g; x<canvas.width; x+=g){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,canvas.height); ctx.stroke(); } for(let y=((originY%g)+g)%g; y<canvas.height; y+=g){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(canvas.width,y); ctx.stroke(); } ctx.restore(); }

  stage.addEventListener('mousedown', e=>{ dragging=true; lx=e.clientX; ly=e.clientY; stage.classList.add('dragging') });
  window.addEventListener('mouseup', ()=>{ dragging=false; stage.classList.remove('dragging') });
  window.addEventListener('mousemove', e=>{ if(dragging){ originX+=(e.clientX-lx); originY+=(e.clientY-ly); lx=e.clientX; ly=e.clientY; draw(); renderPins(); } });
  stage.addEventListener('click', e=>{
    if(!activePreset) return;
    const rect=stage.getBoundingClientRect(); const world=toWorld(e.clientX-rect.left, e.clientY-rect.top);
    if(showGrid){ const grid=20; world.x=Math.round(world.x/grid)*grid; world.y=Math.round(world.y/grid)*grid; }
    const p=getProject(); p.pins.push({page:pageIndex,x:world.x,y:world.y,preset:activePreset.label,note:''}); save(); renderPins();
  });

  function renderPins(){
    $$('.pin', stage).forEach(el=>el.remove());
    const p=getProject(); if(!p) return; const pins=p.pins.filter(x=>x.page===pageIndex);
    pins.forEach((pin, idx)=>{
      const pos=toScreen(pin.x, pin.y);
      const el=document.createElement('div'); el.className='pin'; el.style.left=pos.x+'px'; el.style.top=pos.y+'px'; el.title=pin.note||`${pin.preset||'Pin'} ${idx+1}`;
      let drag=false, ox=0, oy=0; el.addEventListener('mousedown', e=>{ e.stopPropagation(); drag=true; ox=e.clientX; oy=e.clientY; });
      window.addEventListener('mouseup', ()=>drag=false);
      window.addEventListener('mousemove', e=>{ if(!drag) return; e.preventDefault(); const dx=(e.clientX-ox)/zoom, dy=(e.clientY-oy)/zoom; ox=e.clientX; oy=e.clientY; pin.x+=dx; pin.y+=dy; save(); draw(); renderPins(); });
      el.addEventListener('dblclick',()=>{ const val=prompt('Pin note', pin.note||''); if(val!==null){ pin.note=val; save(); } });
      stage.appendChild(el);
    });
  }

  function calibrateScale(){
    const p=getProject(); if(!p) return; alert('Click once to start the line, once to end, then enter length in feet.');
    let first=null; const onClick=(e)=>{ const r=stage.getBoundingClientRect(); const world=toWorld(e.clientX-r.left, e.clientY-r.top); if(!first) first=world; else{ stage.removeEventListener('click', onClick); const dx=world.x-first.x, dy=world.y-first.y; const px=Math.hypot(dx,dy); const ft=parseFloat(prompt('Enter real length (feet):','10')); if(!isNaN(ft)&&ft>0){ const ppu=px/ft; (p.scale||(p.scale={}))[pageIndex]={ppu}; alert(`Saved scale: ${ppu.toFixed(2)} px/ft`); $('#scaleBadge').textContent=`Scale: ${ppu.toFixed(2)} px/ft`; } } }; stage.addEventListener('click', onClick);
  }

  // ---------- OCR & rules ----------
  async function runOCRForPage(i){
    const p=getProject(); if(!p) return; const pg=p.pages[i]; if(!pg) return;
    const embedded = pg._pdfText || '';
    if (embedded.trim()){ ocrIndex[(p.id+':'+i)] = embedded; return 'pdf'; }
    const res = await Tesseract.recognize(pg.dataUrl, 'eng');
    ocrIndex[(p.id+':'+i)] = res.data.text || '';
    return 'ocr';
  }
  async function scanAllPages(){
    const p=getProject(); if(!p||!p.pages.length){ alert('Upload plan(s) first.'); return; }
    let ok=0; for (let i=0;i<p.pages.length;i++){ await runOCRForPage(i); ok++; $('#pageBadge').textContent=`Scanning ${ok}/${p.pages.length}…`; }
    alert('Scanning complete. Click Generate Schedule.');
  }

  const KEYWORDS = [
    {k:/ELEV(?:ATOR|\.|\b)/i, type:'ELEVATOR'},
    {k:/STAIR/i, type:'STAIR'},
    {k:/WOMEN|LADIES|WOMEN\'S|WOMAN|GIRLS|W\.?C\.?/i, type:'WOMENS_RR'},
    {k:/MEN|MEN\'S|BOYS|MENS|M\.?C\.?/i, type:'MENS_RR'},
    {k:/TOILET|RESTROOM|BATH/i, type:'RESTROOM'},
    {k:/ELECTRICAL/i, type:'ELECTRICAL'},
    {k:/DATA|IT CLOSET|IDF|MDF/i, type:'DATA'},
    {k:/EXIT/i, type:'EXIT'},
    {k:/LOBBY/i, type:'LOBBY'},
    {k:/MECHANICAL|JANITOR|JANITORIAL|CUSTODIAN|CUSTODIAL/i, type:'BOH_MISC'},
  ];
  function deriveRoomNumber(text){ const m=text.match(/\b[AC]?(\d{1,4})(?:[-\. ]?\d{1,3})?\b/); return m?m[0]:''; }
  function blankRow(){ const p=getProject(); return {SignType:'',RoomNumber:'',RoomName:'',Building:p?.building||'',Level:p?.level||'',Notes:''}; }

  function generateSchedule(){
    const p=getProject(); if(!p){ alert('No project selected.'); return; }
    if(!p.pages.length){ alert('No pages uploaded yet.'); return; }
    const text = ocrIndex[pageKey()]||''; if(!text.trim()){ alert('No text for this page. Run Scan first.'); return; }
    const preset = $('#rulePreset')?.value || 'southwood'; const L1=(p.level||'').toString().trim()==='1';
    const start=p.schedule.length;
    const push=(a,b,c,d='')=>p.schedule.push({SignType:a,RoomNumber:b,RoomName:c,Building:p.building||'',Level:p.level||'',Notes:d});
    for (const kw of KEYWORDS){
      if(!kw.k.test(text)) continue;
      switch(kw.type){
        case 'ELEVATOR':
          if(preset==='southwood'){ push('CALLBOX','1-100','ELEV. LOBBY','Auto'); push('EVAC','1-100','ELEV. LOBBY','Auto'); push('HALL DIRECT','C1-100','ELEV. LOBBY','Door to lobby'); }
          else { push('ELEVATOR LOBBY','','ELEVATOR LOBBY','Auto'); }
          break;
        case 'STAIR':      push('INGRESS', deriveRoomNumber(text)||'', 'STAIR','Auto'); push('EGRESS', deriveRoomNumber(text)||'', 'STAIR','Auto'); break;
        case 'WOMENS_RR':  push('FOH', deriveRoomNumber(text)||'', "WOMEN'S RESTROOM",'Auto'); break;
        case 'MENS_RR':    push('FOH', deriveRoomNumber(text)||'', "MEN'S RESTROOM",'Auto'); break;
        case 'RESTROOM':   push('FOH', deriveRoomNumber(text)||'', 'RESTROOM','Auto'); break;
        case 'ELECTRICAL': push('BOH', deriveRoomNumber(text)||'', 'ELECTRICAL','Auto'); break;
        case 'DATA':       push('BOH', deriveRoomNumber(text)||'', 'DATA','Auto'); break;
        case 'EXIT':       if(L1) push('EXIT','','EXIT','Level 1 only'); break;
        case 'BOH_MISC':   push('BOH', deriveRoomNumber(text)||'', 'MECH/JANITORIAL','Auto'); break;
      }
    }
    // dedupe
    const key=r=>[r.SignType,r.RoomNumber,r.RoomName,r.Building,r.Level].join('|'); const m=new Map(); p.schedule.forEach(r=>m.set(key(r),r)); p.schedule=[...m.values()];
    save(); renderSchedule(); validate();
    const added=p.schedule.length-start; alert(added>0?`Added ${added} row(s).`:'No keyword matches found.');
  }

  // ---------- Validation ----------
  function validate(){
    const p=getProject(); if(!p) return; const box=$('#issues'); if(!box) return;
    const issues=[]; const rows=p.schedule; const level=(p.level||'').toString().trim();
    const elevItems=['CALLBOX','EVAC','HALL DIRECT']; const elevRooms=new Map();
    rows.filter(r=>elevItems.includes((r.SignType||'').toUpperCase())).forEach(r=>{ const k=r.RoomName||'ELEV. LOBBY'; const set=elevRooms.get(k)||new Set(); set.add((r.SignType||'').toUpperCase()); elevRooms.set(k,set); });
    elevRooms.forEach((set,room)=>elevItems.forEach(req=>{ if(!set.has(req)) issues.push(`Elevator bundle incomplete in ${room}: missing ${req}`); }));
    const stairMap=new Map();
    rows.filter(r=>['INGRESS','EGRESS'].includes((r.SignType||'').toUpperCase())).forEach(r=>{ const k=r.RoomNumber||'?'; const set=stairMap.get(k)||new Set(); set.add((r.SignType||'').toUpperCase()); stairMap.set(k,set); });
    stairMap.forEach((set,room)=>['INGRESS','EGRESS'].forEach(req=>{ if(!set.has(req)) issues.push(`Stair ${room}: missing ${req}`); }));
    rows.filter(r=>(r.SignType||'').toUpperCase()==='EXIT').forEach(r=>{ if(level!=='1') issues.push('EXIT present but project level is not 1'); });
    rows.filter(r=>['ELECTRICAL','DATA'].includes((r.RoomName||'').toUpperCase())).forEach(r=>{ if((r.SignType||'').toUpperCase()!=='BOH') issues.push(`${r.RoomName}: should be BOH`); });
    box.innerHTML=''; if(!issues.length){ const ok=document.createElement('div'); ok.className='issue ok'; ok.textContent='All good!'; box.append(ok); return; }
    issues.forEach(i=>{ const div=document.createElement('div'); div.className='issue'; div.textContent=i; box.append(div); });
  }

  // ---------- Schedule table & export ----------
  function renderSchedule(){
    const p=getProject(); if(!p) return; const body=$('#scheduleBody'); body.innerHTML='';
    p.schedule.forEach((row, idx)=>{
      const tr=document.createElement('tr'); const fields=['SignType','RoomNumber','RoomName','Building','Level','Notes'];
      fields.forEach(f=>{ const td=document.createElement('td'); const input=document.createElement('input'); input.className='input'; input.value=row[f]||''; input.onchange=()=>{ row[f]=input.value; save(); validate(); }; td.append(input); tr.append(td); });
      const tdDel=document.createElement('td'); const btn=document.createElement('button'); btn.className='btn danger'; btn.textContent='✕'; btn.onclick=()=>{ p.schedule.splice(idx,1); save(); renderSchedule(); validate(); }; tdDel.append(btn); tr.append(tdDel);
      body.append(tr);
    });
    $('#rowCount').textContent=`${p.schedule.length} rows`;
  }
  function exportCSV(project){ if(!project) return; const headers=['Sign Type','Room Number','Room Name','Building','Level','Notes']; const rows=project.schedule.map(r=>[r.SignType,r.RoomNumber,r.RoomName,r.Building,r.Level,r.Notes]); const csv=[headers,...rows].map(a=>a.map(v=>`"${(v||'').toString().replace(/"/g,'""')}"`).join(',')).join('\n'); const blob=new Blob([csv],{type:'text/csv'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=(project.name||'schedule')+'.csv'; a.click(); URL.revokeObjectURL(url); }
  function exportXLSX(project){ if(!project) return; const ws_data=[['Sign Type','Room Number','Room Name','Building','Level','Notes'], ...project.schedule.map(r=>[r.SignType,r.RoomNumber,r.RoomName,r.Building,r.Level,r.Notes])]; const wb=XLSX.utils.book_new(); const ws=XLSX.utils.aoa_to_sheet(ws_data); XLSX.utils.book_append_sheet(wb,ws,'Schedule'); const out=XLSX.write(wb,{bookType:'xlsx',type:'array'}); const blob=new Blob([out],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=(getProject().name||'schedule')+'.xlsx'; a.click(); URL.revokeObjectURL(url); }
  $('#btnExportCSV').onclick=()=>exportCSV(getProject());
  $('#btnExportXLSX').onclick=()=>exportXLSX(getProject());

  // ---------- Boot ----------
  function renderSettings(){ const p=getProject(); if(!p){ $('#building').value=''; $('#level').value=''; return } $('#building').value=p.building||''; $('#level').value=p.level||''; }
  function renderAll(){ renderProjects(); renderPages(); renderSettings(); if(getProject()?.pages.length){ openPage(0); } renderSchedule(); validate(); }
  if(!getProject()) createProject('New Project'); else renderAll();

})();

