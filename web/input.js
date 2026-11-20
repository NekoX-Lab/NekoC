// Shared by the editor, standalone player and packaged extension. Events retain quick down/up pairs.
export class StageInput {
  constructor(canvas,renderer,active,onOverflow=message=>console.warn(message)){
    this.canvas=canvas;this.renderer=renderer;this.active=active;this.pressed=new Set();this.events=[];this.mouse={x:0,y:0};this.pointer=null;
    this.onOverflow=onOverflow;this.queueStats={coalesced:0,rejected:0,highWater:0};this.overflowNotified=false;
    this.keySources=new Map();this.releaseListeners=new Set();
    canvas.addEventListener('keydown',event=>{
      if(!active()||event.ctrlKey||event.metaKey||event.altKey||event.key==='Tab')return;
      const key=this.key(event.keyCode);if(key===null)return;
      if(!this.setKey(event.keyCode,true,`keyboard:${event.code||event.keyCode}`))return;
      event.preventDefault();
    });
    window.addEventListener('keyup',event=>this.setKey(event.keyCode,false,`keyboard:${event.code||event.keyCode}`));
    canvas.addEventListener('blur',()=>this.release());window.addEventListener('blur',()=>this.release());
    canvas.addEventListener('pointermove',event=>{
      if(this.pointer?this.pointer.id!==event.pointerId:!event.isPrimary)return;
      this.position(event);
      // Dragging a draggable sprite moves it in the VM.
      const p=this.pointer;
      if(p?.drag&&p.id===event.pointerId){
        let x=this.mouse.x-p.offset.x,y=this.mouse.y-p.offset.y;
        if(renderer.kitten4){
          // K4 ignores out-of-stage drag moves without advancing old_pos.
          // The exact edges remain valid, unlike the click hit rectangle.
          if(this.mouse.x<-renderer.width/2||this.mouse.x>renderer.width/2||this.mouse.y<-renderer.height/2||this.mouse.y>renderer.height/2)return;
          // Official K4 dragging adds each pointer delta to the sprite's
          // current position, including movement performed by its scripts.
          const sprite=renderer.sprites.find(a=>a.id===p.drag.id)||p.drag;
          const unchanged=sprite===p.drag&&sprite.x===p.rendered.x&&sprite.y===p.rendered.y;
          const base=unchanged?p.position:sprite;
          x=base.x+this.mouse.x-p.last.x;y=base.y+this.mouse.y-p.last.y;
          p.drag=sprite;p.rendered={x:sprite.x,y:sprite.y};p.position={x,y};p.last={...this.mouse};
        }
        this.push({kind:'drag',target:p.drag.id,x,y});
      }
    });
    canvas.addEventListener('pointerdown',event=>{
      // A secondary pointer does not take over the gesture, but Hammer's
      // maxPointers check disqualifies the entire gesture from a swipe.
      if(this.pointer&&this.pointer.id!==event.pointerId)this.pointer.maxPointers=2;
      // A virtual-button finger may already own the browser's primary touch.
      const secondaryTouch=event.pointerType==='touch'&&this.acceptSecondaryTouch?.();
      if(!active()||event.button!==0||(!event.isPrimary&&!secondaryTouch)||this.pointer)return;
      // Reserve the final drag, up to two swipes, old-target clear/up and click.
      if(!this.room(7)){this.reject('pointer down');return;}
      canvas.focus({preventScroll:true});this.position(event);
      const target=renderer.hitTest(this.mouse.x,this.mouse.y),sprite=target&&renderer.sprites.find(a=>a.id===target);
      this.pointer={id:event.pointerId,target,start:{...this.mouse,time:performance.now()},client:{x:event.clientX,y:event.clientY},maxPointers:1,
        drag:sprite?.draggable?sprite:null,offset:sprite?{x:this.mouse.x-sprite.x,y:this.mouse.y-sprite.y}:null,
        position:sprite?{x:sprite.x,y:sprite.y}:null,rendered:sprite?{x:sprite.x,y:sprite.y}:null,last:{...this.mouse}};
      canvas.setPointerCapture(event.pointerId);this.pointerEvent('mouse_down',this.pointer.target);event.preventDefault();
    });
    canvas.addEventListener('pointerup',event=>{
      if(this.pointer?.id!==event.pointerId)return;
      this.position(event);const target=renderer.hitTest(this.mouse.x,this.mouse.y),p=this.pointer,down=p.target,start=p.start;this.pointer=null;
      const elapsed=performance.now()-start.time;
      // Both runtimes first use Hammer 2's CSS-pixel distance and overall
      // velocity gate. Signed equal deltas have offset direction NONE.
      const dx=event.clientX-p.client.x,dy=event.clientY-p.client.y;
      if(p.maxPointers===1&&dx!==dy&&Math.hypot(dx,dy)>10&&Math.max(Math.abs(dx),Math.abs(dy))/elapsed>.3){
        if(renderer.kitten4){
          this.push({kind:'swipe',direction:Math.abs(dx)>=Math.abs(dy)?(dx>0?'right':'left'):(dy>0?'down':'up')});
        }else{
          // KN's second gate uses independent signed comparisons, not an
          // absolute dominant axis. Opposite diagonals can emit two actions.
          if(dy<-50&&dy<dx)this.push({kind:'swipe',direction:'up'});
          if(dx<-50&&dx<dy)this.push({kind:'swipe',direction:'left'});
          if(dx>50&&dx>dy)this.push({kind:'swipe',direction:'right'});
          if(dy>50&&dy>dx)this.push({kind:'swipe',direction:'down'});
        }
      }
      const box=canvas.getBoundingClientRect();
      const inside=event.clientX>=box.left&&event.clientX<box.right&&event.clientY>=box.top&&event.clientY<box.bottom;
      if(renderer.kitten4){
        if(target!==down)this.pointerEvent('',down);
        this.pointerEvent(inside?'mouse_up':'',target);
      }else{
        if(target!==down)this.pointerEvent('',down);
        this.pointerEvent(inside?'mouse_up':'',target);
      }
      if(inside&&elapsed<1000&&target===down)this.pointerEvent('mouse_click',target);
      if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointercancel',event=>{
      // KN cancel remains a compatibility release; its official runtime
      // state handling has not been verified (docs/input-kn.md, section 3).
      if(this.pointer?.id===event.pointerId){if(renderer.kitten4)this.releasePointer();else this.release();}
    });
    canvas.addEventListener('lostpointercapture',event=>{if(this.pointer?.id===event.pointerId)this.releasePointer();});
  }
  key(code){if(code>=96&&code<=105)code-=48;return code===13||code===32||code>=37&&code<=40||code>=48&&code<=57||code>=65&&code<=90?String(code):null;}
  // Physical keys and each virtual pointer own independent holds. A release
  // from one source must not lift another source's key (including numpad).
  setKey(code,down,source){
    const key=this.key(code);if(key===null)return false;
    let sources=this.keySources.get(key);
    if(down){
      if(!this.active())return false;
      if(sources?.has(source))return true;
      if(!this.pressed.has(key)){
        // Admit the pair atomically: a down must leave room for its up.
        if(!this.room(3))return this.reject('key down');
        this.pressed.add(key);this.push({kind:'key',key,down:true});
      }
      if(!sources){sources=new Set();this.keySources.set(key,sources);}
      sources.add(source);
    }else if(sources?.delete(source)&&!sources.size){
      this.keySources.delete(key);this.pressed.delete(key);this.push({kind:'key',key,down:false});
    }
    return true;
  }
  // Only adjacent absolute drag positions may be replaced. Every other event
  // is a barrier, including a down/up, target change, answer or scene action.
  // K4 has already accumulated pointer deltas before reaching this queue.
  // A held key also reserves a drag barrier slot: key-up may interrupt a
  // saturated gesture, whose next move must still retain its final position.
  room(extra,drag=false){return this.events.length+extra+this.pressed.size*2+(this.pointer?(drag?5:6):0)<=256;}
  recordQueue(){this.queueStats.highWater=Math.max(this.queueStats.highWater,this.events.length);}
  reject(kind){
    this.queueStats.rejected++;
    if(!this.overflowNotified){this.overflowNotified=true;this.onOverflow(`输入队列已满，未接受 ${kind}；请等待下一帧后重试。`);}
    return false;
  }
  push(event){
    const last=this.events.at(-1);
    if(event.kind==='drag'&&last?.kind==='drag'&&last.target===event.target){
      this.events[this.events.length-1]=event;
      this.queueStats.coalesced++;return true;
    }
    const drag=event.kind==='drag'&&this.pointer?.drag?.id===event.target;
    if(!this.room(1,drag))return this.reject(event.kind);
    this.events.push(event);this.recordQueue();return true;
  }
  position(event){const box=this.canvas.getBoundingClientRect();if(box.width&&box.height)this.mouse={x:(event.clientX-box.left)/box.width*this.renderer.width-this.renderer.width/2,y:this.renderer.height/2-(event.clientY-box.top)/box.height*this.renderer.height};}
  pointerEvent(state,target){this.push({kind:'pointer',state,target:target||'',...this.mouse});}
  releasePointer(){const p=this.pointer;if(!p)return;this.pointer=null;this.pointerEvent(this.renderer.kitten4?'':'mouse_up',p.target);if(this.canvas.hasPointerCapture(p.id))this.canvas.releasePointerCapture(p.id);}
  release(){this.keySources.clear();for(const key of this.pressed){this.pressed.delete(key);this.push({kind:'key',key,down:false});}this.releasePointer();for(const listener of this.releaseListeners)listener();}
  reset(){this.events=[];this.release();this.events=[];this.overflowNotified=false;}
  take(){this.overflowNotified=false;return {events:this.events.splice(0),pressed:[...this.pressed],mouse:{...this.mouse}};}
}

// Optional player UI. Feed the same bounded queue as hardware keys; never
// synthesize DOM keyboard events or couple multi-touch to isPrimary.
export class VirtualControls {
  constructor(input,root,toggle,onVisibility=()=>{}){
    this.input=input;this.root=root;this.toggle=toggle;this.holds=new Map();
    input.acceptSecondaryTouch=()=>[...this.holds.keys()].some(source=>source.startsWith('pointer:'));
    // A touch click can be retargeted beneath a hidden/relaid-out button.
    // Consume the click even after releasing capture or hiding the panel.
    const pointerClicks=new Set();
    window.addEventListener('pointerdown',event=>pointerClicks.delete(event.pointerId),true);
    window.addEventListener('click',event=>{
      if(pointerClicks.delete(event.pointerId)){event.preventDefault();event.stopImmediatePropagation();}
    },true);
    const buttonFor=event=>event.target.closest('button[data-key]');
    root.addEventListener('pointerdown',event=>{
      const button=buttonFor(event);if(!button||event.button!==0)return;
      event.preventDefault();
      pointerClicks.add(event.pointerId);
      // Cancelled pointers may never produce click. Bound bookkeeping even
      // across long sessions; current browser gestures use far fewer fingers.
      if(pointerClicks.size>32)pointerClicks.delete(pointerClicks.values().next().value);
      if(this.press(`pointer:${event.pointerId}`,button)){
        button.setPointerCapture(event.pointerId);
      }
    });
    for(const type of ['pointerup','pointercancel','lostpointercapture'])root.addEventListener(type,event=>this.lift(`pointer:${event.pointerId}`));
    root.addEventListener('contextmenu',event=>event.preventDefault());
    root.addEventListener('keydown',event=>{
      const button=buttonFor(event);if(!button||!['Enter',' '].includes(event.key)||event.ctrlKey||event.metaKey||event.altKey)return;
      event.preventDefault();this.press(`button:${event.code||event.key}`,button);
    });
    root.addEventListener('keyup',event=>{
      if(['Enter',' '].includes(event.key)){event.preventDefault();this.lift(`button:${event.code||event.key}`);}
    });
    root.addEventListener('focusout',()=>this.release());
    // Assistive technology can activate a button without a pointer/key pair.
    root.addEventListener('click',event=>{
      const button=buttonFor(event);if(button&&event.detail===0){this.press('activation',button);this.lift('activation');}
    });
    input.releaseListeners.add(()=>this.release());
    toggle.addEventListener('click',()=>{this.setVisible(root.hidden);});
    this.onVisibility=onVisibility;this.setVisible(false);
  }
  press(source,button){
    if(this.root.hidden)return false;
    if(this.holds.has(source))return true;
    const code=Number(button.dataset.key);
    if(!this.input.setKey(code,true,`virtual:${source}`))return false;
    this.holds.set(source,{button,code});button.setAttribute('aria-pressed','true');return true;
  }
  lift(source){
    const hold=this.holds.get(source);if(!hold)return;
    this.holds.delete(source);this.input.setKey(hold.code,false,`virtual:${source}`);
    hold.button.setAttribute('aria-pressed',String([...this.holds.values()].some(other=>other.button===hold.button)));
    if(source.startsWith('pointer:')){const id=Number(source.slice(8));if(hold.button.hasPointerCapture(id))hold.button.releasePointerCapture(id);}
  }
  release(){for(const source of [...this.holds.keys()])this.lift(source);}
  setVisible(visible){
    if(!visible)this.release();
    this.root.hidden=!visible;this.toggle.setAttribute('aria-expanded',String(visible));
    this.toggle.textContent=visible?'隐藏虚拟按键':'显示虚拟按键';this.onVisibility(visible);
  }
}
