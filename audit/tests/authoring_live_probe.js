/* Console-only native-page observer. Never creates DOM/IDs, submits a turn, changes an input,
 * writes a checkpoint, mints a gesture, or fabricates a message. Not loaded by the app.
 * Run it, submit the plain-language quote prompt in authoring10.json, then change quantity to 7.
 */
(function () {
  'use strict';
  var broker=window.JarvisResponses, record=null, observed=null, initial=null, finished=false;
  if (!broker) throw Error('Response broker unavailable.');
  function visible(frame) {
    var b=frame.getBoundingClientRect(),s=getComputedStyle(frame);
    return frame.isConnected&&!frame.hidden&&s.display!=='none'&&s.visibility!=='hidden'&&b.width>0&&b.height>0&&b.bottom>0&&b.right>0&&b.top<innerHeight&&b.left<innerWidth;
  }
  function owned(r) {
    var turn=r.node.closest('.turn'),thread=document.getElementById('thread'),question=turn&&turn.querySelector('.t-q');
    return turn&&turn.dataset.id&&thread&&thread.contains(turn)&&question&&question.textContent&&!/[{]|```/.test(question.textContent)&&
      window.__jarvisConvId&&String(window.__jarvisConvId())===r.conv;
  }
  var timer,timeout;
  window.jarvisAuthoringProof=new Promise(function (resolve,reject) {
    function done(error,result) {
      if(finished)return;finished=true;clearInterval(timer);clearTimeout(timeout);window.removeEventListener('message',message);
      if(error){console.warn('Authoring live proof INCOMPLETE',error.message);reject(error);}
      else{console.info('Authoring live proof PASS',result);resolve(result);}
    }
    function message(event) {
      if(!record||event.source!==record.frame.contentWindow||event.origin!=='null'||!broker.core.message(event.data)||event.data.nonce!==record.nonce)return;
      if(event.data.type==='change')observed={revision:event.data.revision,inputs:event.data.inputs};
    }
    function tick() {
      if(!record){
        record=Array.from(broker.records).find(function(r){return !r.dead&&r.ready&&r.result.spec.component==='quote-estimator'&&/^authored-/.test(r.result.spec.id)&&owned(r)&&visible(r.frame)&&r.values.quantity===6&&r.values.price===10000&&r.values.discount===7166;});
        if(record){initial=broker.core.evaluate(record.result.spec,record.values).total;if(initial!==17004)return done(Error('Initial quote is not 17004.'));console.info('Authored quote is visible. Change quantity to 7 using the real frame control.');}
        return;
      }
      if(record.dead||!record.ready||!owned(record)||!visible(record.frame))return done(Error('Quote was disposed or the conversation changed.'));
      if(!observed||record.acked<observed.revision||record.values.quantity!==7||record.values.price!==10000||record.values.discount!==7166)return;
      var opaque=false;try{void record.frame.contentWindow.document;}catch(e){opaque=e.name==='SecurityError';}
      if(!opaque||record.frame.getAttribute('sandbox')!=='allow-scripts')return done(Error('Opaque sandbox was not observed.'));
      var total=broker.core.evaluate(record.result.spec,record.values).total;if(total!==19838)return done(Error('Changed quote is not 19838.'));
      done(null,{nativeVisibleMount:true,questionContainsNoJSON:true,serverAuthoredId:record.result.spec.id,opaqueOrigin:true,realFrameChangeAcknowledged:true,initialTotal:initial,changedTotal:total});
    }
    window.addEventListener('message',message);timer=setInterval(tick,100);timeout=setTimeout(function(){done(Error('Native quote proof did not complete.'));},120000);tick();
  });
  window.jarvisAuthoringProof.catch(function(){});
})();
