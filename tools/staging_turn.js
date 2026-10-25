'use strict';
// Never let undefined === undefined identify a turn, and never cancel the latest turn.
function cancellationPayload(opened,request){
  if(!opened||!request||request.mode!=='text'||!/^[a-f0-9]{32}$/i.test(request.conv||'')||opened.conv!==request.conv)return null;
  if(typeof opened.tid!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(opened.tid))return null;
  if(request.tid&&request.tid!==opened.tid)return null;
  return {tid:opened.tid}; // /cancel resolves a tid directly; a numeric turn is optional.
}
module.exports={cancellationPayload};
