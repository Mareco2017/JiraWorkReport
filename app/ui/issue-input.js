const controls=new WeakMap();

/** All work-order pickers clear through their normal input handler, keeping the selected issue and dependent task in sync. */
export function attachIssueClear(input) {
 const existing=controls.get(input);if(existing)return existing;
 const wrapper=document.createElement('div');wrapper.className='issue-input-wrap';
 input.before(wrapper);wrapper.append(input);
 const button=document.createElement('button');button.type='button';button.className='issue-input-clear';button.setAttribute('aria-label','清空工单');
 button.innerHTML='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 5 6 6m0-6-6 6"/></svg>';
 const refresh=()=>{button.hidden=!input.value||input.readOnly||input.disabled;};
 button.onclick=()=>{input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();refresh();};
 wrapper.append(button);input.addEventListener('input',refresh);controls.set(input,refresh);refresh();return refresh;
}

/** Programmatic selection changes a value without emitting input, because input would discard the selection again. */
export function refreshIssueClear(input) {controls.get(input)?.();}
